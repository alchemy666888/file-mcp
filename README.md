# File Management MCP

A Next.js service that gives [agent-bot](https://github.com/alchemy666888/agent-bot) read/write access to approved Google Drive folders and their descendants. One operator connects Google Drive. Each MCP client gets independent folder grants and read/write permissions.

## What is implemented

- Stateless Streamable HTTP MCP at `/api/mcp`, with protocol negotiation through `2025-11-25`.
- MCP OAuth discovery, operator-managed client registration, PKCE consent, expiring access tokens, rotating refresh tokens, and revocation for ChatGPT and compatible AI clients.
- Folder listing, metadata, paginated UTF-8 reads, text create/replace, folders and nested folder paths.
- Arbitrary binary uploads using resumable Google Drive sessions, authenticated 1 MiB chunks, persisted progress, optional MD5 verification, and paginated downloads.
- Native Google Docs, Sheets, and Slides creation, structured reads, supported native edits, and Google-supported exports.
- Operator login, Google OAuth, encrypted refresh tokens and upload-session URLs, per-client folder grants, credential revocation, and redacted operation history.
- PostgreSQL idempotency records, uncertain-write reconciliation, and short-lived tool-scoped credentials for agent-bot's Sandbox.
- An agent-bot integration patch and a command-line binary transfer client.

Stack matches agent-bot: Next.js 16, React 19, TypeScript 6, Node.js 22+, pnpm 10.28.1, PostgreSQL/`pg`, Zod, ESLint, Prettier, Vitest, and Playwright. No additional database, LLM, queue, or object-storage service is required.

## Local setup

1. Install Node.js 22+ and pnpm 10.28.1. Run `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to `.env.local`. Fill the Google OAuth client, database connection, and origin. Generate independent operator/session secrets with `openssl rand -hex 32` and the encryption key with `openssl rand -base64 32`. Never commit the values.
3. Run `DATABASE_MIGRATOR_URL=… pnpm db:migrate` in a shell with the privileged database URL injected. The migration command reads shell variables, not `.env.local`. Configure `PG_CA` if the provider requires a CA. Migrations are explicit and never run during build or requests.
4. Run `pnpm dev`, open `http://localhost:3000`, and sign in.
5. Connect Google, create a client, copy the one-time credential, and approve the root folders for that client.

Use a pooled PostgreSQL connection URL close to the Vercel region. The runtime requires CRUD rights on application tables and usage on the audit identity sequence; only the migration role needs schema creation privileges. Do not expose `DATABASE_MIGRATOR_URL` to the application runtime.

## Google configuration

In a Google Cloud project, enable Drive API, Docs API, Sheets API, and Slides API. Configure an OAuth consent screen and a Web application OAuth client. Register the exact callback:

```
https://YOUR_PROJECT.vercel.app/api/google/callback
```

Register `http://localhost:3000/api/google/callback` separately for local development. The callback must match `APP_URL` exactly. For a consent screen in Testing mode, add the operator as a test user; refresh tokens for this Drive scope may expire after seven days in that mode. Production availability and Google's restricted-scope verification requirements depend on the application's audience and publishing configuration.

The default scope is `https://www.googleapis.com/auth/drive`, needed to work with existing files in arbitrary approved folders. Google does not provide a folder-specific OAuth scope; this service enforces the folder boundary for every operation. `drive.file` can be configured for explicitly authorized app files, but selecting a folder does not grant that scope access to all existing descendants.

Only one Google connection is stored. Disconnect deletes local credentials and transfer sessions. To revoke the underlying Google authorization too, remove the app in your Google account's third-party access settings. Reconnecting with another account preserves folder grants; folders the new account cannot access fail closed. Token-key rotation requires decrypting and re-encrypting stored tokens and upload-session URLs before replacing the key; deleting the connection/transfers and reconnecting is the simpler alternative.

## Vercel Hobby deployment

1. Import this repository into a Vercel project with the Next.js preset and Node.js 22 or later. `vercel.json` selects `sin1`, `pnpm install --frozen-lockfile`, and `pnpm build`.
2. Provision a compatible PostgreSQL database and run the migration explicitly against it.
3. Set the runtime variables from `.env.example`, excluding the migrator URL. Set `APP_URL` to the assigned production HTTPS origin and register that exact Google callback.
4. Deploy, sign in, connect Google, create an MCP credential, and add folder grants.
5. Verify one allowed read, one outside-folder denial, and a create/read round trip in a dedicated test folder before enabling agent-bot access.

Use separate OAuth clients, database instances, keys, credentials, and folders for Preview and Production. Builds do not need Google or database credentials. `/api/health` reports configuration presence only; it does not claim that Google or PostgreSQL connectivity is healthy.

MCP and transfer functions have a 60-second maximum and bounded upstream timeouts. Transfer chunks are at most 1 MiB, below Vercel's 4.5 MB payload limit. Long files span many requests. Hobby is appropriate for personal/noncommercial use; provider quotas and PostgreSQL costs apply independently. No deployment or live Google verification is implied by the local test results.

## ChatGPT and OAuth clients

See [the step-by-step setup guide](docs/chatgpt-setup.md). Existing deployments must apply `migrations/002_mcp_oauth.sql` before deploying this version. No additional runtime environment variables are needed. Each OAuth registration uses a selected existing MCP client’s folder grants, with permissions bounded by explicit operator consent.

## MCP tools

See [integration/tool-catalog.json](integration/tool-catalog.json) for complete schemas and descriptions.

| Tools                                                                           | Behavior                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `drive_list_roots`, `drive_list_files`, `drive_get_file`                        | Discover only approved resources; metadata lists export formats  |
| `drive_read_file`, `drive_create_file`, `drive_update_file`                     | UTF-8 text; writes at most 9000 bytes; reads use byte offsets    |
| `drive_create_folder`, `drive_create_folder_path`                               | One folder or up to ten nested levels                            |
| `drive_begin_upload`, `drive_transfer_status`, `drive_complete_upload`          | Persisted resumable uploads and completion checks                |
| `drive_begin_download`, `drive_read_download_chunk`                             | Authorized download/export sessions; small base64 chunks for MCP |
| `drive_create_native_file`, `drive_read_native_file`, `drive_write_native_file` | Google Docs, Sheets, Slides through their dedicated APIs         |

Every mutation except resumable chunk submission/completion requires a stable `operationId`. Reuse it only for the same logical operation and identical arguments. Completed operations return their recorded result. Reusing an ID for different data returns `OPERATION_ID_CONFLICT`. A lost create-folder response is reconciled by its pre-generated Drive ID. Upload initialization can recover its persisted transfer. Writes with an uncertain outcome return `OPERATION_OUTCOME_UNKNOWN` and are never blindly replayed. Inspect the resource and audit history before deciding whether a new operation is appropriate.

Text update and binary replacement require `expectedVersion`. These are stale-read prechecks, **not atomic compare-and-swap**: external Google Drive writers can race. Use a dedicated automation folder or coordinate external writers. Native Docs/Slides edits require Google's `requiredRevisionId`; Sheets values writes use `RAW` and have no atomic revision guard.

Native reads return JSON fragments; reassemble them before JSON parsing and pass the returned file version for subsequent pages. Docs/Slides allowlisted batches support common text, style, table/slide/shape operations; unsupported edit requests are rejected. Other Google-native formats are discoverable and exportable where Google exposes a supported format, but do not have arbitrary native editing support. Google Drive exports have Google's 10 MB limit. Large native exports are fetched again for each requested slice; use binary files for large repeated transfers.

Shortcuts, trashed files, multiple-parent ancestry, and paths beyond 100 ancestor levels fail closed. Folder names are not unique in Drive. Nested folder creation rejects ambiguous matches instead of selecting an arbitrary item. There are no deletion, permission-change, public-sharing, or move tools.

## Binary transfers

Use `Authorization: Bearer YOUR_CLIENT_TOKEN` for MCP and transfer endpoints. Google access tokens and resumable URLs are never returned.

- Upload: `PUT /api/transfers/TRANSFER_ID?offset=N` with raw bytes. Maximum chunk size 1 MiB; all non-final chunks must be multiples of 256 KiB. Probe `drive_complete_upload` after a lost response, then resume from the returned offset. `UPLOAD_OFFSET_CONFLICT` means the supplied offset differs from Google's authoritative progress. Zero-byte uploads can be finalized through the completion probe.
- Download: `GET /api/transfers/TRANSFER_ID?offset=N&length=1048576`. Response is raw bytes; `x-next-offset` and `x-transfer-eof` control pagination. An external version change invalidates the download.
- Transfers expire after 24 hours. Credentials and grants are checked on each request. MD5 can be supplied to upload initialization and is checked against Google metadata at completion.

The CLI keeps entire files out of MCP responses:

```sh
# Inject FILE_MCP_URL and FILE_MCP_API_KEY into your shell first.
node scripts/transfer.mjs upload ./report.pdf --parent DRIVE_FOLDER_ID --mime application/pdf
node scripts/transfer.mjs download ./downloaded.pdf --file DRIVE_FILE_ID
node scripts/transfer.mjs download ./document.pdf --file GOOGLE_DOC_ID --export application/pdf
```

The uploader prints an operation ID. To resume after process interruption, rerun with `--operation THAT_ID` and the same file/options. Replace an existing binary with `--file FILE_ID --version VERSION` in place of `--parent`. Downloads exclusively create the local destination, preventing accidental overwrite. An interrupted download leaves a partial file; choose a new destination or explicitly remove the partial file before restarting.

## agent-bot integration

See [integration/README.md](integration/README.md). The provided patch targets agent-bot commit `b7c4117b4fc8dee78683f571fb4f03845debeed0`. It adds static code-owned capabilities, operator-selected tool names, per-user access, and short-lived worker credentials. It is supplied as a reviewable patch; the agent-bot repository is not changed remotely.

## Verification and operations

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Real PostgreSQL integration tests run when `TEST_DATABASE_URL` is set to an isolated test database. **They truncate application tables in that database. Never use production.** Google HTTP is mocked. Browser tests require a production build and test environment variables; see [docs/verification.md](docs/verification.md).

Audit rows contain tool names, client IDs, status codes, timings, and timestamps; no file content or credentials. Configure database backups. Retain operation records for as long as clients may retry; deleting them removes duplicate suppression. Expired transfer, delegation, OAuth-state, and old audit rows can be removed by an operator-controlled database maintenance job. Rate-limits for operator login use an IP bucket; your ingress should strip user-controlled forwarding headers. No long-lived state is kept in function memory.

Rollback: disable `FILE_MCP_ENABLED` in agent-bot or revoke its client credential, restore the previous Vercel deployment, and retain PostgreSQL operation records. Do not repeat unknown writes or restore an older idempotency database over a newer live Drive state without reconciliation.
