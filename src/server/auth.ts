import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { equal, hash, sign } from "./crypto";
import { db } from "./db";
import { AppError } from "./errors";
export const sessionName = () =>
  process.env.VERCEL || process.env.NODE_ENV === "production"
    ? "__Host-file-mcp-session"
    : "file-mcp-session";
export function makeSession() {
  const value = `${Date.now() + 86400000}.${randomBytes(16).toString("hex")}`;
  return `${value}.${sign(value)}`;
}
export function validSession(token?: string) {
  if (!token) return false;
  const parts = token.split(".");
  return (
    parts.length === 3 &&
    Number(parts[0]) > Date.now() &&
    Number(parts[0]) <= Date.now() + 86400000 &&
    equal(parts[2], sign(`${parts[0]}.${parts[1]}`))
  );
}
export async function isOperator() {
  return validSession((await cookies()).get(sessionName())?.value);
}
export async function requireOperator() {
  if (!(await isOperator())) throw new AppError("UNAUTHORIZED", 401);
}
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== config().APP_URL)
    throw new AppError("ORIGIN_DENIED", 403);
}
export type Client = {
  id: string;
  name: string;
  can_write: boolean;
  permitted_tools?: string[];
  permitted_roots?: { folder_id: string; can_write: boolean }[];
  oauth_grant_id?: string;
};
export async function authenticate(request: Request): Promise<Client> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization))
    throw new AppError("UNAUTHORIZED", 401);
  const result = await db().query<Client>(
    "SELECT id,name,can_write FROM mcp_clients WHERE token_hash=$1 AND NOT revoked",
    [hash(authorization.slice(7))],
  );
  if (result.rows[0]) return result.rows[0];
  const oauth = await db().query<Client>(
    "SELECT c.id,c.name,(c.can_write AND position('mcp:write' in g.scope)>0) AS can_write,g.tools AS permitted_tools,g.roots AS permitted_roots,g.id AS oauth_grant_id FROM mcp_oauth_tokens t JOIN mcp_oauth_grants g ON g.id=t.grant_id JOIN mcp_oauth_clients o ON o.id=g.client_id JOIN mcp_clients c ON c.id=o.parent_id WHERE t.hash=$1 AND t.kind='access' AND NOT t.used AND t.expires_at>now() AND g.expires_at>now() AND NOT g.revoked AND NOT o.revoked AND NOT c.revoked",
    [hash(authorization.slice(7))],
  );
  if (oauth.rows[0]) return oauth.rows[0];
  const delegated = await db().query<Client>(
    "SELECT c.id,c.name,c.can_write,s.tools AS permitted_tools FROM delegated_sessions s JOIN mcp_clients c ON c.id=s.client_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT c.revoked",
    [hash(authorization.slice(7))],
  );
  if (!delegated.rows[0]) throw new AppError("UNAUTHORIZED", 401);
  return delegated.rows[0];
}
