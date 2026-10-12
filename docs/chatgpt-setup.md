# Connect ChatGPT and other OAuth MCP clients

Google OAuth connects File MCP to Drive. MCP OAuth connects an AI client to File MCP. These are separate registrations and credentials.

## Upgrade the deployed service

1. Back up your database, and deploy the OAuth-enabled source only after preparing the schema.
2. In your Aiven SQL editor connected to `file_mcp`, execute the complete `migrations/002_mcp_oauth.sql`. It adds tables without replacing the existing schema. For a fresh database run `001_initial.sql` first. Alternatively inject `DATABASE_MIGRATOR_URL` and, when required, `PG_CA` into your local shell and run `pnpm db:migrate`; it applies the numbered idempotent SQL files in order. The command does not read `.env.local`.
3. If you use a separate runtime database role, grant it CRUD access to the new tables. New objects belong to the role running the migration, and earlier grants may not cover them.
4. Redeploy the updated source to Vercel Production. No new environment variables are needed; preserve your existing signing/encryption keys and Google credentials.
5. Check `/api/health`, `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource/api/mcp`. Unauthenticated `GET /api/mcp` must return 401 with a `WWW-Authenticate` header pointing to resource metadata. A configured health response does not verify migrations or Google connectivity.

For Aiven custom certificates, set `PG_CA` to the full PEM with actual newlines and remove SSL parameters (`sslmode`, `sslrootcert`, `sslcert`, `sslkey`, `ssl`) from both connection URLs. URL SSL parameters override the driver's supplied `PG_CA`. The app uses `PG_CA` with `rejectUnauthorized: true`; do not disable certificate verification.

## Register ChatGPT

1. In ChatGPT open Settings → Apps, enable Developer mode if available, and create a custom MCP app. Availability and workspace approval depend on your account.
2. Set the name to `Google Drive - File MCP`, server URL to `https://file-mgmt-mcp.vercel.app/api/mcp`, and authentication to OAuth. Select **User-Defined OAuth Client**.
3. Copy the **entire Callback URL** displayed by ChatGPT. It may vary between registrations; do not copy a truncated screenshot or invent its suffix.
4. In File MCP's operator dashboard, connect Google if needed. Create a dedicated folder permission client named `ChatGPT folders`; grant its approved folders and enable write permissions only where needed. This also generates a bearer token, which ChatGPT OAuth does not need. Keep it private.
5. Under **OAuth connections**, register an app named `ChatGPT`, select that folder permission client, paste the callback, and choose `client_secret_post` (or another method explicitly offered by both applications).
6. Copy the displayed **OAuth client ID and secret** immediately. The secret is shown once; only its hash is stored. Enter those in ChatGPT, and select the same token endpoint authentication method. Do not enter Google client credentials, the operator password, or the bearer token.
7. Complete ChatGPT's connection flow. Sign in with your File MCP operator password and review the folders and read/write permissions. Approve the connection.
8. Test listing approved roots, reading a dedicated test file, and denial outside the approved folders. For writes, use an isolated test folder and ask ChatGPT to create a small text file, then read it back.

The server advertises `mcp:read` and `mcp:write`. An omitted scope defaults to read-only. Write access requires both scopes, operator consent, the parent client's write capability, and the folder's write grant. If ChatGPT requests read-only scopes, the write tools will not be listed. Check the consent page rather than assuming the client requested write access.

## Other AI clients

Register each client separately with its exact callback URLs, selected permission client, and supported authentication method (`none` for public clients, `client_secret_post`, or `client_secret_basic`). Public clients still require PKCE S256. This release uses operator-managed registration; dynamic registration and URL-based client metadata are not implemented. Clients that require those features need an adapter or additional implementation. Existing Codex/agent-bot bearer-token configurations remain supported.

Clients must implement authorization code with PKCE S256, request the exact resource `https://file-mgmt-mcp.vercel.app/api/mcp` during authorization, and support remote Streamable HTTP. Supported protocol negotiation: `2025-03-26`, `2025-06-18`, `2025-11-25`. The service responds with JSON and uses stateless requests; authenticated GET streaming is not offered (405). Requests originating in a browser from another origin are rejected; server-to-server clients work without an Origin header.

Token and refresh requests may repeat that exact resource or omit it: the server uses the single resource already bound to the code/refresh grant. An explicitly different or empty resource is rejected. Scopes are compared as sets, so reversing their order does not change permissions. Extra scopes are rejected.

For a failure after consent, clear Vercel log filters and inspect `/oauth/token` followed by `/api/mcp`. Token failures log `mcp_oauth_token_failure` with only a safe error code. No token request indicates the callback/client side needs investigation; a 400/401 token response indicates exchange failure; a 200 token response followed by failed MCP requests indicates initialization/authentication failure. Do not share callback URLs containing codes or token request bodies.

## Lifetimes and revocation

Authorization requests expire after 10 minutes and are bound to the browser. Codes expire after 2 minutes and can be used once. Access tokens last at most 1 hour. Refresh tokens rotate on every exchange, and the authorization expires after 30 days regardless of refresh activity. Reconnect after that period. Valid replay of an already-used code or refresh token revokes the authorization, including its access tokens.

Dashboard **Revoke connection** disables one authorization. **Revoke app** disables all authorizations of that OAuth registration. Revoking the folder permission client disables its bearer credentials and OAuth registrations. Removing a folder grant or downgrading write access takes effect on subsequent requests. Adding folders or enabling additional tools does not expand an existing consent; connect again to approve additional access.

Treat OAuth secrets and bearer tokens as credentials. Replace a compromised OAuth registration by revoking it and registering a new one. Existing Google refresh tokens are unaffected by MCP OAuth revocation. Google app Testing mode may separately require reconnecting to Google every seven days.

## Binary files and limitations

MCP exposes download/export initiation and small base64 download chunks. Arbitrary binary uploads use the existing authenticated HTTP transfer endpoints; they require an AI client with a suitable HTTP/file-upload capability. OAuth alone does not let ChatGPT upload attachments through these raw endpoints. Text, native-document operations, and folders are available through MCP tools. Verify each client's attachment workflow separately.

No live ChatGPT connection is claimed by local tests. After deployment, complete the actual connection in your account using the steps above. If setup fails, inspect discovery, the exact callback, PKCE/resource parameters, client authentication method, and the database migration. Never publish tokens, secrets, or callback authorization codes in screenshots.

## Database maintenance

Expired requests are pruned during authorization. An operator-controlled maintenance job may remove expired grants (their code/token rows cascade) and expired requests, plus old OAuth rate-limit buckets. Keep used refresh-token records until their grant expires so replay detection continues to work. There is no new cron or background service requirement.
