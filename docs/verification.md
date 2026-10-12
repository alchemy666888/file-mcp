# Implementation and verification record

Verified locally on 10 October 2026. Google HTTP calls were mocked; PostgreSQL 17 ran in an isolated disposable Docker container. No production credentials or user files were used.

| Check                                              | Result                         |
| -------------------------------------------------- | ------------------------------ |
| Service unit and PostgreSQL integration tests      | 33 passed                      |
| agent-bot worker adapter and delegation tests      | 7 passed                       |
| Chromium operator flow and mobile layout           | 2 passed                       |
| Next.js production build                           | Passed                         |
| TypeScript application checks                      | Passed during production build |
| Standalone adapter TypeScript check                | Passed                         |
| ESLint                                             | Passed                         |
| Prettier                                           | Passed                         |
| Integration patch applies to clean upstream commit | Passed                         |

The backend tests cover ancestry boundaries, read-only grants, shortcuts, trashed files, moved files, encryption tampering, session tampering, payload bounds, UTF-8 pagination, protocol negotiation, uncertain mutations, duplicate suppression, nested folders, resumable binary transfers, cross-client isolation, zero-byte uploads, checksums, native document writes, Google OAuth state replay, scoped sessions, credential revocation, and concurrent uploads with a three-connection pool.

The browser tests verify responsive rendering, authentication-required redirects, operator sign-in, client creation, one-time bearer display, and logout. They found a real browser origin issue caused by `Referrer-Policy: no-referrer` on the login form. The general policy now uses `strict-origin-when-cross-origin`; Google callback redirects retain `no-referrer`.

## MCP OAuth update — 12 October 2026

Verified the updated source with PostgreSQL 17 and mocked Google APIs:

- 57 service/security/OAuth tests passed, including PKCE, exact callbacks, resource binding, code/refresh replay, concurrent refresh, expiry, browser-bound consent, scope restrictions, permission ceilings, revocation, and OAuth transfer/idempotency isolation.
- 7 existing agent-bot adapter/delegation tests passed.
- 3 Chromium tests passed, including operator-managed OAuth registration, one-time secret display, login return to consent, authorization-code exchange, MCP tool listing, and revocation.
- Next.js production build, TypeScript, ESLint, and Prettier checks passed.

The OAuth database migration was exercised against an existing initial schema. No production database, Google account, Vercel environment, or live ChatGPT connection was used. ChatGPT account setup and live acceptance remain necessary after deployment; see [the setup guide](chatgpt-setup.md).

## Reproduce service tests

Run `pnpm test` for unit tests. PostgreSQL integration tests are skipped unless `TEST_DATABASE_URL` is supplied. Provision an isolated database, then run:

```sh
TEST_DATABASE_URL=postgresql://YOUR_ISOLATED_TEST_DATABASE pnpm test
```

**The integration suite truncates application tables. Never set the test URL to a production database.** Tests use a mocked Google API and test-only environment values from `tests/setup.ts`.

For browser tests, first run `pnpm build`. Inject `APP_URL=http://localhost:3000`, `DATABASE_URL` and `TEST_DATABASE_URL` pointing to the isolated test database, test operator/session/encryption secrets, and test Google client values. Run `pnpm test:e2e`. Set `CHROMIUM_PATH` to a system Chromium binary, or install Playwright Chromium with `pnpm exec playwright install chromium`. The web-server fixture starts the production application and inherits the supplied test environment.

## Live acceptance still required

- Connect the real operator account through Google OAuth.
- Verify existing files in each approved folder and an outside-folder denial.
- Create a nested folder, a text file, and a binary transfer in a dedicated test root. Compare upload/download bytes and checksums.
- Exercise Docs/Sheets/Slides reads, edits, and exports with the enabled Google APIs and consent scopes.
- Confirm revoked credentials, shared-drive permissions, and interrupted upload recovery against Google's real responses.
- Configure the Vercel project and PostgreSQL provider, run migrations, and verify the deployed endpoints.
- Apply the agent-bot patch, run its existing acceptance suite, and verify a live allowlisted private Telegram chat and Sandbox turn.

Shared Drive parameters are implemented, but live Shared Drive access has not been verified. Generic Drive version prechecks cannot prevent races with external writers. Google-native editing is limited to the documented APIs and allowlisted operations; unsupported native types remain metadata/export only.

No Vercel deployment or live Google/Sandbox/Telegram success is claimed by these results. The implementation and upstream integration patch are complete for configuration and live acceptance.
