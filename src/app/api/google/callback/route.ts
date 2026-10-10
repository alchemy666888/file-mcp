import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { hash, equal, encrypt } from "@/server/crypto";
import { db } from "@/server/db";
import { AppError, errorResponse } from "@/server/errors";
export async function GET(request: Request) {
  try {
    // The single-use state cookie binds the callback even though Strict operator cookies aren't sent on Google's redirect.
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const cookie = (await cookies()).get("file-mcp-oauth-state")?.value;
    if (!state || !cookie || !equal(state, cookie))
      throw new AppError("OAUTH_STATE_INVALID", 403);
    const consumed = await db().query(
      "DELETE FROM oauth_states WHERE hash=$1 AND expires_at>now() RETURNING hash",
      [hash(state)],
    );
    if (!consumed.rowCount) throw new AppError("OAUTH_STATE_INVALID", 403);
    const code = url.searchParams.get("code");
    if (!code) throw new AppError("GOOGLE_AUTHORIZATION_DENIED");
    const settings = config();
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: settings.GOOGLE_CLIENT_ID,
        client_secret: settings.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${settings.APP_URL}/api/google/callback`,
      }),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!response.ok) throw new AppError("GOOGLE_AUTHORIZATION_FAILED", 502);
    const tokens = await response.json();
    if (typeof tokens.refresh_token !== "string")
      throw new AppError("GOOGLE_REFRESH_TOKEN_REQUIRED");
    await db().query(
      "INSERT INTO google_connection(singleton,refresh_token) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET refresh_token=$1,updated_at=now()",
      [encrypt(tokens.refresh_token)],
    );
    const result = NextResponse.redirect(
      new URL("/dashboard", settings.APP_URL),
      303,
    );
    result.headers.set("referrer-policy", "no-referrer");
    result.cookies.set("file-mcp-oauth-state", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google/callback",
      maxAge: 0,
    });
    return result;
  } catch (error) {
    return errorResponse(error);
  }
}
