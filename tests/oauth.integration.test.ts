import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { hash } from "@/server/crypto";
import { authenticate, makeSession, sessionName } from "@/server/auth";
import { grants, checkAncestry } from "@/server/policy";
import { saveTransfer, getTransfer, recoverUpload } from "@/server/transfers";
import { mutation } from "@/server/operations";
import { handleMcp } from "@/server/mcp";
import { POST as tokenRoute } from "@/app/oauth/token/route";
import { POST as approveRoute } from "@/app/oauth/approve/route";
import { GET as mcpGet } from "@/app/api/mcp/route";
import {
  registration,
  registerClient,
  resourceUrl,
  startAuthorization,
  requestCookie,
  consentDetails,
  approveAuthorization,
  exchangeToken,
  revokeToken,
  authorizationMetadata,
  protectedMetadata,
} from "@/server/oauth";
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { value: jar.get(name) } : undefined,
  }),
}));
const parent = randomUUID();
const bearer = "b".repeat(43);
const callback = "https://chatgpt.com/connector/oauth/test";
const verifier = "v".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const origin = "http://localhost:3000";
type Registered = Awaited<ReturnType<typeof registerClient>>;
let registered: Registered;
function tokenRequest(
  input: Record<string, string>,
  client = registered,
  method = "client_secret_post",
) {
  const params = new URLSearchParams({
    client_id: client.clientId,
    resource: resourceUrl(),
    ...input,
  });
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (method === "client_secret_post" && !params.has("client_secret"))
    params.set("client_secret", client.clientSecret!);
  if (method === "client_secret_basic")
    headers.authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  return new Request(`${origin}/oauth/token`, {
    method: "POST",
    headers,
    body: params,
  });
}
function authRequest(overrides: Record<string, string> = {}) {
  return new Request(
    `${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.clientId, redirect_uri: callback, resource: resourceUrl(), scope: "mcp:read mcp:write", code_challenge: challenge, code_challenge_method: "S256", state: "my-state", ...overrides })}`,
  );
}
async function pending(overrides: Record<string, string> = {}) {
  const result = await startAuthorization(authRequest(overrides));
  jar.set(requestCookie(result.id), result.browser);
  return result;
}
async function code(overrides: Record<string, string> = {}) {
  const request = await pending(overrides);
  const details = await consentDetails(request.id);
  const url = new URL(
    await approveAuthorization(request.id, true, details.consentDigest),
  );
  expect(url.searchParams.get("state")).toBe("my-state");
  return url.searchParams.get("code")!;
}
async function tokens(overrides: Record<string, string> = {}) {
  const value = await exchangeToken(
    tokenRequest({
      grant_type: "authorization_code",
      code: await code(overrides),
      redirect_uri: callback,
      code_verifier: verifier,
    }),
  );
  if ("error" in value) throw new Error(value.error);
  return value;
}
function withBearer(token: string) {
  return new Request(`${origin}/api/mcp`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "MCP OAuth with real PostgreSQL",
  () => {
    beforeAll(async () => {
      for (const file of ["001_initial.sql", "002_mcp_oauth.sql"])
        await db().query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
    });
    beforeEach(async () => {
      await db().query("TRUNCATE mcp_clients, mcp_oauth_limits CASCADE");
      jar.clear();
      await db().query(
        "INSERT INTO mcp_clients(id,name,token_hash,can_write) VALUES($1,'ChatGPT folders',$2,true)",
        [parent, hash(bearer)],
      );
      await db().query(
        "INSERT INTO root_grants(client_id,folder_id,name,can_write) VALUES($1,'root','Approved',true)",
        [parent],
      );
      registered = await registerClient({
        name: "ChatGPT",
        parentId: parent,
        redirectUris: [callback],
        authMethod: "client_secret_post",
      });
    });
    afterAll(async () => {
      await db().end();
    });
    it("publishes discovery and a WWW-Authenticate challenge on GET and POST", async () => {
      expect(authorizationMetadata().code_challenge_methods_supported).toEqual([
        "S256",
      ]);
      expect(protectedMetadata().resource).toBe(resourceUrl());
      const response = await handleMcp(
        new Request(resourceUrl(), { method: "POST" }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "oauth-protected-resource/api/mcp",
      );
      expect((await mcpGet(new Request(resourceUrl()))).status).toBe(401);
    });
    it("issues hashed tokens, authenticates MCP and preserves bearer clients", async () => {
      const result = await tokens();
      expect(result.expires_in).toBeLessThanOrEqual(3600);
      expect((await authenticate(withBearer(result.access_token))).id).toBe(
        parent,
      );
      expect((await authenticate(withBearer(bearer))).id).toBe(parent);
      expect(
        (await db().query("SELECT hash FROM mcp_oauth_tokens")).rows.map(
          (row) => row.hash,
        ),
      ).not.toContain(result.access_token);
      const response = await handleMcp(
        new Request(resourceUrl(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${result.access_token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "ChatGPT", version: "test" },
            },
          }),
        }),
      );
      expect((await response.json()).result.protocolVersion).toBe("2025-03-26");
    });
    it("rejects bad PKCE without consuming the code, then revokes tokens on valid code replay", async () => {
      const credential = await code();
      const input = {
        grant_type: "authorization_code",
        code: credential,
        redirect_uri: callback,
        code_verifier: verifier,
      };
      await expect(
        exchangeToken(
          tokenRequest({ ...input, code_verifier: "x".repeat(64) }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const result = await exchangeToken(tokenRequest(input));
      if ("error" in result) throw new Error();
      expect(await exchangeToken(tokenRequest(input))).toEqual({
        error: "invalid_grant",
      });
      await expect(
        authenticate(withBearer(result.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
    it("rotates refresh tokens and commits family revocation on replay", async () => {
      const first = await tokens();
      const second = await exchangeToken(
        tokenRequest({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
        }),
      );
      if ("error" in second) throw new Error();
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(
        await exchangeToken(
          tokenRequest({
            grant_type: "refresh_token",
            refresh_token: first.refresh_token,
          }),
        ),
      ).toEqual({ error: "invalid_grant" });
      await expect(
        authenticate(withBearer(second.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
    it("serializes simultaneous refresh requests and revokes the reused family", async () => {
      const first = await tokens();
      const request = () =>
        tokenRequest({
          grant_type: "refresh_token",
          refresh_token: first.refresh_token,
        });
      const results = await Promise.all([
        exchangeToken(request()),
        exchangeToken(request()),
      ]);
      expect(results.filter((value) => "error" in value)).toHaveLength(1);
      const success = results.find((value) => !("error" in value))!;
      if ("error" in success) throw new Error();
      await expect(
        authenticate(withBearer(success.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
    it("limits read-only tokens to read-only tools and denies writes in ancestry", async () => {
      const result = await tokens({ scope: "mcp:read" });
      const client = await authenticate(withBearer(result.access_token));
      expect(client.can_write).toBe(false);
      expect(client.permitted_tools).not.toContain("drive_create_folder");
      expect((await grants(client))[0].can_write).toBe(false);
      await expect(
        checkAncestry(
          {
            metadata: async () => ({
              id: "root",
              name: "Approved",
              mimeType: "application/vnd.google-apps.folder",
            }),
          },
          "root",
          await grants(client),
          true,
          client.can_write,
        ),
      ).rejects.toMatchObject({ code: "WRITE_DENIED" });
    });
    it("does not expand consent after new grants and honors removed/downgraded grants", async () => {
      const result = await tokens();
      const client = await authenticate(withBearer(result.access_token));
      await db().query(
        "INSERT INTO root_grants(client_id,folder_id,name,can_write) VALUES($1,'outside','Outside',true)",
        [parent],
      );
      expect((await grants(client)).map((value) => value.folder_id)).toEqual([
        "root",
      ]);
      await expect(
        checkAncestry(
          {
            metadata: async (id) => ({
              id,
              name: id,
              mimeType: "application/vnd.google-apps.folder",
            }),
          },
          "outside",
          await grants(client),
          false,
          true,
        ),
      ).rejects.toMatchObject({ code: "OUTSIDE_APPROVED_FOLDERS" });
      await db().query(
        "UPDATE root_grants SET can_write=false WHERE client_id=$1 AND folder_id='root'",
        [parent],
      );
      expect((await grants(client))[0].can_write).toBe(false);
      await db().query(
        "DELETE FROM root_grants WHERE client_id=$1 AND folder_id='root'",
        [parent],
      );
      expect(await grants(client)).toEqual([]);
    });
    it("rejects a changed consent snapshot and a different browser", async () => {
      const request = await pending();
      const details = await consentDetails(request.id);
      jar.delete(requestCookie(request.id));
      await expect(consentDetails(request.id)).rejects.toMatchObject({
        code: "invalid_request",
      });
      jar.set(requestCookie(request.id), request.browser);
      await db().query(
        "UPDATE root_grants SET can_write=false WHERE client_id=$1",
        [parent],
      );
      await expect(
        approveAuthorization(request.id, true, details.consentDigest),
      ).rejects.toMatchObject({ code: "invalid_request" });
    });
    it("denies without issuing codes and consumes the request", async () => {
      const request = await pending();
      const url = new URL(await approveAuthorization(request.id, false, ""));
      expect(url.searchParams.get("error")).toBe("access_denied");
      expect(url.searchParams.get("state")).toBe("my-state");
      expect((await db().query("SELECT * FROM mcp_oauth_codes")).rowCount).toBe(
        0,
      );
      await expect(consentDetails(request.id)).rejects.toMatchObject({
        code: "invalid_request",
      });
    });
    it.each(["none", "client_secret_basic"])(
      "supports %s client authentication with PKCE",
      async (method) => {
        registered = await registerClient({
          name: "Other AI",
          parentId: parent,
          redirectUris: [callback],
          authMethod: method as "none" | "client_secret_basic",
        });
        const value = await exchangeToken(
          tokenRequest(
            {
              grant_type: "authorization_code",
              code: await code(),
              redirect_uri: callback,
              code_verifier: verifier,
            },
            registered,
            method,
          ),
        );
        expect(value).toHaveProperty("access_token");
      },
    );
    it("rejects missing/wrong client secrets and cross-client token exchange", async () => {
      const credential = await code();
      const input = {
        grant_type: "authorization_code",
        code: credential,
        redirect_uri: callback,
        code_verifier: verifier,
      };
      await expect(
        exchangeToken(tokenRequest(input, registered, "none")),
      ).rejects.toMatchObject({ code: "invalid_client" });
      await expect(
        exchangeToken(tokenRequest({ ...input, client_secret: "wrong" })),
      ).rejects.toMatchObject({ code: "invalid_client" });
      const other = await registerClient({
        name: "Other",
        parentId: parent,
        redirectUris: [callback],
        authMethod: "none",
      });
      await expect(
        exchangeToken(tokenRequest(input, other, "none")),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });
    it.each([
      { redirect_uri: "https://evil.example/callback" },
      { code_challenge_method: "plain" },
      { resource: "https://evil.example/api/mcp" },
      { scope: "drive" },
    ])("rejects unsafe authorization parameters %j", async (params) => {
      await expect(
        startAuthorization(
          authRequest(
            Object.fromEntries(
              Object.entries(params).filter(
                ([, value]) => typeof value === "string",
              ),
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(Error);
    });
    it("requires resource binding at exchange and exact redirect URI", async () => {
      const input = {
        grant_type: "authorization_code",
        code: await code(),
        redirect_uri: callback,
        code_verifier: verifier,
      };
      await expect(
        exchangeToken(tokenRequest({ ...input, resource: "" })),
      ).rejects.toMatchObject({ code: "invalid_target" });
      await expect(
        exchangeToken(tokenRequest({ ...input, redirect_uri: `${callback}/` })),
      ).rejects.toMatchObject({ code: "invalid_grant" });
    });
    it("exchanges resource-bound credentials when token requests omit resource", async () => {
      const input = {
        grant_type: "authorization_code",
        code: await code(),
        redirect_uri: callback,
        code_verifier: verifier,
      };
      const firstRequest = tokenRequest(input);
      const firstParams = new URLSearchParams(await firstRequest.text());
      firstParams.delete("resource");
      const firstResponse = await tokenRoute(
        new Request(firstRequest.url, {
          method: "POST",
          headers: firstRequest.headers,
          body: firstParams,
        }),
      );
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect((await authenticate(withBearer(first.access_token))).id).toBe(
        parent,
      );
      const refreshRequest = tokenRequest({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
      });
      const refreshParams = new URLSearchParams(await refreshRequest.text());
      refreshParams.delete("resource");
      const next = await tokenRoute(
        new Request(refreshRequest.url, {
          method: "POST",
          headers: refreshRequest.headers,
          body: refreshParams,
        }),
      );
      expect(next.status).toBe(200);
      expect((await next.json()).refresh_token).not.toBe(first.refresh_token);
    });
    it("accepts equivalent scope ordering but rejects added scopes", async () => {
      const result = await exchangeToken(
        tokenRequest({
          grant_type: "authorization_code",
          code: await code(),
          redirect_uri: callback,
          code_verifier: verifier,
          scope: "mcp:write mcp:read",
        }),
      );
      expect(result).toHaveProperty("access_token");
      await expect(
        exchangeToken(
          tokenRequest({
            grant_type: "authorization_code",
            code: await code({ scope: "mcp:read" }),
            redirect_uri: callback,
            code_verifier: verifier,
            scope: "mcp:read mcp:write",
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_scope" });
    });
    it("logs only safe error codes for failed token exchanges", async () => {
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const response = await tokenRoute(
          tokenRequest({
            grant_type: "authorization_code",
            code: "z".repeat(43),
            redirect_uri: callback,
            code_verifier: verifier,
            client_secret: "test-secret-not-for-logs",
          }),
        );
        expect(response.status).toBe(401);
        expect(log).toHaveBeenCalledWith("mcp_oauth_token_failure", {
          error: "invalid_client",
        });
        expect(JSON.stringify(log.mock.calls)).not.toContain(
          "test-secret-not-for-logs",
        );
        expect(JSON.stringify(log.mock.calls)).not.toContain(verifier);
      } finally {
        log.mockRestore();
      }
    });
    it("rejects duplicate parameters and expires authorization codes", async () => {
      const credential = await code();
      await db().query(
        "UPDATE mcp_oauth_codes SET expires_at=now()-interval '1 second'",
      );
      const req = tokenRequest({
        grant_type: "authorization_code",
        code: credential,
        redirect_uri: callback,
        code_verifier: verifier,
      });
      expect((await tokenRoute(req)).status).toBe(400);
      const duplicate = new Request(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "client_id=a&client_id=b",
      });
      expect((await (await tokenRoute(duplicate)).json()).error).toBe(
        "invalid_request",
      );
    });
    it("rejects expired access/refresh tokens and pending browser requests", async () => {
      const result = await tokens();
      await db().query(
        "UPDATE mcp_oauth_tokens SET expires_at=now()-interval '1 second'",
      );
      await expect(
        authenticate(withBearer(result.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        exchangeToken(
          tokenRequest({
            grant_type: "refresh_token",
            refresh_token: result.refresh_token,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_grant" });
      const request = await pending();
      await db().query(
        "UPDATE mcp_oauth_requests SET expires_at=now()-interval '1 second'",
      );
      await expect(consentDetails(request.id)).rejects.toMatchObject({
        code: "invalid_request",
      });
    });
    it("revokes tokens through RFC 7009 and parent/operator revocation", async () => {
      const result = await tokens();
      await revokeToken(tokenRequest({ token: result.refresh_token }));
      await expect(
        authenticate(withBearer(result.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const next = await tokens();
      await db().query("UPDATE mcp_clients SET revoked=true WHERE id=$1", [
        parent,
      ]);
      await expect(
        authenticate(withBearer(next.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        exchangeToken(
          tokenRequest({
            grant_type: "refresh_token",
            refresh_token: next.refresh_token,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_client" });
    });
    it("operator consent requires login, same origin, and the browser-bound request", async () => {
      const request = await pending();
      const details = await consentDetails(request.id);
      const form = new URLSearchParams({
        request: request.id,
        decision: "approve",
        consentDigest: details.consentDigest,
      });
      const req = (originValue: string) =>
        new Request(`${origin}/oauth/approve`, {
          method: "POST",
          headers: {
            origin: originValue,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        });
      expect((await approveRoute(req(origin))).status).not.toBe(303);
      jar.set(sessionName(), makeSession());
      expect((await approveRoute(req("https://evil.example"))).status).not.toBe(
        303,
      );
      expect((await approveRoute(req(origin))).status).toBe(303);
    });
    it("isolates transfers and mutation retries between OAuth authorizations", async () => {
      const first = await authenticate(
        withBearer((await tokens()).access_token),
      );
      const second = await authenticate(
        withBearer((await tokens()).access_token),
      );
      const transfer = await saveTransfer(first, "upload", {
        fileId: "file",
        parentId: "root",
        mimeType: "application/pdf",
        total: 1,
        offset: 0,
        operationId: "same-operation",
      });
      expect((await getTransfer(first, transfer.transferId)).id).toBe(
        transfer.transferId,
      );
      await expect(
        getTransfer(second, transfer.transferId),
      ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
      expect(await recoverUpload(second, "same-operation")).toBeUndefined();
      expect(await recoverUpload(first, "same-operation")).toHaveProperty(
        "transferId",
        transfer.transferId,
      );
      let count = 0;
      const action = async () => ({ count: ++count });
      expect(await mutation(first, "oauth-operation", {}, action)).toEqual({
        count: 1,
      });
      expect(await mutation(first, "oauth-operation", {}, action)).toEqual({
        count: 1,
      });
      expect(await mutation(second, "oauth-operation", {}, action)).toEqual({
        count: 2,
      });
    });
    it("revokes an OAuth registration without revoking its parent bearer client", async () => {
      const result = await tokens();
      await db().query(
        "UPDATE mcp_oauth_clients SET revoked=true WHERE id=$1",
        [registered.clientId],
      );
      await expect(
        authenticate(withBearer(result.access_token)),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect((await authenticate(withBearer(bearer))).id).toBe(parent);
    });
    it("only accepts HTTPS/loopback callback registrations", () => {
      expect(
        registration.safeParse({
          name: "App",
          parentId: parent,
          redirectUris: ["http://evil.example/callback"],
          authMethod: "none",
        }).success,
      ).toBe(false);
    });
  },
);
