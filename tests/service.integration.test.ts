import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/server/db";
import { hash, encrypt, decrypt } from "@/server/crypto";
import { handleMcp, PROTOCOL } from "@/server/mcp";
import { mutation } from "@/server/operations";
import { toolCatalog } from "@/server/tools";
import { GoogleDrive, FOLDER, type DriveFile } from "@/server/google";
import {
  uploadChunk,
  completeUpload,
  downloadChunk,
  getTransfer,
} from "@/server/transfers";
import { POST as delegate } from "@/app/api/delegations/route";
import { POST as connectGoogle } from "@/app/api/google/connect/route";
import { GET as googleCallback } from "@/app/api/google/callback/route";
import { makeSession, sessionName } from "@/server/auth";
const cookieJar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
  }),
}));
const token = "t".repeat(43);
const client = { id: randomUUID(), name: "agent-bot", can_write: true };
const files = new Map<string, DriveFile>();
let nextId = 0;
let loseFolderResponse = false;
const sessions = new Map<
  string,
  { file: DriveFile; total: number; bytes: Buffer; complete: boolean }
>();
function googleFixture(
  urlValue: string | URL | Request,
  options?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof urlValue === "string"
      ? urlValue
      : urlValue instanceof URL
        ? urlValue.href
        : urlValue.url,
  );
  const method = options?.method ?? "GET";
  if (url.hostname === "oauth2.googleapis.com")
    return Promise.resolve(
      Response.json({
        access_token: "test-access",
        refresh_token: "new-refresh-token",
      }),
    );
  if (url.pathname.endsWith("generateIds"))
    return Promise.resolve(Response.json({ ids: [`generated_${++nextId}`] }));
  if (
    url.pathname.startsWith("/upload/drive/") &&
    url.searchParams.has("uploadType")
  ) {
    const body = JSON.parse(String(options?.body));
    const id = body.id ?? url.pathname.split("/").pop()!;
    const file = body.id
      ? { ...body, version: "1", trashed: false }
      : files.get(id)!;
    const session = `session_${sessions.size}`;
    sessions.set(session, {
      file,
      total: Number(
        new Headers(options?.headers).get("x-upload-content-length"),
      ),
      bytes: Buffer.alloc(0),
      complete: false,
    });
    return Promise.resolve(
      new Response(null, {
        status: 200,
        headers: {
          location: `https://www.googleapis.com/upload/drive/session?upload_id=${session}`,
        },
      }),
    );
  }
  if (url.searchParams.has("upload_id")) {
    const session = sessions.get(url.searchParams.get("upload_id")!)!;
    const range = new Headers(options?.headers).get("content-range") ?? "";
    if (range.startsWith("bytes */")) {
      if (session.complete) return Promise.resolve(Response.json(session.file));
      return Promise.resolve(
        new Response(null, {
          status: 308,
          headers: session.bytes.length
            ? { range: `bytes=0-${session.bytes.length - 1}` }
            : {},
        }),
      );
    }
    const chunk = Buffer.from(options?.body as Uint8Array);
    session.bytes = Buffer.concat([session.bytes, chunk]);
    if (session.bytes.length === session.total) {
      session.complete = true;
      session.file = {
        ...session.file,
        size: String(session.total),
        md5Checksum: createHash("md5").update(session.bytes).digest("hex"),
        version: "2",
      };
      files.set(session.file.id, session.file);
      return Promise.resolve(Response.json(session.file));
    }
    return Promise.resolve(
      new Response(null, {
        status: 308,
        headers: { range: `bytes=0-${session.bytes.length - 1}` },
      }),
    );
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const body = JSON.parse(String(options?.body));
    const file = {
      ...body,
      id: body.id ?? `native_${++nextId}`,
      trashed: false,
      version: "1",
    };
    files.set(file.id, file);
    if (loseFolderResponse) {
      loseFolderResponse = false;
      return Promise.reject(new Error("connection lost after create"));
    }
    return Promise.resolve(Response.json(file));
  }
  if (url.pathname === "/drive/v3/files")
    return Promise.resolve(Response.json({ files: [] }));
  if (url.hostname === "docs.googleapis.com")
    return Promise.resolve(
      Response.json(
        method === "POST"
          ? {
              documentId: "doc",
              replies: [{}],
              writeControl: { requiredRevisionId: "revision2" },
            }
          : {
              documentId: "doc",
              revisionId: "revision1",
              body: { content: [] },
            },
      ),
    );
  if (url.hostname === "sheets.googleapis.com")
    return Promise.resolve(
      Response.json({ range: "Sheet1!A1", values: [["hello"]] }),
    );
  const id = decodeURIComponent(url.pathname.split("/").pop()!);
  const file = files.get(id);
  if (!file)
    return Promise.resolve(
      Response.json({ error: "missing" }, { status: 404 }),
    );
  if (url.searchParams.get("alt") === "media") {
    const stored = [...sessions.values()].find(
      (session) => session.file.id === id,
    )!.bytes;
    const range = new Headers(options?.headers)
      .get("range")
      ?.match(/bytes=(\d+)-(\d+)/);
    return Promise.resolve(
      new Response(
        new Uint8Array(
          stored.subarray(
            Number(range?.[1] ?? 0),
            Number(range?.[2] ?? stored.length - 1) + 1,
          ),
        ),
        { status: 206 },
      ),
    );
  }
  return Promise.resolve(Response.json(file));
}
async function rpc(method: string, params?: unknown, credential = token) {
  const response = await handleMcp(
    new Request("http://localhost:3000/api/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { response, body: await response.json() };
}
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "real PostgreSQL + mocked Google API integration",
  () => {
    beforeAll(async () => {
      await db().query(
        await readFile(
          new URL("../migrations/001_initial.sql", import.meta.url),
          "utf8",
        ),
      );
    });
    beforeAll(async () => {
      await db().query(
        await readFile(
          new URL("../migrations/002_mcp_oauth.sql", import.meta.url),
          "utf8",
        ),
      );
    });
    beforeEach(async () => {
      await db().query(
        "TRUNCATE delegated_sessions,audit_events,transfers,operations,root_grants,mcp_clients,google_connection,oauth_states,login_limits RESTART IDENTITY CASCADE",
      );
      await db().query(
        "INSERT INTO mcp_clients(id,name,token_hash,can_write) VALUES($1,'agent-bot',$2,true)",
        [client.id, hash(token)],
      );
      await db().query(
        "INSERT INTO root_grants(client_id,folder_id,name,can_write) VALUES($1,'root','Approved',true)",
        [client.id],
      );
      await db().query(
        "INSERT INTO google_connection(refresh_token) VALUES($1)",
        [encrypt("refresh-token")],
      );
      cookieJar.clear();
      files.clear();
      sessions.clear();
      loseFolderResponse = false;
      files.set("root", { id: "root", name: "Approved", mimeType: FOLDER });
      files.set("outside", {
        id: "outside",
        name: "Outside",
        mimeType: FOLDER,
      });
      vi.stubGlobal("fetch", vi.fn(googleFixture));
    });
    it("creates and paginates UTF-8 text without splitting characters", async () => {
      const created = await rpc("tools/call", {
        name: "drive_create_file",
        arguments: {
          parentId: "root",
          name: "unicode.txt",
          content: "a😀b",
          operationId: "unicode-text-create",
        },
      });
      expect(created.body.result.isError).toBe(false);
      const fileId = created.body.result.structuredContent.data.id;
      const first = await rpc("tools/call", {
        name: "drive_read_file",
        arguments: { fileId, limit: 4 },
      });
      expect(first.body.result.structuredContent.data.content).toBe("a");
      expect(first.body.result.structuredContent.data.nextOffset).toBe(1);
      const second = await rpc("tools/call", {
        name: "drive_read_file",
        arguments: { fileId, offset: 1, limit: 4 },
      });
      expect(second.body.result.structuredContent.data.content).toBe("😀");
      expect(second.body.result.structuredContent.data.nextOffset).toBe(5);
    });
    it("finishes zero-byte binary files and verifies checksums", async () => {
      const created = await rpc("tools/call", {
        name: "drive_begin_upload",
        arguments: {
          parentId: "root",
          name: "empty.bin",
          mimeType: "application/octet-stream",
          totalBytes: 0,
          expectedMd5: createHash("md5").digest("hex"),
          operationId: "zero-byte-upload",
        },
      });
      const transferId = created.body.result.structuredContent.data.transferId;
      const complete = await completeUpload(
        client,
        new GoogleDrive("access"),
        transferId,
      );
      expect(complete.status).toBe("complete");
      expect(complete.totalBytes).toBe(0);
    });
    it("creates and edits a native Google Doc using a required revision", async () => {
      const created = await rpc("tools/call", {
        name: "drive_create_native_file",
        arguments: {
          parentId: "root",
          name: "Native doc",
          kind: "docs",
          operationId: "native-create-operation",
        },
      });
      expect(created.body.result.isError).toBe(false);
      const fileId = created.body.result.structuredContent.data.id;
      const read = await rpc("tools/call", {
        name: "drive_read_native_file",
        arguments: { fileId, kind: "docs" },
      });
      expect(read.body.result.structuredContent.data.revisionId).toBe(
        "revision1",
      );
      const written = await rpc("tools/call", {
        name: "drive_write_native_file",
        arguments: {
          fileId,
          kind: "docs",
          revisionId: "revision1",
          requests: [{ insertText: { location: { index: 1 }, text: "hello" } }],
          operationId: "native-write-operation",
        },
      });
      expect(written.body.result.isError).toBe(false);
      const request = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, options]) =>
            String(url).includes(":batchUpdate") && options?.method === "POST",
        )!;
      expect(
        JSON.parse(String(request[1]?.body)).writeControl.requiredRevisionId,
      ).toBe("revision1");
    });
    it("binds Google OAuth to a single-use browser state and encrypts its refresh token", async () => {
      cookieJar.set(sessionName(), makeSession());
      const response = await connectGoogle(
        new Request("http://localhost:3000/api/google/connect", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        }),
      );
      expect(response.status).toBe(303);
      const state = new URL(response.headers.get("location")!).searchParams.get(
        "state",
      )!;
      cookieJar.set("file-mcp-oauth-state", state);
      const callback = () =>
        googleCallback(
          new Request(
            `http://localhost:3000/api/google/callback?state=${state}&code=test-code`,
          ),
        );
      expect((await callback()).status).toBe(303);
      const stored = (
        await db().query("SELECT refresh_token FROM google_connection")
      ).rows[0].refresh_token;
      expect(stored).not.toContain("new-refresh-token");
      expect(decrypt(stored)).toBe("new-refresh-token");
      expect((await callback()).status).toBe(403);
    });
    it("initializes and transfers three concurrent uploads without exhausting the connection pool", async () => {
      const results = await Promise.all(
        [0, 1, 2].map((index) =>
          rpc("tools/call", {
            name: "drive_begin_upload",
            arguments: {
              parentId: "root",
              name: `concurrent-${index}.bin`,
              mimeType: "application/octet-stream",
              totalBytes: 10,
              operationId: `concurrent-operation-${index}`,
            },
          }),
        ),
      );
      for (const result of results)
        expect(result.body.result.isError).toBe(false);
      await Promise.all(
        results.map((result) =>
          uploadChunk(
            client,
            new GoogleDrive("access"),
            result.body.result.structuredContent.data.transferId,
            0,
            Buffer.alloc(10),
          ),
        ),
      );
    });
    afterAll(async () => {
      vi.unstubAllGlobals();
      await db().end();
    });
    it("negotiates MCP and provides JSON schemas", async () => {
      const { body } = await rpc("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "agent-bot", version: "0.1" },
      });
      expect(body.result.protocolVersion).toBe(PROTOCOL);
      const catalog = await rpc("tools/list");
      expect(
        catalog.body.result.tools.map((tool: { name: string }) => tool.name),
      ).toEqual(
        expect.arrayContaining([
          "drive_create_folder",
          "drive_begin_upload",
          "drive_write_native_file",
        ]),
      );
      await mkdir("work", { recursive: true });
      await writeFile(
        "work/tool-catalog.json",
        JSON.stringify(toolCatalog(), null, 2),
      );
    });
    it("rejects missing bearer authorization and cross-origin requests", async () => {
      expect((await rpc("tools/list", {}, "invalid")).response.status).toBe(
        401,
      );
      const response = await handleMcp(
        new Request("http://localhost:3000/api/mcp", {
          method: "POST",
          headers: {
            origin: "https://evil.test",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      expect(response.status).toBe(403);
    });
    it("creates folders once across retries", async () => {
      const args = {
        parentId: "root",
        name: "Reports",
        operationId: "folder-operation-1",
      };
      const first = await rpc("tools/call", {
        name: "drive_create_folder",
        arguments: args,
      });
      const retry = await rpc("tools/call", {
        name: "drive_create_folder",
        arguments: args,
      });
      expect(first.body.result.isError).toBe(false);
      expect(retry.body.result.structuredContent).toEqual(
        first.body.result.structuredContent,
      );
      expect(files.size).toBe(3);
      expect((await db().query("SELECT * FROM audit_events")).rows.length).toBe(
        2,
      );
    });
    it("reconciles a lost response using a pre-generated file ID", async () => {
      loseFolderResponse = true;
      const args = {
        parentId: "root",
        name: "Reports",
        operationId: "lost-response-folder",
      };
      expect(
        (
          await rpc("tools/call", {
            name: "drive_create_folder",
            arguments: args,
          })
        ).body.result.isError,
      ).toBe(true);
      const retry = await rpc("tools/call", {
        name: "drive_create_folder",
        arguments: args,
      });
      expect(retry.body.result.isError).toBe(false);
      expect(files.size).toBe(3);
    });
    it("rejects operation ID reuse for different data", async () => {
      await mutation(client, "unique-operation", { value: 1 }, async () => ({
        ok: true,
      }));
      await expect(
        mutation(client, "unique-operation", { value: 2 }, async () => ({
          ok: true,
        })),
      ).rejects.toThrow("OPERATION_ID_CONFLICT");
    });
    it("never automatically repeats an unknown mutation", async () => {
      const action = vi.fn(async () => {
        throw new Error("timeout");
      });
      await expect(
        mutation(client, "unknown-operation", {}, action),
      ).rejects.toThrow("timeout");
      await expect(
        mutation(client, "unknown-operation", {}, action),
      ).rejects.toThrow("OPERATION_OUTCOME_UNKNOWN");
      expect(action).toHaveBeenCalledTimes(1);
    });
    it("denies folder escape without sending a mutation", async () => {
      const result = await rpc("tools/call", {
        name: "drive_create_folder",
        arguments: {
          parentId: "outside",
          name: "Forbidden",
          operationId: "denied-operation",
        },
      });
      expect(result.body.result.structuredContent.error).toBe(
        "OUTSIDE_APPROVED_FOLDERS",
      );
      expect(files.size).toBe(2);
    });
    it("creates and reads nested folders", async () => {
      const result = await rpc("tools/call", {
        name: "drive_create_folder_path",
        arguments: {
          rootId: "root",
          segments: ["Reports", "2026", "October"],
          operationId: "nested-folder-path",
        },
      });
      expect(result.body.result.structuredContent.data.folders).toHaveLength(3);
    });
    it("recovers a binary upload retry, verifies size and downloads chunks", async () => {
      const input = {
        parentId: "root",
        name: "sample.bin",
        mimeType: "application/octet-stream",
        totalBytes: 262144 + 123,
        operationId: "binary-upload-operation",
      };
      const begun = await rpc("tools/call", {
        name: "drive_begin_upload",
        arguments: input,
      });
      expect(begun.body.result.isError).toBe(false);
      const transferId = begun.body.result.structuredContent.data.transferId;
      const drive = new GoogleDrive("access");
      await uploadChunk(client, drive, transferId, 0, Buffer.alloc(262144, 3));
      await expect(
        uploadChunk(client, drive, transferId, 0, Buffer.alloc(262144, 3)),
      ).rejects.toThrow("UPLOAD_OFFSET_CONFLICT");
      await uploadChunk(
        client,
        drive,
        transferId,
        262144,
        Buffer.alloc(123, 4),
      );
      const complete = await completeUpload(client, drive, transferId);
      expect(complete.status).toBe("complete");
      expect((await getTransfer(client, transferId)).data.offset).toBe(
        input.totalBytes,
      );
      const download = await rpc("tools/call", {
        name: "drive_begin_download",
        arguments: { fileId: complete.fileId },
      });
      const slice = await downloadChunk(
        client,
        drive,
        download.body.result.structuredContent.data.transferId,
        262144,
        123,
      );
      expect(slice.bytes.equals(Buffer.alloc(123, 4))).toBe(true);
      expect(slice.eof).toBe(true);
    });
    it("rejects misaligned and cross-client upload chunks", async () => {
      const result = await rpc("tools/call", {
        name: "drive_begin_upload",
        arguments: {
          parentId: "root",
          name: "large.bin",
          mimeType: "application/octet-stream",
          totalBytes: 999999,
          operationId: "misaligned-upload",
        },
      });
      const id = result.body.result.structuredContent.data.transferId;
      await expect(
        uploadChunk(client, new GoogleDrive("access"), id, 0, Buffer.alloc(10)),
      ).rejects.toThrow("CHUNK_ALIGNMENT_INVALID");
      await expect(
        getTransfer({ ...client, id: randomUUID() }, id),
      ).rejects.toThrow("TRANSFER_NOT_FOUND");
    });
    it("bounds delegated tools and revokes sessions with the parent client", async () => {
      const response = await delegate(
        new Request("http://localhost:3000/api/delegations", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tools: ["drive_list_roots"], ttlSeconds: 60 }),
        }),
      );
      const session = await response.json();
      expect(response.status).toBe(200);
      expect(
        (
          await rpc(
            "tools/call",
            { name: "drive_list_roots", arguments: {} },
            session.token,
          )
        ).body.result.isError,
      ).toBe(false);
      expect(
        (
          await rpc(
            "tools/call",
            { name: "drive_get_file", arguments: { fileId: "root" } },
            session.token,
          )
        ).body.result.structuredContent.error,
      ).toBe("TOOL_DENIED");
      await db().query("UPDATE mcp_clients SET revoked=true WHERE id=$1", [
        client.id,
      ]);
      expect((await rpc("tools/list", {}, session.token)).response.status).toBe(
        401,
      );
    });
  },
);
