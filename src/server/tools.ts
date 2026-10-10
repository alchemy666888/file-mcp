import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Client } from "./auth";
import { authorize, grants } from "./policy";
import {
  FOLDER,
  FILE_FIELDS,
  type DriveFile,
  type GoogleDrive,
} from "./google";
import { AppError } from "./errors";
import { isNative, isText, sliceStream, utf8Prefix } from "./content";
import { mutation } from "./operations";
import { hash } from "./crypto";
import {
  beginDownload,
  createUpload,
  recoverUpload,
  getTransfer,
  publicTransfer,
  completeUpload,
  downloadChunk,
} from "./transfers";
import { nativeKinds, readNative, writeNative } from "./native";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const name = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !/[\x00-\x1f/\\]/.test(value) && value !== "." && value !== "..",
  );
const operationId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const mimeType = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);
const text = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 9000,
    "Text must be at most 9000 UTF-8 bytes",
  );
type Context = { client: Client; drive: GoogleDrive };
type Tool = {
  name: string;
  description: string;
  schema: z.ZodType;
  write?: boolean;
  run: (input: unknown, ctx: Context) => Promise<unknown>;
};
function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.output<S>, ctx: Context) => Promise<unknown>,
  write = false,
): Tool {
  return {
    name,
    description,
    schema,
    write,
    run: (input, ctx) => run(input as z.output<S>, ctx),
  };
}
async function reconcileFolder(
  drive: GoogleDrive,
  id: string,
  parent: string,
  name: string,
) {
  try {
    const file = await drive.metadata(id);
    if (
      file.mimeType === FOLDER &&
      file.name === name &&
      file.parents?.includes(parent) &&
      !file.trashed
    )
      return file;
    return undefined;
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_NOT_FOUND")
      return undefined;
    throw error;
  }
}
export const tools: Tool[] = [
  tool(
    "drive_list_roots",
    "List this client's approved root folders and read/write grants.",
    z.object({}).strict(),
    async (_, ctx) => grants(ctx.client),
  ),
  tool(
    "drive_list_files",
    "List children within an approved folder, with pagination.",
    z
      .object({ folderId: id, pageToken: z.string().max(2000).optional() })
      .strict(),
    async (input, { drive, client }) => {
      await authorize(drive, client, input.folderId, false, true);
      const result = await drive.list(input.folderId, input.pageToken);
      return {
        files: result.files.map(({ id, name, mimeType, size, version }) => ({
          id,
          name,
          mimeType,
          size,
          version,
        })),
        nextPageToken: result.nextPageToken,
      };
    },
  ),
  tool(
    "drive_get_file",
    "Get authorized file metadata, versions, and supported export formats.",
    z.object({ fileId: id }).strict(),
    async (input, { drive, client }) => {
      const file = await authorize(drive, client, input.fileId);
      const { exportLinks, ...metadata } = file;
      return { ...metadata, exportMimeTypes: Object.keys(exportLinks ?? {}) };
    },
  ),
  tool(
    "drive_read_file",
    "Read up to 9000 bytes of UTF-8 text. Offset is a byte offset; use returned nextOffset.",
    z
      .object({
        fileId: id,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(4).max(9000).default(8000),
        expectedVersion: z.string().max(100).optional(),
      })
      .strict(),
    async (input, { drive, client }) => {
      const file = await authorize(drive, client, input.fileId);
      if (!isText(file.mimeType))
        throw new AppError("USE_DOWNLOAD_OR_NATIVE_TOOL");
      if (input.expectedVersion && file.version !== input.expectedVersion)
        throw new AppError("FILE_VERSION_CONFLICT", 409);
      if (input.offset >= Number(file.size ?? 0))
        return { content: "", nextOffset: null, version: file.version };
      const response = await drive.request(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
        {
          headers: {
            range: `bytes=${input.offset}-${input.offset + input.limit - 1}`,
          },
        },
      );
      if (input.offset > 0 && response.status !== 206) {
        await response.body?.cancel();
        throw new AppError("RANGE_NOT_SUPPORTED", 502);
      }
      const bytes = await sliceStream(response, 0, input.limit);
      const { content, consumed } = utf8Prefix(
        bytes,
        input.offset + bytes.length < Number(file.size),
      );
      return {
        content,
        nextOffset:
          input.offset + consumed < Number(file.size)
            ? input.offset + consumed
            : null,
        version: file.version,
      };
    },
  ),
  tool(
    "drive_create_folder",
    "Create one folder. Retries must reuse operationId.",
    z.object({ parentId: id, name, operationId }).strict(),
    async (input, { drive, client }) => {
      await authorize(drive, client, input.parentId, true, true);
      return mutation(
        client,
        input.operationId,
        { tool: "drive_create_folder", ...input },
        (generated) =>
          drive.createFolder(generated!, input.parentId, input.name),
        {
          generate: () => drive.generateId(),
          reconcile: (generated) =>
            reconcileFolder(drive, generated, input.parentId, input.name),
        },
      );
    },
    true,
  ),
  tool(
    "drive_create_folder_path",
    "Create nested folders under an approved folder; existing unambiguous folders are reused.",
    z
      .object({
        rootId: id,
        segments: z.array(name).min(1).max(10),
        operationId,
      })
      .strict(),
    async (input, ctx) => {
      let parent = input.rootId;
      const created: DriveFile[] = [];
      for (let index = 0; index < input.segments.length; index++) {
        await authorize(ctx.drive, ctx.client, parent, true, true);
        const segment = input.segments[index];
        const currentParent = parent;
        const subId = hash(`${input.operationId}:path:${index}`);
        const file = await mutation(
          ctx.client,
          subId,
          {
            tool: "path_segment",
            original: input,
            parent: currentParent,
            index,
          },
          async (generated) => {
            const result = await ctx.drive.list(
              currentParent,
              undefined,
              segment,
            );
            if (result.nextPageToken || result.files.length > 1)
              throw new AppError("FOLDER_NAME_AMBIGUOUS", 409);
            if (result.files.length === 1) {
              if (result.files[0].mimeType !== FOLDER)
                throw new AppError("NAME_ALREADY_USED", 409);
              return result.files[0];
            }
            return ctx.drive.createFolder(generated!, currentParent, segment);
          },
          {
            generate: () => ctx.drive.generateId(),
            reconcile: (generated) =>
              reconcileFolder(ctx.drive, generated, currentParent, segment),
          },
        );
        parent = file.id;
        created.push(file);
      }
      return { folderId: parent, folders: created };
    },
    true,
  ),
  tool(
    "drive_create_file",
    "Create a UTF-8 text file of at most 9000 bytes. For binary or larger files use drive_begin_upload.",
    z
      .object({
        parentId: id,
        name,
        mimeType: mimeType.default("text/plain"),
        content: text,
        operationId,
      })
      .strict(),
    async (input, { drive, client }) => {
      await authorize(drive, client, input.parentId, true, true);
      if (!isText(input.mimeType)) throw new AppError("TEXT_MIME_REQUIRED");
      return mutation(
        client,
        input.operationId,
        { tool: "drive_create_file", ...input },
        async (generated) => {
          const data = Buffer.from(input.content);
          const session = await drive.beginUpload({
            id: generated!,
            parent: input.parentId,
            name: input.name,
            mimeType: input.mimeType,
            total: data.length,
          });
          return drive.json<DriveFile>(session, {
            method: "PUT",
            headers: { "content-type": input.mimeType },
            body: data,
          });
        },
        {
          generate: () => drive.generateId(),
          reconcile: async (generated) => {
            try {
              const file = await drive.metadata(generated);
              return file.name === input.name &&
                file.parents?.includes(input.parentId) &&
                Number(file.size) === Buffer.byteLength(input.content) &&
                file.md5Checksum ===
                  createHash("md5").update(input.content).digest("hex") &&
                !file.trashed
                ? file
                : undefined;
            } catch {
              return undefined;
            }
          },
        },
      );
    },
    true,
  ),
  tool(
    "drive_update_file",
    "Replace UTF-8 text after a version precheck; Google Drive version checks are not atomic compare-and-swap.",
    z
      .object({
        fileId: id,
        content: text,
        expectedVersion: z.string().min(1).max(100),
        operationId,
      })
      .strict(),
    async (input, { drive, client }) => {
      const file = await authorize(drive, client, input.fileId, true);
      if (!isText(file.mimeType))
        throw new AppError("USE_UPLOAD_OR_NATIVE_TOOL");
      return mutation(
        client,
        input.operationId,
        { tool: "drive_update_file", ...input },
        async () => {
          const fresh = await authorize(drive, client, input.fileId, true);
          if (fresh.version !== input.expectedVersion)
            throw new AppError("FILE_VERSION_CONFLICT", 409);
          return drive.json(
            `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}?uploadType=media&fields=${FILE_FIELDS}&supportsAllDrives=true`,
            {
              method: "PATCH",
              headers: { "content-type": file.mimeType },
              body: input.content,
            },
          );
        },
      );
    },
    true,
  ),
  tool(
    "drive_begin_upload",
    "Start a resumable binary upload. Send raw chunks to /api/transfers/{transferId}?offset=N with the same bearer credential. Non-final chunks are multiples of 256 KiB, max 1 MiB.",
    z
      .object({
        parentId: id.optional(),
        fileId: id.optional(),
        name: name.optional(),
        mimeType,
        totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        expectedMd5: z
          .string()
          .regex(/^[a-f0-9]{32}$/)
          .optional(),
        expectedVersion: z.string().max(100).optional(),
        operationId,
      })
      .strict(),
    async (input, { drive, client }) => {
      if (isNative(input.mimeType))
        throw new AppError("USE_NATIVE_DOCUMENT_TOOL");
      if (input.fileId) {
        const file = await authorize(drive, client, input.fileId, true);
        if (isNative(file.mimeType))
          throw new AppError("USE_NATIVE_DOCUMENT_TOOL");
        if (!input.expectedVersion)
          throw new AppError("EXPECTED_VERSION_REQUIRED");
      } else {
        if (!input.parentId || !input.name)
          throw new AppError("PARENT_AND_NAME_REQUIRED");
        await authorize(drive, client, input.parentId, true, true);
      }
      return mutation(
        client,
        input.operationId,
        { tool: "drive_begin_upload", ...input },
        async (generated) => {
          if (input.fileId) {
            const file = await authorize(drive, client, input.fileId, true);
            if (file.version !== input.expectedVersion)
              throw new AppError("FILE_VERSION_CONFLICT", 409);
          }
          return createUpload(client, drive, {
            ...input,
            fileId: input.fileId ?? generated!,
            update: !!input.fileId,
          });
        },
        {
          generate: () =>
            input.fileId ? Promise.resolve(input.fileId) : drive.generateId(),
          reconcile: () => recoverUpload(client, input.operationId),
        },
      );
    },
    true,
  ),
  tool(
    "drive_transfer_status",
    "Read a transfer's last recorded status. Complete upload probes Google for authoritative progress.",
    z.object({ transferId: z.uuid() }).strict(),
    async (input, { client, drive }) => {
      const transfer = await getTransfer(client, input.transferId);
      await authorize(
        drive,
        client,
        transfer.data.update || transfer.kind === "download"
          ? transfer.data.fileId
          : transfer.data.parentId!,
        transfer.kind === "upload",
        transfer.kind === "upload" && !transfer.data.update,
      );
      return publicTransfer(transfer);
    },
  ),
  tool(
    "drive_complete_upload",
    "Probe resumable upload progress and verify completed size. Returns file metadata including Google's MD5 when available.",
    z.object({ transferId: z.uuid() }).strict(),
    async (input, { client, drive }) =>
      completeUpload(client, drive, input.transferId),
    true,
  ),
  tool(
    "drive_begin_download",
    "Create an authorized binary download transfer. Google-native files require a supported export MIME type; Drive exports have Google's 10 MB limit.",
    z.object({ fileId: id, exportMimeType: mimeType.optional() }).strict(),
    async (input, { client, drive }) =>
      beginDownload(client, drive, input.fileId, input.exportMimeType),
  ),
  tool(
    "drive_read_download_chunk",
    "Read a small base64 chunk via MCP. Large transfers should use the authenticated HTTP endpoint.",
    z
      .object({
        transferId: z.uuid(),
        offset: z.number().int().min(0),
        limit: z.number().int().min(1).max(9000).default(8000),
      })
      .strict(),
    async (input, { client, drive }) => {
      const result = await downloadChunk(
        client,
        drive,
        input.transferId,
        input.offset,
        input.limit,
      );
      return {
        base64: result.bytes.toString("base64"),
        nextOffset: input.offset + result.bytes.length,
        eof: result.eof,
        mimeType: result.mimeType,
      };
    },
  ),
  tool(
    "drive_create_native_file",
    "Create a native Google Doc, Sheet, or Slides presentation inside an approved folder.",
    z
      .object({
        parentId: id,
        name,
        kind: z.enum(["docs", "sheets", "slides"]),
        operationId,
      })
      .strict(),
    async (input, { client, drive }) => {
      await authorize(drive, client, input.parentId, true, true);
      return mutation(
        client,
        input.operationId,
        { tool: "drive_create_native_file", ...input },
        () =>
          drive.json(
            `https://www.googleapis.com/drive/v3/files?fields=${FILE_FIELDS}&supportsAllDrives=true`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name: input.name,
                mimeType: nativeKinds[input.kind],
                parents: [input.parentId],
              }),
            },
          ),
      );
    },
    true,
  ),
  tool(
    "drive_read_native_file",
    "Read Google Docs/Slides JSON or Sheets values. Paginated JSON fragments fit agent-bot's result budget; reassemble before parsing.",
    z
      .object({
        fileId: id,
        kind: z.enum(["docs", "sheets", "slides"]),
        range: z.string().min(1).max(200).optional(),
        offset: z.number().int().min(0).default(0),
        expectedVersion: z.string().max(100).optional(),
      })
      .strict(),
    async (input, { client, drive }) => {
      const file = await authorize(drive, client, input.fileId);
      if (file.mimeType !== nativeKinds[input.kind])
        throw new AppError("NATIVE_TYPE_MISMATCH");
      if (input.expectedVersion && file.version !== input.expectedVersion)
        throw new AppError("FILE_VERSION_CONFLICT", 409);
      const result = await readNative(
        drive,
        input.fileId,
        input.kind,
        input.range,
      );
      const encoded = JSON.stringify(result);
      return {
        jsonFragment: encoded.slice(input.offset, input.offset + 8000),
        nextOffset:
          input.offset + 8000 < encoded.length ? input.offset + 8000 : null,
        version: file.version,
        revisionId: result.revisionId,
      };
    },
  ),
  tool(
    "drive_write_native_file",
    "Edit native documents. Docs/Slides require revisionId and an allowlisted batch. Sheets writes RAW values to a range. Unknown outcomes are never automatically replayed.",
    z
      .object({
        fileId: id,
        kind: z.enum(["docs", "sheets", "slides"]),
        revisionId: z.string().max(200).optional(),
        range: z.string().min(1).max(200).optional(),
        values: z
          .array(
            z
              .array(
                z.union([
                  z.string().max(9000),
                  z.number(),
                  z.boolean(),
                  z.null(),
                ]),
              )
              .max(100),
          )
          .max(100)
          .optional(),
        requests: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
        operationId,
      })
      .strict(),
    async (input, { client, drive }) => {
      const file = await authorize(drive, client, input.fileId, true);
      if (file.mimeType !== nativeKinds[input.kind])
        throw new AppError("NATIVE_TYPE_MISMATCH");
      if (JSON.stringify(input).length > 12000)
        throw new AppError("NATIVE_WRITE_TOO_LARGE");
      return mutation(
        client,
        input.operationId,
        { tool: "drive_write_native_file", ...input },
        () => writeNative(drive, input.fileId, input.kind, input),
      );
    },
    true,
  ),
];
export function toolCatalog() {
  return tools.map(({ name, description, schema, write }) => ({
    name,
    description,
    inputSchema: z.toJSONSchema(schema),
    annotations: {
      readOnlyHint: !write,
      destructiveHint: !!write,
      idempotentHint: !write,
      openWorldHint: true,
    },
  }));
}
export async function invokeTool(name: string, args: unknown, ctx: Context) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition) throw new AppError("TOOL_NOT_FOUND", 404);
  if (ctx.client.permitted_tools && !ctx.client.permitted_tools.includes(name))
    throw new AppError("TOOL_DENIED", 403);
  if (definition.write && !ctx.client.can_write)
    throw new AppError("WRITE_DENIED", 403);
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) throw new AppError("TOOL_ARGUMENTS_INVALID");
  return definition.run(parsed.data, ctx);
}
