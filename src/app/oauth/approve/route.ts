import { NextResponse } from "next/server";
import { requireOperator, sameOrigin } from "@/server/auth";
import {
  approveAuthorization,
  formParams,
  oauthError,
  oauthHeaders,
  requestCookie,
} from "@/server/oauth";
export async function POST(request: Request) {
  try {
    await requireOperator();
    sameOrigin(request);
    const params = await formParams(request);
    const id = params.get("request") ?? "";
    if (!["approve", "deny"].includes(params.get("decision") ?? ""))
      return Response.json(
        { error: "invalid_request" },
        { status: 400, headers: oauthHeaders },
      );
    const callback = await approveAuthorization(
      id,
      params.get("decision") === "approve",
      params.get("consentDigest") ?? "",
    );
    const response = NextResponse.redirect(callback, 303);
    for (const [key, value] of Object.entries(oauthHeaders))
      response.headers.set(key, value);
    response.cookies.set(requestCookie(id), "", {
      path: "/",
      maxAge: 0,
      secure: !!process.env.VERCEL || process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    });
    return response;
  } catch (error) {
    return oauthError(error);
  }
}
