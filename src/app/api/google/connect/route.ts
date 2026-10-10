import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { requireOperator, sameOrigin } from "@/server/auth";
import { hash } from "@/server/crypto";
import { db } from "@/server/db";
import { errorResponse } from "@/server/errors";
export async function POST(request: Request) {
  try {
    await requireOperator();
    sameOrigin(request);
    const settings = config();
    const state = randomBytes(32).toString("base64url");
    await db().query("DELETE FROM oauth_states WHERE expires_at<now()");
    await db().query(
      "INSERT INTO oauth_states(hash,expires_at) VALUES($1,now()+interval '10 minutes')",
      [hash(state)],
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: settings.GOOGLE_CLIENT_ID,
      redirect_uri: `${settings.APP_URL}/api/google/callback`,
      response_type: "code",
      scope: settings.GOOGLE_OAUTH_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    const response = NextResponse.redirect(url, 303);
    response.cookies.set("file-mcp-oauth-state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/google/callback",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
