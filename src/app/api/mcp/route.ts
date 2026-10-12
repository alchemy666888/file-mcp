import { handleMcp } from "@/server/mcp";
export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = handleMcp;
import { authenticate } from "@/server/auth";
import { errorResponse } from "@/server/errors";
export async function GET(request: Request) {
  try {
    await authenticate(request);
  } catch (error) {
    return errorResponse(error);
  }
  return new Response(null, {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
