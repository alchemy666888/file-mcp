import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    parent: { type: "string" },
    file: { type: "string" },
    version: { type: "string" },
    mime: { type: "string" },
    operation: { type: "string" },
    export: { type: "string" },
  },
});
const [mode, path] = positionals;
if (!["upload", "download"].includes(mode) || !path)
  throw new Error(
    "Usage: node scripts/transfer.mjs upload LOCAL_PATH --parent FOLDER_ID [--mime MIME] [--operation ID], or download LOCAL_PATH --file FILE_ID [--export MIME]",
  );
const endpoint = new URL(process.env.FILE_MCP_URL ?? "");
if (
  endpoint.protocol !== "https:" &&
  !(endpoint.protocol === "http:" && endpoint.hostname === "localhost")
)
  throw new Error("Use an HTTPS FILE_MCP_URL ending in /api/mcp");
if (
  endpoint.pathname !== "/api/mcp" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error("Invalid FILE_MCP_URL");
const key = process.env.FILE_MCP_API_KEY;
if (!key) throw new Error("FILE_MCP_API_KEY is required");
const headers = {
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-11-25",
};
let nextId = 1;
async function rpc(method, params, id = nextId++) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  if (id === null) {
    await response.body?.cancel();
    return;
  }
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}
async function call(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(result.structuredContent.error);
  return result.structuredContent.data;
}
await rpc("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "file-mcp-transfer-cli", version: "0.1.0" },
});
// Send the notification without an ID.
await fetch(endpoint, {
  method: "POST",
  headers,
  body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  redirect: "error",
  signal: AbortSignal.timeout(10000),
}).then(async (response) => {
  if (response.status !== 202) throw new Error("MCP initialization failed");
  await response.body?.cancel();
});
if (mode === "upload") {
  const size = (await stat(path)).size;
  const digest = createHash("md5");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const operation = values.operation ?? randomUUID();
  console.log(`Operation ID: ${operation}`);
  const transfer = await call("drive_begin_upload", {
    ...(values.file
      ? { fileId: values.file, expectedVersion: values.version }
      : { parentId: values.parent, name: basename(path) }),
    mimeType: values.mime ?? "application/octet-stream",
    totalBytes: size,
    expectedMd5: digest.digest("hex"),
    operationId: operation,
  });
  let progress = await call("drive_complete_upload", {
    transferId: transfer.transferId,
  });
  const handle = await open(path, "r");
  let failures = 0;
  try {
    while (progress.status !== "complete" && progress.offset < size) {
      const buffer = Buffer.alloc(
        Math.min(1024 * 1024, size - progress.offset),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        progress.offset,
      );
      if (bytesRead !== buffer.length)
        throw new Error("Local file changed during upload");
      try {
        const response = await fetch(
          new URL(
            `/api/transfers/${transfer.transferId}?offset=${progress.offset}`,
            endpoint,
          ),
          {
            method: "PUT",
            headers: {
              authorization: headers.authorization,
              "content-type": "application/octet-stream",
            },
            body: buffer,
            redirect: "error",
            signal: AbortSignal.timeout(60000),
          },
        );
        if (!response.ok) throw new Error(`Upload HTTP ${response.status}`);
        progress = await response.json();
        failures = 0;
      } catch (error) {
        if (++failures > 3) throw error;
        progress = await call("drive_complete_upload", {
          transferId: transfer.transferId,
        });
      }
      console.log(`${progress.offset} / ${size} bytes`);
      if (progress.offset >= size) break;
    }
    const completed = await call("drive_complete_upload", {
      transferId: transfer.transferId,
    });
    if (completed.status !== "complete") throw new Error("Upload not complete");
    console.log(JSON.stringify(completed.file, null, 2));
  } finally {
    await handle.close();
  }
} else {
  if (!values.file) throw new Error("--file FILE_ID is required");
  const transfer = await call("drive_begin_download", {
    fileId: values.file,
    ...(values.export ? { exportMimeType: values.export } : {}),
  });
  // Exclusive creation prevents overwriting an existing local file.
  const handle = await open(path, "wx");
  let offset = 0;
  try {
    while (true) {
      const response = await fetch(
        new URL(
          `/api/transfers/${transfer.transferId}?offset=${offset}`,
          endpoint,
        ),
        {
          headers: { authorization: headers.authorization },
          redirect: "error",
          signal: AbortSignal.timeout(60000),
        },
      );
      if (!response.ok) throw new Error(`Download HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await handle.write(bytes);
      offset += bytes.length;
      if (response.headers.get("x-transfer-eof") === "true") break;
      if (!bytes.length) throw new Error("Empty chunk without EOF");
    }
    console.log(`Downloaded ${offset} bytes to ${path}`);
  } finally {
    await handle.close();
  }
}
