import "server-only";
import { z } from "zod";
const schema = z.object({
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  DASHBOARD_SECRET: z.string().min(32),
  SESSION_SIGNING_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_OAUTH_SCOPE: z
    .enum([
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/drive.file",
    ])
    .default("https://www.googleapis.com/auth/drive"),
});
export function config() {
  const value = schema.parse(process.env);
  const url = new URL(value.APP_URL);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        url.hostname === "localhost" &&
        !process.env.VERCEL
      ))
  )
    throw new Error(
      "APP_URL must be an HTTPS origin (localhost allowed in development)",
    );
  return { ...value, APP_URL: url.origin };
}
export function configured() {
  try {
    config();
    return true;
  } catch {
    return false;
  }
}
