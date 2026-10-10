import { configured } from "@/server/config";
export function GET() {
  return Response.json(
    {
      status: configured() ? "configured" : "setup_required",
      service: "file-management-mcp",
      version: "0.1.0",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
