import "server-only";
import type { PoolClient } from "pg";
import { db } from "./db";
import type { Client } from "./auth";
import { AppError } from "./errors";
import { FOLDER, SHORTCUT, type GoogleDrive, type DriveFile } from "./google";
export type Grant = { folder_id: string; name: string; can_write: boolean };
export async function grants(
  client: Client,
  connection: Pick<PoolClient, "query"> = db(),
): Promise<Grant[]> {
  const roots = (
    await connection.query<Grant>(
      "SELECT folder_id,name,can_write FROM root_grants WHERE client_id=$1",
      [client.id],
    )
  ).rows;
  if (!client.permitted_roots) return roots;
  return roots.flatMap((root) => {
    const approved = client.permitted_roots!.find(
      (value) => value.folder_id === root.folder_id,
    );
    return approved
      ? [{ ...root, can_write: root.can_write && approved.can_write }]
      : [];
  });
}
export async function checkAncestry(
  drive: Pick<GoogleDrive, "metadata">,
  id: string,
  roots: Grant[],
  write: boolean,
  clientWrite: boolean,
): Promise<DriveFile> {
  if (write && !clientWrite) throw new AppError("WRITE_DENIED", 403);
  const target = await drive.metadata(id);
  let current = target;
  const seen = new Set<string>();
  for (let depth = 0; depth < 100; depth++) {
    if (current.trashed || current.mimeType === SHORTCUT)
      throw new AppError("TARGET_DENIED", 403);
    if (seen.has(current.id)) throw new AppError("ANCESTRY_INVALID", 403);
    seen.add(current.id);
    const grant = roots.find(
      (root) => root.folder_id === current.id && (!write || root.can_write),
    );
    if (grant) {
      if (current.mimeType !== FOLDER) throw new AppError("ROOT_INVALID", 403);
      return target;
    }
    if (!current.parents || current.parents.length !== 1)
      throw new AppError("OUTSIDE_APPROVED_FOLDERS", 403);
    current = await drive.metadata(current.parents[0]);
  }
  throw new AppError("ANCESTRY_LIMIT", 403);
}
export async function authorize(
  drive: GoogleDrive,
  client: Client,
  id: string,
  write = false,
  folder = false,
  connection: Pick<PoolClient, "query"> = db(),
) {
  const file = await checkAncestry(
    drive,
    id,
    await grants(client, connection),
    write,
    client.can_write,
  );
  if (folder && file.mimeType !== FOLDER) throw new AppError("NOT_A_FOLDER");
  if (
    write &&
    (folder
      ? file.capabilities?.canAddChildren === false
      : file.capabilities?.canEdit === false)
  )
    throw new AppError("GOOGLE_PERMISSION_DENIED", 403);
  return file;
}
