# Connect agent-bot

`agent-bot.patch` targets the inspected agent-bot commit `b7c4117b4fc8dee78683f571fb4f03845debeed0`. It registers this service's static MCP catalog with `CapabilityRegistry`, expands the code-owned capability IDs, adds a server-side credential delegation helper, and sends scoped 5-minute sessions to the Sandbox for allowed private-chat users.

Apply in your agent-bot checkout:

```sh
git apply --check /path/to/file-mcp/integration/agent-bot.patch
git apply /path/to/file-mcp/integration/agent-bot.patch
```

Configure agent-bot with:

| Variable               | Value                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `FILE_MCP_ENABLED`     | Start with `false`; enable after test-folder verification                   |
| `FILE_MCP_URL`         | `https://YOUR_FILE_MCP_PROJECT.vercel.app/api/mcp`                          |
| `FILE_MCP_API_KEY`     | Permanent one-time client credential from File MCP's dashboard; server-only |
| `FILE_MCP_ALLOW_USERS` | Explicit comma-separated numeric Telegram user IDs                          |
| `FILE_MCP_TOOLS`       | Explicit comma-separated names from `tool-catalog.json`                     |

Start with read tools, then add writes only when the MCP client and folder grants both permit them. An empty user/tool list gives no worker access. Group chats receive no File MCP session. The permanent key and Google tokens are never placed in worker request files or model prompts. Short-lived sessions travel only in the worker process environment, inherit their client's folder grants, are tool-scoped, cannot mint new sessions, and stop working when their parent client is revoked.

Registering capabilities makes them available to the general router; installed skills still require the repository's operator capability grants and release gates. Tool availability does not enable routing or installed skills automatically. Preserve agent-bot's existing controls and acceptance process. Upload bytes are transferred by a trusted client/CLI, not embedded in prompts; agent-bot's current text-only Telegram flow does not become a media-upload handler through this patch.

Verification:

- Run the new worker adapter tests and existing capability, security, dispatch, and worker-bundle checks.
- Use a dedicated MCP client and test folders. Verify an allowlisted private-chat user can list approved files, another user gets no capabilities, and group chats get no session.
- Verify outside-root denial, revocation, retries with stable operation IDs, and a text create/read round trip.
- Rebuild/redeploy agent-bot before enabling the flag.

The adapter test file is included in the patch. Local File MCP verification also runs that test against the cloned source. The complete upstream acceptance suite and a live Sandbox/Telegram run remain dependent on its credentials and infrastructure.
