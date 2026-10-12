import { NextResponse } from "next/server";
import { config } from "@/server/config";
import {
  startAuthorization,
  requestCookie,
  oauthError,
  oauthHeaders,
  rateLimit,
} from "@/server/oauth";
export async function GET(request: Request) {
  try {
    await rateLimit(request, "authorize");
    const { id, browser } = await startAuthorization(request);
    const response = NextResponse.redirect(
      new URL(`/oauth/consent?request=${id}`, config().APP_URL),
      303,
    );
    for (const [key, value] of Object.entries(oauthHeaders))
      response.headers.set(key, value);
    response.cookies.set(requestCookie(id), browser, {
      httpOnly: true,
      secure: !!process.env.VERCEL || process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return oauthError(error);
  }
}
