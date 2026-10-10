import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { sameOrigin, sessionName } from "@/server/auth";
import { errorResponse } from "@/server/errors";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const response = NextResponse.redirect(new URL("/", config().APP_URL), 303);
    response.cookies.set(sessionName(), "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
