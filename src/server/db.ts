import "server-only";
import { Pool, type PoolClient } from "pg";
import { config } from "./config";
let pool: Pool | undefined;
export function db() {
  return (pool ??= new Pool({
    connectionString: config().DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    ...(process.env.PG_CA
      ? { ssl: { ca: process.env.PG_CA, rejectUnauthorized: true } }
      : {}),
  }));
}
export async function transaction<T>(
  action: (connection: PoolClient) => Promise<T>,
) {
  const connection = await db().connect();
  try {
    await connection.query("BEGIN");
    const result = await action(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
