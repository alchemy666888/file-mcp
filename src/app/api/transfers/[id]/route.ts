import { z } from "zod";
import { authenticate } from "@/server/auth";
import { boundedBody } from "@/server/body";
import { CHUNK_SIZE } from "@/server/content";
import { AppError, errorResponse } from "@/server/errors";
import { accessToken, GoogleDrive } from "@/server/google";
import { uploadChunk, downloadChunk } from "@/server/transfers";
import { db } from "@/server/db";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };
async function transfer(request: Request, context: Context, upload: boolean) {
  let clientId: string | undefined;
  const started = Date.now();
  let outcome = "failure";
  try {
    const client = await authenticate(request);
    clientId = client.id;
    if (
      client.permitted_tools &&
      !client.permitted_tools.includes(
        upload ? "drive_begin_upload" : "drive_begin_download",
      )
    )
      throw new AppError("TOOL_DENIED", 403);
    const id = z.uuid().parse((await context.params).id);
    const url = new URL(request.url);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .parse(url.searchParams.get("offset") ?? "0");
    const drive = new GoogleDrive(await accessToken());
    if (upload) {
      const bytes = await boundedBody(request, CHUNK_SIZE);
      const result = await uploadChunk(client, drive, id, offset, bytes);
      outcome = "success";
      return Response.json(result, {
        headers: { "cache-control": "no-store" },
      });
    }
    const length = z.coerce
      .number()
      .int()
      .min(1)
      .max(CHUNK_SIZE)
      .parse(url.searchParams.get("length") ?? String(CHUNK_SIZE));
    const result = await downloadChunk(client, drive, id, offset, length);
    outcome = "success";
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "x-next-offset": String(offset + result.bytes.length),
        "x-transfer-eof": String(result.eof),
        "content-disposition": "attachment",
      },
    });
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (clientId)
      await db().query(
        "INSERT INTO audit_events(client_id,tool,outcome,duration_ms) VALUES($1,$2,$3,$4)",
        [
          clientId,
          upload ? "transfer_upload_chunk" : "transfer_download_chunk",
          outcome,
          Date.now() - started,
        ],
      );
  }
}
export async function PUT(request: Request, context: Context) {
  return transfer(request, context, true);
}
export async function GET(request: Request, context: Context) {
  return transfer(request, context, false);
}
