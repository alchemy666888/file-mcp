import { handleMcp } from "@/server/mcp";
export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = handleMcp;
export function GET() {
  return new Response(null, {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
