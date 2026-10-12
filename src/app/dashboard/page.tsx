import Link from "next/link";
import { OAuthControls } from "@/components/oauth-controls";
import { redirect } from "next/navigation";
import { isOperator } from "@/server/auth";
import { configured, config } from "@/server/config";
import { db } from "@/server/db";
import {
  OperatorControls,
  RemoveGrant,
  Disconnect,
} from "@/components/operator-controls";
export const dynamic = "force-dynamic";
export default async function Dashboard() {
  if (!configured() || !(await isOperator())) redirect("/");
  let state;
  try {
    const [connection, clients, grants, audit, oauthClients, oauthGrants] =
      await Promise.all([
        db().query("SELECT updated_at FROM google_connection"),
        db().query(
          "SELECT id,name,can_write,revoked FROM mcp_clients ORDER BY created_at DESC",
        ),
        db().query(
          "SELECT r.*,c.name AS client_name FROM root_grants r JOIN mcp_clients c ON c.id=r.client_id WHERE NOT c.revoked ORDER BY r.name",
        ),
        db().query(
          "SELECT a.tool,a.outcome,a.code,a.duration_ms,a.created_at,c.name AS client_name FROM audit_events a LEFT JOIN mcp_clients c ON c.id=a.client_id ORDER BY a.created_at DESC LIMIT 30",
        ),
        db().query(
          "SELECT o.id,o.name,o.auth_method,o.redirect_uris,o.revoked,c.name AS parent_name FROM mcp_oauth_clients o JOIN mcp_clients c ON c.id=o.parent_id ORDER BY o.created_at DESC",
        ),
        db().query(
          "SELECT g.id,o.name AS client_name,g.scope,(g.expires_at<=now()) AS expired,(g.revoked OR o.revoked OR c.revoked) AS revoked,g.expires_at FROM mcp_oauth_grants g JOIN mcp_oauth_clients o ON o.id=g.client_id JOIN mcp_clients c ON c.id=o.parent_id ORDER BY g.created_at DESC LIMIT 50",
        ),
      ]);
    state = {
      connection: connection.rows[0],
      clients: clients.rows,
      grants: grants.rows,
      audit: audit.rows,
      oauthClients: oauthClients.rows,
      oauthGrants: oauthGrants.rows.map((grant) => ({
        ...grant,
        expires_at: new Date(grant.expires_at).toISOString(),
      })),
    };
  } catch {
    return (
      <main className="workspace">
        <Link href="/" className="brand">
          <span className="mark">F</span> FILE MCP
        </Link>
        <section className="panel">
          <h1>Database unavailable</h1>
          <p>
            Check the database connection and run the project migration.
            Credentials and error details are not displayed here.
          </p>
          <form method="post" action="/logout">
            <button className="secondary">Sign out</button>
          </form>
        </section>
      </main>
    );
  }
  return (
    <main className="workspace">
      <nav className="topbar">
        <Link href="/" className="brand">
          <span className="mark">F</span> FILE MCP
        </Link>
        <form action="/logout" method="post">
          <button className="quiet">Sign out ↗</button>
        </form>
      </nav>
      <header className="workspace-heading">
        <div>
          <span className="eyebrow">OPERATOR WORKSPACE</span>
          <h1>A place for your agent.</h1>
          <p>
            Connect your account. Define its boundaries. Follow every operation.
          </p>
        </div>
        <span className="pill">
          {state.connection ? "● GOOGLE CONNECTED" : "○ CONNECTION NEEDED"}
        </span>
      </header>
      <section className="connection panel">
        <div className="card-icon">G</div>
        <div>
          <h2>Google Drive</h2>
          <p>
            {state.connection
              ? "One operator account connected. Your folder grants control agent access."
              : "Connect the Google account that owns or has access to your approved folders."}
          </p>
        </div>
        <div className="actions">
          <form action="/api/google/connect" method="post">
            <button className="primary">
              {state.connection ? "Reconnect" : "Connect Google"} ↗
            </button>
          </form>
          {state.connection && <Disconnect />}
        </div>
      </section>
      <div className="stats">
        <div>
          <strong>
            {state.clients.filter((client) => !client.revoked).length}
          </strong>
          <span>Active clients</span>
        </div>
        <div>
          <strong>{state.grants.length}</strong>
          <span>Folder grants</span>
        </div>
        <div>
          <strong>{state.audit.length}</strong>
          <span>Recent operations</span>
        </div>
      </div>
      <OperatorControls clients={state.clients} />
      <OAuthControls
        parents={state.clients}
        clients={state.oauthClients}
        grants={state.oauthGrants}
      />
      <section className="panel">
        <div className="section-heading">
          <h2>Approved folders</h2>
          <span className="eyebrow">INCLUDING DESCENDANTS</span>
        </div>
        {!state.grants.length ? (
          <p>
            No folders approved. Clients have no Drive access until a grant is
            added.
          </p>
        ) : (
          <ul className="record-list">
            {state.grants.map((grant) => (
              <li key={`${grant.client_id}:${grant.folder_id}`}>
                <div>
                  <strong>{grant.name}</strong>
                  <small>
                    {grant.client_name} · {grant.folder_id}
                  </small>
                </div>
                <span className="pill">
                  {grant.can_write ? "READ + WRITE" : "READ ONLY"}
                </span>
                <RemoveGrant
                  clientId={grant.client_id}
                  folderId={grant.folder_id}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>Operation history</h2>
          <span className="eyebrow">LATEST 30</span>
        </div>
        {!state.audit.length ? (
          <p>
            Operations will appear here when your agent starts using the MCP.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Client</th>
                  <th>Outcome</th>
                  <th>Duration</th>
                  <th>Time (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {state.audit.map((record, index) => (
                  <tr key={index}>
                    <td>{record.tool}</td>
                    <td>{record.client_name}</td>
                    <td>
                      <span
                        className={
                          record.outcome === "success" ? "success" : "error"
                        }
                      >
                        {record.code ?? record.outcome}
                      </span>
                    </td>
                    <td>{record.duration_ms} ms</td>
                    <td>
                      {new Date(record.created_at)
                        .toISOString()
                        .replace("T", " ")
                        .slice(0, 19)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="endpoint">
        <span className="eyebrow">MCP ENDPOINT</span>
        <code>{config().APP_URL}/api/mcp</code>
        <p>
          Streamable HTTP · OAuth and bearer authentication · Google credentials
          stay on this server
        </p>
      </section>
      <footer>
        FILE MANAGEMENT MCP <span>One account. Explicit access.</span>
      </footer>
    </main>
  );
}
