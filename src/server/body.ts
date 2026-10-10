import { AppError } from "./errors";
export async function boundedBody(
  request: Request,
  limit = 1_500_000,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (declared > limit) throw new AppError("PAYLOAD_TOO_LARGE", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new AppError("PAYLOAD_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function boundedJson(request: Request) {
  try {
    return JSON.parse(new TextDecoder().decode(await boundedBody(request)));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_JSON");
  }
}
