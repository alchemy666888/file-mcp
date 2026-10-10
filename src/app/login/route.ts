import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { sameOrigin, makeSession, sessionName } from "@/server/auth";
import { equal, hash } from "@/server/crypto";
import { AppError, errorResponse } from "@/server/errors";
import { db } from "@/server/db";
import { boundedBody } from "@/server/body";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const key = hash(
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        "operator",
    );
    const limit = await db().query(
      "INSERT INTO login_limits(key,attempts,started_at) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN login_limits.started_at<now()-interval '10 minutes' THEN 1 ELSE login_limits.attempts+1 END,started_at=CASE WHEN login_limits.started_at<now()-interval '10 minutes' THEN now() ELSE login_limits.started_at END RETURNING attempts",
      [key],
    );
    if (limit.rows[0].attempts > 10)
      throw new AppError("LOGIN_RATE_LIMITED", 429);
    const form = new URLSearchParams(
      new TextDecoder().decode(await boundedBody(request, 4096)),
    );
    if (!equal(form.get("password") ?? "", config().DASHBOARD_SECRET))
      return NextResponse.redirect(
        new URL("/?error=login", config().APP_URL),
        303,
      );
    const response = NextResponse.redirect(
      new URL("/dashboard", config().APP_URL),
      303,
    );
    response.cookies.set(sessionName(), makeSession(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
