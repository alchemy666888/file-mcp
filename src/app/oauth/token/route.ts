import {
  exchangeToken,
  oauthError,
  oauthHeaders,
  rateLimit,
} from "@/server/oauth";
export async function POST(request: Request) {
  try {
    await rateLimit(request, "token");
    const result = await exchangeToken(request);
    return Response.json(result, {
      status: "error" in result ? 400 : 200,
      headers: oauthHeaders,
    });
  } catch (error) {
    return oauthError(error);
  }
}
