import { protectedMetadata, oauthHeaders } from "@/server/oauth";
export function GET() {
  return Response.json(protectedMetadata(), { headers: oauthHeaders });
}
