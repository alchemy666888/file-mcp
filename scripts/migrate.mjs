import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
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
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()) {
    await client.query(await readFile(new URL(file, directory), "utf8"));
  }
  await client.query("COMMIT");
  console.log("Migration complete.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
