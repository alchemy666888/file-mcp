import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { cookies } from "next/headers";
import { z } from "zod";
import { config } from "./config";
import { db, transaction } from "./db";
import { equal, hash, sign } from "./crypto";
import { AppError } from "./errors";
import { boundedBody } from "./body";
import { toolCatalog } from "./tools";
import type { Grant } from "./policy";

export const resourceUrl = () => `${config().APP_URL}/api/mcp`;
export const oauthHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
};
export function protectedMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [config().APP_URL],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    resource_name: "File MCP",
  };
}
export function authorizationMetadata() {
  const origin = config().APP_URL;
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    revocation_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: ["mcp:read", "mcp:write"],
  };
}
export class OAuthError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function oauthError(error: unknown) {
  const known = error instanceof OAuthError;
  return Response.json(
    { error: known ? error.code : "server_error" },
    {
      status: known
        ? error.status
        : error instanceof AppError
          ? error.status
          : 500,
      headers: {
        ...oauthHeaders,
        ...(known && error.code === "invalid_client"
          ? { "www-authenticate": 'Basic realm="File MCP OAuth"' }
          : {}),
      },
    },
  );
}
export function uniqueParams(params: URLSearchParams) {
  for (const key of new Set(params.keys()))
    if (params.getAll(key).length !== 1)
      throw new OAuthError("invalid_request");
  return params;
}
export async function formParams(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new OAuthError("invalid_request");
  return uniqueParams(
    new URLSearchParams(
      new TextDecoder().decode(await boundedBody(request, 8192)),
    ),
  );
}
export const redirectUri = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.hash &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }, "Use an HTTPS callback URL, or HTTP loopback for a local client");
export const registration = z.object({
  name: z.string().min(1).max(100),
  parentId: z.uuid(),
  redirectUris: z.array(redirectUri).min(1).max(10),
  authMethod: z.enum(["none", "client_secret_basic", "client_secret_post"]),
});
export type OAuthClient = {
  id: string;
  name: string;
  parent_id: string;
  redirect_uris: string[];
  auth_method: string;
  secret_hash: string | null;
  can_write: boolean;
};
async function findClient(
  id: string,
  connection: Pick<PoolClient, "query"> = db(),
) {
  const result = await connection.query<OAuthClient>(
    "SELECT o.*,c.can_write FROM mcp_oauth_clients o JOIN mcp_clients c ON c.id=o.parent_id WHERE o.id=$1 AND NOT o.revoked AND NOT c.revoked",
    [id],
  );
  return result.rows[0];
}
export async function registerClient(input: z.infer<typeof registration>) {
  if (
    !(
      await db().query(
        "SELECT id FROM mcp_clients WHERE id=$1 AND NOT revoked",
        [input.parentId],
      )
    ).rowCount
  )
    throw new AppError("CLIENT_NOT_FOUND", 404);
  const id = randomBytes(24).toString("base64url");
  const secret =
    input.authMethod === "none" ? null : randomBytes(32).toString("base64url");
  await db().query(
    "INSERT INTO mcp_oauth_clients(id,name,parent_id,redirect_uris,auth_method,secret_hash) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id,
      input.name,
      input.parentId,
      input.redirectUris,
      input.authMethod,
      secret ? hash(secret) : null,
    ],
  );
  return { clientId: id, clientSecret: secret, authMethod: input.authMethod };
}
export async function rateLimit(request: Request, endpoint: string) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const result = await db().query(
    "INSERT INTO mcp_oauth_limits(key,attempts,started_at) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN mcp_oauth_limits.started_at<now()-interval '10 minutes' THEN 1 ELSE mcp_oauth_limits.attempts+1 END,started_at=CASE WHEN mcp_oauth_limits.started_at<now()-interval '10 minutes' THEN now() ELSE mcp_oauth_limits.started_at END RETURNING attempts",
    [hash(`${endpoint}:${ip}`)],
  );
  if (result.rows[0].attempts > 120)
    throw new OAuthError("temporarily_unavailable", 429);
}
export const requestCookie = (id: string) =>
  `${process.env.NODE_ENV === "production" || process.env.VERCEL ? "__Host-" : ""}file-mcp-oauth-${id}`;
