import { authorizationMetadata, oauthHeaders } from "@/server/oauth";
export function GET() {
  return Response.json(authorizationMetadata(), { headers: oauthHeaders });
}
