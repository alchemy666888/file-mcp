import { AppError } from "./errors";
export const CHUNK_SIZE = 1024 * 1024;
export function utf8Prefix(bytes: Uint8Array, hasMore: boolean) {
  try {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes, { stream: hasMore });
    return { content, consumed: Buffer.byteLength(content, "utf8") };
  } catch {
    throw new AppError("TEXT_ENCODING_UNSUPPORTED");
  }
}
export async function sliceStream(
  response: Response,
  offset: number,
  length: number,
) {
  if (!response.body) throw new AppError("EMPTY_RESPONSE", 502);
  const reader = response.body.getReader();
  let position = 0;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (size < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const start = Math.max(0, offset - position);
      position += value.length;
      if (start < value.length) {
        const chunk = value.subarray(start, start + length - size);
        chunks.push(chunk);
        size += chunk.length;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export function isNative(mimeType: string) {
  return mimeType.startsWith("application/vnd.google-apps.");
}
export function isText(mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-yaml",
    ].includes(mimeType)
  );
}
