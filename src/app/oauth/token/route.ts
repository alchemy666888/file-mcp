import {
  exchangeToken,
  oauthError,
  oauthHeaders,
  rateLimit,
  OAuthError,
} from "@/server/oauth";
export async function POST(request: Request) {
  try {
    await rateLimit(request, "token");
    const result = await exchangeToken(request);
    if ("error" in result)
      console.warn("mcp_oauth_token_failure", { error: result.error });
    return Response.json(result, {
      status: "error" in result ? 400 : 200,
      headers: oauthHeaders,
    });
  } catch (error) {
    // Fixed fields only: never log request bodies, headers, codes, or secrets.
    console.warn("mcp_oauth_token_failure", {
      error: error instanceof OAuthError ? error.code : "server_error",
    });
    return oauthError(error);
  }
}
