import "server-only";
import { config } from "./config";
import { db } from "./db";
import { decrypt } from "./crypto";
import { AppError } from "./errors";
export const FOLDER = "application/vnd.google-apps.folder";
export const SHORTCUT = "application/vnd.google-apps.shortcut";
export const FILE_FIELDS =
  "id,name,mimeType,parents,trashed,size,version,modifiedTime,md5Checksum,capabilities,exportLinks";
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  trashed?: boolean;
  size?: string;
  version?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  exportLinks?: Record<string, string>;
  capabilities?: {
    canEdit?: boolean;
    canAddChildren?: boolean;
    canDownload?: boolean;
  };
};
export function allowedGoogleUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    ![
      "www.googleapis.com",
      "docs.googleapis.com",
      "sheets.googleapis.com",
      "slides.googleapis.com",
    ].includes(url.hostname)
  )
    throw new AppError("GOOGLE_URL_DENIED");
  return url;
}
export async function accessToken() {
  const result = await db().query(
    "SELECT refresh_token FROM google_connection WHERE singleton=true",
  );
  if (!result.rows[0]) throw new AppError("GOOGLE_NOT_CONNECTED", 503);
  const settings = config();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: settings.GOOGLE_CLIENT_ID,
      client_secret: settings.GOOGLE_CLIENT_SECRET,
      refresh_token: decrypt(result.rows[0].refresh_token),
    }),
    signal: AbortSignal.timeout(10000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new AppError("GOOGLE_RECONNECT_REQUIRED", 503);
  const body = await response.json();
  if (typeof body.access_token !== "string")
    throw new AppError("GOOGLE_TOKEN_INVALID", 502);
  return body.access_token as string;
}
export class GoogleDrive {
  private deadline = AbortSignal.timeout(40_000);
  constructor(private token: string) {}
  async request(
    url: string,
    options: RequestInit = {},
    accepted: number[] = [],
  ) {
    allowedGoogleUrl(url);
    const response = await fetch(url, {
      ...options,
      headers: {
        ...Object.fromEntries(new Headers(options.headers)),
        authorization: `Bearer ${this.token}`,
      },
      signal: AbortSignal.any([this.deadline, AbortSignal.timeout(25000)]),
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok && !accepted.includes(response.status)) {
      await response.body?.cancel();
      if (response.status === 404) throw new AppError("FILE_NOT_FOUND", 404);
      if (response.status === 403)
        throw new AppError("GOOGLE_PERMISSION_DENIED", 403);
      if (response.status === 429)
        throw new AppError("GOOGLE_RATE_LIMITED", 429);
      if (response.status === 401)
        throw new AppError("GOOGLE_RECONNECT_REQUIRED", 503);
      throw new AppError("GOOGLE_REQUEST_FAILED", 502);
    }
    return response;
  }
  async json<T>(url: string, options: RequestInit = {}): Promise<T> {
    return (await this.request(url, options)).json();
  }
  metadata(id: string): Promise<DriveFile> {
    return this.json(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
    );
  }
  async generateId() {
    const value = await this.json<{ ids: string[] }>(
      "https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files",
    );
    if (!value.ids[0]) throw new AppError("GOOGLE_REQUEST_FAILED", 502);
    return value.ids[0];
  }
  list(folder: string, pageToken?: string, name?: string) {
    const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const query = new URLSearchParams({
      q: `'${escape(folder)}' in parents and trashed=false${name === undefined ? "" : ` and name='${escape(name)}'`}`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: "50",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    return this.json<{ files: DriveFile[]; nextPageToken?: string }>(
      `https://www.googleapis.com/drive/v3/files?${query}`,
    );
  }
  createFolder(id: string, parent: string, name: string) {
    return this.json<DriveFile>(
      `https://www.googleapis.com/drive/v3/files?fields=${FILE_FIELDS}&supportsAllDrives=true`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, parents: [parent], name, mimeType: FOLDER }),
      },
    );
  }
  async beginUpload(file: {
    id: string;
    parent?: string;
    name?: string;
    mimeType: string;
    total: number;
    update?: boolean;
  }) {
    const endpoint = file.update
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(file.id)}`
      : "https://www.googleapis.com/upload/drive/v3/files";
    const response = await this.request(
      `${endpoint}?uploadType=resumable&fields=${FILE_FIELDS}&supportsAllDrives=true`,
      {
        method: file.update ? "PATCH" : "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-content-type": file.mimeType,
          "x-upload-content-length": String(file.total),
        },
        body: JSON.stringify(
          file.update
            ? {}
            : {
                id: file.id,
                name: file.name,
                parents: [file.parent],
                mimeType: file.mimeType,
              },
        ),
      },
    );
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new AppError("UPLOAD_SESSION_INVALID", 502);
    const url = allowedGoogleUrl(location);
    if (
      url.hostname !== "www.googleapis.com" ||
      !url.pathname.startsWith("/upload/drive/")
    )
      throw new AppError("UPLOAD_SESSION_INVALID", 502);
    return location;
  }
}