export async function startAuthorization(request: Request) {
  const params = uniqueParams(new URL(request.url).searchParams);
  if (params.get("response_type") !== "code")
    throw new OAuthError("unsupported_response_type");
  const client = await findClient(params.get("client_id") ?? "");
  const redirect = params.get("redirect_uri") ?? "";
  if (!client || !client.redirect_uris.includes(redirect))
    throw new OAuthError("invalid_request");
  const challenge = params.get("code_challenge") ?? "";
  if (
    params.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9_-]{43}$/.test(challenge)
  )
    throw new OAuthError("invalid_request");
  if (params.get("resource") !== resourceUrl())
    throw new OAuthError("invalid_target");
  const scope = params.get("scope") ?? "mcp:read";
  const scopes = scope.split(" ");
  if (
    !scopes.includes("mcp:read") ||
    scopes.some((value) => !["mcp:read", "mcp:write"].includes(value)) ||
    (scopes.includes("mcp:write") && !client.can_write)
  )
    throw new OAuthError("invalid_scope");
  const state = params.get("state");
  if (state && state.length > 2048) throw new OAuthError("invalid_request");
  const id = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  await db().query("DELETE FROM mcp_oauth_requests WHERE expires_at<now()");
  await db().query(
    "INSERT INTO mcp_oauth_requests(id,client_id,redirect_uri,challenge,scope,resource,state,browser_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '10 minutes')",
    [
      id,
      client.id,
      redirect,
      challenge,
      [...new Set(scopes)].sort().join(" "),
      resourceUrl(),
      state,
      hash(browser),
    ],
  );
  return { id, browser };
}
export type AuthorizationRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  challenge: string;
  scope: string;
  resource: string;
  state: string | null;
  browser_hash: string;
};
export async function pendingRequest(
  id: string,
  connection: Pick<PoolClient, "query"> = db(),
  lock = false,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new OAuthError("invalid_request");
  const result = await connection.query<AuthorizationRequest>(
    `SELECT * FROM mcp_oauth_requests WHERE id=$1 AND expires_at>now()${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  const value = result.rows[0];
  const browser = (await cookies()).get(requestCookie(id))?.value;
  if (!value || !browser || !equal(value.browser_hash, hash(browser)))
    throw new OAuthError("invalid_request");
  return value;
}
export async function consentDetails(id: string) {
  const pending = await pendingRequest(id);
  const client = await findClient(pending.client_id);
  if (!client) throw new OAuthError("invalid_request");
  const roots = (
    await db().query<Grant>(
      "SELECT folder_id,name,can_write FROM root_grants WHERE client_id=$1 ORDER BY name,folder_id",
      [client.parent_id],
    )
  ).rows;
  return {
    pending,
    client,
    roots,
    consentDigest: sign(
      JSON.stringify({
        id,
        scope: pending.scope,
        roots,
        canWrite: client.can_write,
      }),
    ),
  };
}
export async function approveAuthorization(
  id: string,
  approve: boolean,
  consentDigest: string,
) {
  return transaction(async (connection) => {
    const pending = await pendingRequest(id, connection, true);
    const client = await findClient(pending.client_id, connection);
    if (!client) throw new OAuthError("invalid_request");
    const callback = new URL(pending.redirect_uri);
    if (pending.state !== null)
      callback.searchParams.set("state", pending.state);
    if (approve) {
      const write = pending.scope.split(" ").includes("mcp:write");
      if (write && !client.can_write) throw new OAuthError("invalid_scope");
      const currentRoots = (
        await connection.query<Grant>(
          "SELECT folder_id,name,can_write FROM root_grants WHERE client_id=$1 ORDER BY name,folder_id",
          [client.parent_id],
        )
      ).rows;
      if (
        !equal(
          consentDigest,
          sign(
            JSON.stringify({
              id,
              scope: pending.scope,
              roots: currentRoots,
              canWrite: client.can_write,
            }),
          ),
        )
      )
        throw new OAuthError("invalid_request");
      const roots = currentRoots.map((root) => ({
        ...root,
        can_write: write && root.can_write,
      }));
      if (!roots.length) throw new OAuthError("access_denied");
      const grantId = randomUUID();
      const tools = toolCatalog()
        .filter((tool) => write || tool.annotations.readOnlyHint)
        .map((tool) => tool.name);
      await connection.query(
        "INSERT INTO mcp_oauth_grants(id,client_id,scope,resource,roots,tools,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 days')",
        [
          grantId,
          client.id,
          pending.scope,
          pending.resource,
          JSON.stringify(roots),
          tools,
        ],
      );
      const code = randomBytes(32).toString("base64url");
      await connection.query(
        "INSERT INTO mcp_oauth_codes(hash,grant_id,redirect_uri,challenge,expires_at) VALUES($1,$2,$3,$4,now()+interval '2 minutes')",
        [hash(code), grantId, pending.redirect_uri, pending.challenge],
      );
      callback.searchParams.set("code", code);
    } else callback.searchParams.set("error", "access_denied");
    await connection.query("DELETE FROM mcp_oauth_requests WHERE id=$1", [id]);
    return callback.href;
  });
}
async function authenticateClient(
  request: Request,
  params: URLSearchParams,
  connection: Pick<PoolClient, "query">,
) {
  let id = params.get("client_id") ?? "";
  let secret = params.get("client_secret") ?? "";
  let method = secret ? "client_secret_post" : "none";
  const authorization = request.headers.get("authorization");
  if (authorization) {
    if (!authorization.startsWith("Basic ") || params.has("client_secret"))
      throw new OAuthError("invalid_client", 401);
    const decoded = Buffer.from(authorization.slice(6), "base64").toString(
      "utf8",
    );
    const split = decoded.indexOf(":");
    if (split < 0) throw new OAuthError("invalid_client", 401);
    try {
      const basicId = decodeURIComponent(
        decoded.slice(0, split).replace(/\+/g, " "),
      );
      if (id && id !== basicId) throw new Error();
      id = basicId;
      secret = decodeURIComponent(decoded.slice(split + 1).replace(/\+/g, " "));
    } catch {
      throw new OAuthError("invalid_client", 401);
    }
    method = "client_secret_basic";
  }
  const client = await findClient(id, connection);
  if (
    !client ||
    client.auth_method !== method ||
    (method !== "none" &&
      (!secret || !equal(hash(secret), client.secret_hash ?? "")))
  )
    throw new OAuthError("invalid_client", 401);
  return client;
}
type TokenGrant = {
  id: string;
  scope: string;
  resource: string;
  expires_at: Date;
  client_id: string;
};
async function issueTokens(connection: PoolClient, grant: TokenGrant) {
  const access = randomBytes(32).toString("base64url");
  const refresh = randomBytes(32).toString("base64url");
  const seconds = Math.max(
    0,
    Math.min(
      3600,
      Math.floor((new Date(grant.expires_at).getTime() - Date.now()) / 1000),
    ),
  );
  if (!seconds) throw new OAuthError("invalid_grant");
  await connection.query(
    "INSERT INTO mcp_oauth_tokens(hash,grant_id,kind,expires_at) VALUES($1,$2,'access',now()+($3 * interval '1 second')),($4,$2,'refresh',$5)",
    [hash(access), grant.id, seconds, hash(refresh), grant.expires_at],
  );
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: seconds,
    refresh_token: refresh,
    scope: grant.scope,
  };
}
export async function exchangeToken(request: Request) {
  const params = await formParams(request);
  return transaction(async (connection) => {
    const client = await authenticateClient(request, params, connection);
    if (params.get("resource") !== resourceUrl())
      throw new OAuthError("invalid_target");
    const type = params.get("grant_type");
    if (type !== "authorization_code" && type !== "refresh_token")
      throw new OAuthError("unsupported_grant_type");
    const credential =
      params.get(type === "authorization_code" ? "code" : "refresh_token") ??
      "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential))
      throw new OAuthError("invalid_grant");
    // Lock the grant before the credential: serializes refresh/replay and issuance.
    const credentialTable =
      type === "authorization_code" ? "mcp_oauth_codes" : "mcp_oauth_tokens";
    const found = await connection.query<{ grant_id: string }>(
      `SELECT grant_id FROM ${credentialTable} WHERE hash=$1`,
      [hash(credential)],
    );
    if (!found.rows[0]) throw new OAuthError("invalid_grant");
    const grantResult = await connection.query<TokenGrant>(
      "SELECT * FROM mcp_oauth_grants WHERE id=$1 AND client_id=$2 AND NOT revoked AND expires_at>now() FOR UPDATE",
      [found.rows[0].grant_id, client.id],
    );
    const grant = grantResult.rows[0];
    if (!grant || grant.resource !== params.get("resource"))
      throw new OAuthError("invalid_grant");
    if (params.has("scope") && params.get("scope") !== grant.scope)
      throw new OAuthError("invalid_scope");
    if (type === "authorization_code") {
      const result = await connection.query<{
        challenge: string;
        redirect_uri: string;
        used: boolean;
      }>(
        "SELECT challenge,redirect_uri,used FROM mcp_oauth_codes WHERE hash=$1 AND expires_at>now()",
        [hash(credential)],
      );
      const code = result.rows[0];
      const verifier = params.get("code_verifier") ?? "";
      if (
        !code ||
        code.redirect_uri !== params.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !equal(
          createHash("sha256").update(verifier).digest("base64url"),
          code.challenge,
        )
      )
        throw new OAuthError("invalid_grant");
      if (code.used) {
        await connection.query(
          "UPDATE mcp_oauth_grants SET revoked=true WHERE id=$1",
          [grant.id],
        );
        return { error: "invalid_grant" };
      }
      await connection.query(
        "UPDATE mcp_oauth_codes SET used=true WHERE hash=$1",
        [hash(credential)],
      );
    } else {
      const result = await connection.query<{ used: boolean }>(
        "SELECT used FROM mcp_oauth_tokens WHERE hash=$1 AND kind='refresh' AND expires_at>now()",
        [hash(credential)],
      );
      if (!result.rows[0]) throw new OAuthError("invalid_grant");
      if (result.rows[0].used) {
        // Commit replay revocation rather than throwing and rolling it back.
        await connection.query(
          "UPDATE mcp_oauth_grants SET revoked=true WHERE id=$1",
          [grant.id],
        );
        return { error: "invalid_grant" };
      }
      await connection.query(
        "UPDATE mcp_oauth_tokens SET used=true WHERE hash=$1",
        [hash(credential)],
      );
    }
    return issueTokens(connection, grant);
  });
}
export async function revokeToken(request: Request) {
  const params = await formParams(request);
  await transaction(async (connection) => {
    const client = await authenticateClient(request, params, connection);
    await connection.query(
      "UPDATE mcp_oauth_grants SET revoked=true WHERE client_id=$1 AND id IN (SELECT grant_id FROM mcp_oauth_tokens WHERE hash=$2)",
      [client.id, hash(params.get("token") ?? "")],
    );
  });
}
