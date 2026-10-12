import { isOperator } from "@/server/auth";
import { consentDetails } from "@/server/oauth";
export const dynamic = "force-dynamic";
export default async function Consent({
  searchParams,
}: {
  searchParams: Promise<{ request?: string }>;
}) {
  const { request: id = "" } = await searchParams;
  let details;
  try {
    details = await consentDetails(id);
  } catch {
    return (
      <main className="workspace">
        <section className="panel">
          <h1>Connection request expired</h1>
          <p>Return to your AI app and start connecting again.</p>
        </section>
      </main>
    );
  }
  if (!(await isOperator()))
    return (
      <main className="workspace">
        <section className="panel">
          <h1>Sign in to File MCP</h1>
          <p>Use your operator password to review this connection request.</p>
          <form method="post" action="/login">
            <input
              type="hidden"
              name="returnTo"
              value={`/oauth/consent?request=${id}`}
            />
            <label htmlFor="password">Operator password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button className="primary">Sign in</button>
          </form>
        </section>
      </main>
    );
  const write = details.pending.scope.split(" ").includes("mcp:write");
  return (
    <main className="workspace">
      <section className="panel">
        <span className="eyebrow">AUTHORIZE AI ACCESS</span>
        <h1>Connect {details.client.name}?</h1>
        <p>
          This app will receive {write ? "read and write" : "read-only"} access
          to the following folders and their descendants. Google credentials
          stay on this server.
        </p>
        <ul className="record-list">
          {details.roots.map((root) => (
            <li key={root.folder_id}>
              <div>
                <strong>{root.name}</strong>
                <small>{root.folder_id}</small>
              </div>
              <span className="pill">
                {write && root.can_write ? "READ + WRITE" : "READ ONLY"}
              </span>
            </li>
          ))}
        </ul>
        {!details.roots.length && (
          <p>
            No folders approved. Add folder grants in the dashboard before
            connecting.
          </p>
        )}
        <p>
          Returns to:{" "}
          <code>{new URL(details.pending.redirect_uri).origin}</code>
        </p>
        <p>
          Access is limited to the tools available today. This authorization
          expires after 30 days. You can revoke it in the dashboard at any time.
        </p>
        <form method="post" action="/oauth/approve">
          <input type="hidden" name="request" value={id} />
          <input
            type="hidden"
            name="consentDigest"
            value={details.consentDigest}
          />
          <button
            className="primary"
            name="decision"
            value="approve"
            disabled={!details.roots.length}
          >
            Approve connection
          </button>
          <button className="secondary" name="decision" value="deny">
            Deny
          </button>
        </form>
      </section>
    </main>
  );
}
