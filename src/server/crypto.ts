import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function equal(left: string, right: string) {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config().TOKEN_ENCRYPTION_KEY, "base64"),
    iv,
  );
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function decrypt(value: string) {
  const bytes = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(config().TOKEN_ENCRYPTION_KEY, "base64"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}
export function sign(value: string) {
  return createHmac("sha256", config().SESSION_SIGNING_SECRET)
    .update(value)
    .digest("base64url");
}
