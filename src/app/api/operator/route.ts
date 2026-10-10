import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { requireOperator, sameOrigin } from "@/server/auth";
import { boundedJson } from "@/server/body";
import { hash } from "@/server/crypto";
import { db, transaction } from "@/server/db";
import { AppError, errorResponse } from "@/server/errors";
import { accessToken, FOLDER, GoogleDrive } from "@/server/google";
const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_client"),
    name: z.string().min(1).max(100),
    canWrite: z.boolean(),
  }),
  z.object({ action: z.literal("revoke_client"), clientId: z.uuid() }),
  z.object({
    action: z.literal("grant"),
    clientId: z.uuid(),
    folderId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    canWrite: z.boolean(),
  }),
  z.object({
    action: z.literal("remove_grant"),
    clientId: z.uuid(),
    folderId: z.string().max(200),
  }),
  z.object({ action: z.literal("disconnect") }),
]);
export async function POST(request: Request) {
  try {
    await requireOperator();
    sameOrigin(request);
    const parsed = action.safeParse(await boundedJson(request));
    if (!parsed.success) throw new AppError("INVALID_ARGUMENTS");
    const input = parsed.data;
    if (input.action === "create_client") {
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await db().query(
        "INSERT INTO mcp_clients(id,name,token_hash,can_write) VALUES($1,$2,$3,$4)",
        [id, input.name, hash(token), input.canWrite],
      );
      return Response.json(
        {
          clientId: id,
          token,
          message: "Copy this token now. It is never stored in plaintext.",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (input.action === "revoke_client")
      await db().query("UPDATE mcp_clients SET revoked=true WHERE id=$1", [
        input.clientId,
      ]);
    if (input.action === "grant") {
      const file = await new GoogleDrive(await accessToken()).metadata(
        input.folderId,
      );
      if (file.mimeType !== FOLDER || file.trashed)
        throw new AppError("ROOT_MUST_BE_A_FOLDER");
      if (input.canWrite && file.capabilities?.canAddChildren === false)
        throw new AppError("GOOGLE_PERMISSION_DENIED", 403);
      if (
        !(
          await db().query(
            "SELECT id FROM mcp_clients WHERE id=$1 AND NOT revoked",
            [input.clientId],
          )
        ).rowCount
      )
        throw new AppError("CLIENT_NOT_FOUND", 404);
      await db().query(
        "INSERT INTO root_grants(client_id,folder_id,name,can_write) VALUES($1,$2,$3,$4) ON CONFLICT(client_id,folder_id) DO UPDATE SET name=$3,can_write=$4",
        [input.clientId, input.folderId, file.name, input.canWrite],
      );
    }
    if (input.action === "remove_grant")
      await db().query(
        "DELETE FROM root_grants WHERE client_id=$1 AND folder_id=$2",
        [input.clientId, input.folderId],
      );
    if (input.action === "disconnect")
      await transaction(async (connection) => {
        await connection.query("DELETE FROM google_connection");
        await connection.query("DELETE FROM transfers");
        await connection.query("DELETE FROM oauth_states");
      });
    return Response.json(
      { ok: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
