import "server-only";
import { hash } from "./crypto";
import { db, transaction } from "./db";
import { AppError } from "./errors";
import type { Client } from "./auth";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function mutation<T>(
  client: Client,
  operationId: string,
  argumentsValue: unknown,
  action: (generatedId?: string) => Promise<T>,
  options?: {
    generate: () => Promise<string>;
    reconcile: (id: string) => Promise<T | undefined>;
  },
): Promise<T> {
  // Commit unknown outcomes rather than rolling them back: lost responses must not trigger blind replay.
  const outcome = await transaction(async (connection) => {
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`${client.id}:${operationId}`],
    );
    const digest = hash(canonical(argumentsValue));
    const record = (
      await connection.query(
        "SELECT * FROM operations WHERE client_id=$1 AND operation_id=$2 FOR UPDATE",
        [client.id, operationId],
      )
    ).rows[0];
    if (record && record.digest !== digest)
      return { error: new AppError("OPERATION_ID_CONFLICT", 409) };
    if (record?.state === "succeeded") return { value: record.result as T };
    if (record) return { existing: record };
    const generated = options ? await options.generate() : undefined;
    await connection.query(
      "INSERT INTO operations(client_id,operation_id,digest,state,generated_id) VALUES($1,$2,$3,'pending',$4)",
      [client.id, operationId, digest, generated],
    );
    // Persist intent before network I/O by using a separately committed intent below.
    return { intent: true as const, generated };
  });
  if ("error" in outcome) throw outcome.error;
  if ("value" in outcome) return outcome.value as T;
  if ("existing" in outcome) {
    if (options && outcome.existing.generated_id) {
      try {
        const result = await options.reconcile(outcome.existing.generated_id);
        if (result !== undefined) {
          await db().query(
            "UPDATE operations SET state='succeeded',result=$3,updated_at=now() WHERE client_id=$1 AND operation_id=$2",
            [client.id, operationId, JSON.stringify(result)],
          );
          return result;
        }
      } catch {
        /* Failed reconciliation never authorizes replay. */
      }
    }
    throw new AppError("OPERATION_OUTCOME_UNKNOWN", 409);
  }
  // Only the request that committed a new intent can execute. Network work holds no pool connection.
  try {
    const value = await action(outcome.generated);
    await db().query(
      "UPDATE operations SET state='succeeded',result=$3,updated_at=now() WHERE client_id=$1 AND operation_id=$2",
      [client.id, operationId, JSON.stringify(value)],
    );
    return value;
  } catch (error) {
    await db()
      .query(
        "UPDATE operations SET state='unknown',updated_at=now() WHERE client_id=$1 AND operation_id=$2 AND state<>'succeeded'",
        [client.id, operationId],
      )
      .catch(() => undefined);
    throw error;
  }
}
