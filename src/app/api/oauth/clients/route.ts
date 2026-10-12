import { z } from "zod";
import { requireOperator, sameOrigin } from "@/server/auth";
import { boundedJson } from "@/server/body";
import { registration, registerClient } from "@/server/oauth";
import { errorResponse } from "@/server/errors";
import { db } from "@/server/db";
const action = z.discriminatedUnion("action", [
  registration.extend({ action: z.literal("register") }),
  z.object({ action: z.literal("revoke_client"), id: z.string().max(100) }),
  z.object({ action: z.literal("revoke_grant"), id: z.uuid() }),
]);
export async function POST(request: Request) {
  try {
    await requireOperator();
    sameOrigin(request);
    const input = action.parse(await boundedJson(request));
    if (input.action === "register")
      return Response.json(await registerClient(input), {
        headers: { "cache-control": "no-store" },
      });
    if (input.action === "revoke_client")
      await db().query(
        "UPDATE mcp_oauth_clients SET revoked=true WHERE id=$1",
        [input.id],
      );
    if (input.action === "revoke_grant")
      await db().query("UPDATE mcp_oauth_grants SET revoked=true WHERE id=$1", [
        input.id,
      ]);
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
