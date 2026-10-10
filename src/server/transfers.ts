import "server-only";
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { Client } from "./auth";
import { db, transaction } from "./db";
import { encrypt, decrypt } from "./crypto";
import { AppError } from "./errors";
import { FILE_FIELDS, type GoogleDrive, type DriveFile } from "./google";
import { authorize } from "./policy";
import { CHUNK_SIZE, isNative, sliceStream } from "./content";
export type TransferData = {
  fileId: string;
  parentId?: string;
  mimeType: string;
  total: number;
  session?: string;
  offset: number;
  completed?: DriveFile;
  exportMimeType?: string;
  expectedVersion?: string;
  expectedMd5?: string;
  operationId?: string;
  update?: boolean;
};
export type Transfer = {
  id: string;
  kind: "upload" | "download";
  data: TransferData;
  expires_at: Date;
};
export function publicTransfer(transfer: Transfer) {
  return {
    transferId: transfer.id,
    kind: transfer.kind,
    fileId: transfer.data.fileId,
    totalBytes: transfer.data.total,
    offset: transfer.data.offset,
    completed: transfer.data.completed,
    expiresAt: transfer.expires_at,
    chunkBytes: CHUNK_SIZE,
  };
}
export async function saveTransfer(
  client: Client,
  kind: Transfer["kind"],
  data: TransferData,
) {
  const id = randomUUID();
  const expires = new Date(Date.now() + 86400000);
  await db().query(
    "INSERT INTO transfers(id,client_id,kind,data,expires_at) VALUES($1,$2,$3,$4,$5)",
    [id, client.id, kind, JSON.stringify(data), expires],
  );
  return publicTransfer({ id, kind, data, expires_at: expires });
}
export async function getTransfer(
  client: Client,
  id: string,
): Promise<Transfer> {
  const row = (
    await db().query<Transfer>(
      "SELECT id,kind,data,expires_at FROM transfers WHERE id=$1 AND client_id=$2 AND expires_at>now()",
      [id, client.id],
    )
  ).rows[0];
  if (!row) throw new AppError("TRANSFER_NOT_FOUND", 404);
  return row;
}
async function transferPermission(
  drive: GoogleDrive,
  client: Client,
  data: TransferData,
  write: boolean,
  connection: PoolClient,
) {
  if (write && !data.update)
    return authorize(drive, client, data.parentId!, true, true, connection);
  return authorize(drive, client, data.fileId, write, false, connection);
}
export async function uploadStatus(drive: GoogleDrive, data: TransferData) {
  if (data.completed) return;
  const response = await drive.request(
    decrypt(data.session!),
    {
      method: "PUT",
      headers: {
        ...(data.total === 0
          ? { "content-type": data.mimeType }
          : { "content-range": `bytes */${data.total}` }),
        "content-length": "0",
      },
      ...(data.total === 0 ? { body: Buffer.alloc(0) } : {}),
    },
    [308],
  );
  if (response.status === 308) {
    const range = response.headers.get("range");
    if (range && !/^bytes=0-\d+$/.test(range)) {
      await response.body?.cancel();
      throw new AppError("UPLOAD_RANGE_INVALID", 502);
    }
    data.offset = range
      ? Number(range.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1
      : 0;
    if (data.offset > data.total)
      throw new AppError("UPLOAD_RANGE_INVALID", 502);
    await response.body?.cancel();
  } else {
    data.completed = await response.json();
    data.offset = data.total;
  }
}
export async function uploadChunk(
  client: Client,
  drive: GoogleDrive,
  id: string,
  offset: number,
  bytes: Uint8Array,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    bytes.length > CHUNK_SIZE ||
    bytes.length === 0
  )
    throw new AppError("CHUNK_INVALID");
  return transaction(async (connection) => {
    const transfer = (
      await connection.query<Transfer>(
        "SELECT id,kind,data,expires_at FROM transfers WHERE id=$1 AND client_id=$2 AND expires_at>now() FOR UPDATE",
        [id, client.id],
      )
    ).rows[0];
    if (!transfer || transfer.kind !== "upload")
      throw new AppError("TRANSFER_NOT_FOUND", 404);
    const data = transfer.data;
    await transferPermission(drive, client, data, true, connection);
    await uploadStatus(drive, data);
    if (data.completed) {
      await connection.query("UPDATE transfers SET data=$2 WHERE id=$1", [
        id,
        JSON.stringify(data),
      ]);
      return publicTransfer(transfer);
    }
    if (offset !== data.offset)
      throw new AppError("UPLOAD_OFFSET_CONFLICT", 409);
    if (
      offset + bytes.length > data.total ||
      (offset + bytes.length < data.total && bytes.length % (256 * 1024) !== 0)
    )
      throw new AppError("CHUNK_ALIGNMENT_INVALID");
    if (data.update && data.expectedVersion && offset === 0) {
      const current = await authorize(
        drive,
        client,
        data.fileId,
        true,
        false,
        connection,
      );
      if (current.version !== data.expectedVersion)
        throw new AppError("FILE_VERSION_CONFLICT", 409);
    }
    const response = await drive.request(
      decrypt(data.session!),
      {
        method: "PUT",
        headers: {
          "content-type": data.mimeType,
          "content-range": `bytes ${offset}-${offset + bytes.length - 1}/${data.total}`,
        },
        body: Buffer.from(bytes),
      },
      [308],
    );
    if (response.status === 308) {
      const range = response.headers.get("range");
      if (!range || !/^bytes=0-\d+$/.test(range))
        throw new AppError("UPLOAD_RANGE_INVALID", 502);
      data.offset = Number(range.split("-")[1]) + 1;
      await response.body?.cancel();
    } else {
      data.completed = await response.json();
      data.offset = data.total;
    }
    await connection.query("UPDATE transfers SET data=$2 WHERE id=$1", [
      id,
      JSON.stringify(data),
    ]);
    return publicTransfer(transfer);
  });
}
export async function completeUpload(
  client: Client,
  drive: GoogleDrive,
  id: string,
) {
  return transaction(async (connection) => {
    const transfer = (
      await connection.query<Transfer>(
        "SELECT id,kind,data,expires_at FROM transfers WHERE id=$1 AND client_id=$2 AND expires_at>now() FOR UPDATE",
        [id, client.id],
      )
    ).rows[0];
    if (!transfer || transfer.kind !== "upload")
      throw new AppError("TRANSFER_NOT_FOUND", 404);
    await transferPermission(drive, client, transfer.data, true, connection);
    await uploadStatus(drive, transfer.data);
    await connection.query("UPDATE transfers SET data=$2 WHERE id=$1", [
      id,
      JSON.stringify(transfer.data),
    ]);
    if (!transfer.data.completed)
      return { ...publicTransfer(transfer), status: "incomplete" as const };
    const metadata = await authorize(
      drive,
      client,
      transfer.data.fileId,
      true,
      false,
      connection,
    );
    if (
      metadata.size !== undefined &&
      Number(metadata.size) !== transfer.data.total
    )
      throw new AppError("UPLOAD_SIZE_MISMATCH", 409);
    if (
      transfer.data.expectedMd5 &&
      metadata.md5Checksum !== transfer.data.expectedMd5
    )
      throw new AppError("UPLOAD_CHECKSUM_MISMATCH", 409);
    return {
      ...publicTransfer(transfer),
      status: "complete" as const,
      file: metadata,
    };
  });
}
export async function downloadChunk(
  client: Client,
  drive: GoogleDrive,
  id: string,
  offset: number,
  length = CHUNK_SIZE,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > CHUNK_SIZE
  )
    throw new AppError("CHUNK_INVALID");
  const transfer = await getTransfer(client, id);
  if (transfer.kind !== "download")
    throw new AppError("TRANSFER_NOT_FOUND", 404);
  const file = await authorize(drive, client, transfer.data.fileId);
  if (file.version !== transfer.data.expectedVersion)
    throw new AppError("FILE_VERSION_CONFLICT", 409);
  let bytes: Buffer;
  if (isNative(file.mimeType)) {
    if (offset > 10 * 1024 * 1024) throw new AppError("EXPORT_SIZE_LIMIT");
    const response = await drive.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(transfer.data.exportMimeType!)}`,
    );
    bytes = await sliceStream(response, offset, length);
  } else {
    if (offset >= transfer.data.total)
      return {
        bytes: Buffer.alloc(0),
        mimeType: transfer.data.mimeType,
        eof: true,
      };
    const response = await drive.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      {
        headers: {
          range: `bytes=${offset}-${Math.min(offset + length - 1, transfer.data.total - 1)}`,
        },
      },
    );
    if (offset > 0 && response.status !== 206) {
      await response.body?.cancel();
      throw new AppError("RANGE_NOT_SUPPORTED", 502);
    }
    bytes = await sliceStream(response, 0, length);
  }
  return {
    bytes,
    mimeType: transfer.data.mimeType,
    eof:
      bytes.length < length ||
      (!isNative(file.mimeType) &&
        offset + bytes.length >= transfer.data.total),
  };
}
export async function beginDownload(
  client: Client,
  drive: GoogleDrive,
  fileId: string,
  exportMimeType?: string,
) {
  const file = await authorize(drive, client, fileId);
  if (file.capabilities?.canDownload === false)
    throw new AppError("DOWNLOAD_DENIED", 403);
  if (
    isNative(file.mimeType) &&
    (!exportMimeType || !file.exportLinks?.[exportMimeType])
  )
    throw new AppError("EXPORT_FORMAT_REQUIRED_OR_UNSUPPORTED");
  return saveTransfer(client, "download", {
    fileId,
    mimeType: exportMimeType ?? file.mimeType,
    total: Number(file.size ?? 0),
    offset: 0,
    expectedVersion: file.version,
    exportMimeType,
  });
}
export async function recoverUpload(client: Client, operationId: string) {
  const transfer = (
    await db().query<Transfer>(
      "SELECT id,kind,data,expires_at FROM transfers WHERE client_id=$1 AND kind='upload' AND data->>'operationId'=$2 AND expires_at>now() ORDER BY created_at DESC LIMIT 1",
      [client.id, operationId],
    )
  ).rows[0];
  return transfer ? publicTransfer(transfer) : undefined;
}
export async function createUpload(
  client: Client,
  drive: GoogleDrive,
  input: {
    fileId: string;
    parentId?: string;
    name?: string;
    mimeType: string;
    totalBytes: number;
    update?: boolean;
    expectedVersion?: string;
    expectedMd5?: string;
    operationId?: string;
  },
) {
  if (isNative(input.mimeType)) throw new AppError("USE_NATIVE_DOCUMENT_TOOL");
  const session = await drive.beginUpload({
    id: input.fileId,
    parent: input.parentId,
    name: input.name,
    mimeType: input.mimeType,
    total: input.totalBytes,
    update: input.update,
  });
  return saveTransfer(client, "upload", {
    fileId: input.fileId,
    parentId: input.parentId,
    mimeType: input.mimeType,
    total: input.totalBytes,
    offset: 0,
    session: encrypt(session),
    update: input.update,
    expectedVersion: input.expectedVersion,
    expectedMd5: input.expectedMd5,
    operationId: input.operationId,
  });
}
export { FILE_FIELDS };
