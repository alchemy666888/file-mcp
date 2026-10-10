import pg from "pg";
import { readFile } from "node:fs/promises";
const connectionString = process.env.DATABASE_MIGRATOR_URL;
if (!connectionString)
  throw new Error(
    "DATABASE_MIGRATOR_URL is required; migrations never run automatically.",
  );
const client = new pg.Client({
  connectionString,
  ...(process.env.PG_CA
    ? { ssl: { ca: process.env.PG_CA, rejectUnauthorized: true } }
    : {}),
});
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(
    await readFile(
      new URL("../migrations/001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  await client.query("COMMIT");
  console.log("Migration complete.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
