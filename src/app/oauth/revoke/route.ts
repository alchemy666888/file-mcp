import {
  revokeToken,
  oauthError,
  oauthHeaders,
  rateLimit,
} from "@/server/oauth";
export async function POST(request: Request) {
  try {
    await rateLimit(request, "revoke");
    await revokeToken(request);
    return new Response(null, { status: 200, headers: oauthHeaders });
  } catch (error) {
    return oauthError(error);
  }
}
