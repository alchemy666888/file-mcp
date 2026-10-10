import { randomBytes } from "node:crypto";
import { z } from "zod";
import { authenticate } from "@/server/auth";
import { boundedJson } from "@/server/body";
import { hash } from "@/server/crypto";
import { db } from "@/server/db";
import { AppError, errorResponse } from "@/server/errors";
import { tools } from "@/server/tools";
export async function POST(request: Request) {
  try {
    const client = await authenticate(request);
    if (client.permitted_tools) throw new AppError("DELEGATION_DENIED", 403);
    const parsed = z
      .object({
        tools: z.array(z.string()).min(1).max(30),
        ttlSeconds: z.number().int().min(30).max(600).default(300),
      })
      .strict()
      .safeParse(await boundedJson(request));
    if (!parsed.success) throw new AppError("INVALID_ARGUMENTS");
    const allowed = tools
      .filter((tool) => client.can_write || !tool.write)
      .map((tool) => tool.name);
    if (parsed.data.tools.some((name) => !allowed.includes(name)))
      throw new AppError("TOOL_DENIED", 403);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + parsed.data.ttlSeconds * 1000);
    await db().query("DELETE FROM delegated_sessions WHERE expires_at<now()");
    await db().query(
      "INSERT INTO delegated_sessions(token_hash,client_id,tools,expires_at) VALUES($1,$2,$3,$4)",
      [hash(token), client.id, parsed.data.tools, expiresAt],
    );
    return Response.json(
      { token, expiresAt },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
