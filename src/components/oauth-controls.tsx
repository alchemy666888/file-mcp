"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
type Parent = { id: string; name: string; revoked: boolean };
type OAuthClient = {
  id: string;
  name: string;
  auth_method: string;
  redirect_uris: string[];
  revoked: boolean;
  parent_name: string;
};
type OAuthGrant = {
  id: string;
  client_name: string;
  scope: string;
  revoked: boolean;
  expires_at: string;
  expired: boolean;
};
export function OAuthControls({
  parents,
  clients,
  grants,
}: {
  parents: Parent[];
  clients: OAuthClient[];
  grants: OAuthGrant[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [credential, setCredential] = useState<{
    clientId: string;
    clientSecret: string | null;
    authMethod: string;
  } | null>(null);
  async function submit(input: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/oauth/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Request failed");
      if (value.clientId) setCredential(value);
      setMessage(
        value.clientId
          ? "OAuth client registered. Copy the credentials before leaving."
          : "Access revoked.",
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <span className="eyebrow">CHATGPT & OTHER OAUTH CLIENTS</span>
      <h2>OAuth connections</h2>
      <p>
        Register each AI app with its exact callback URL. Its access uses the
        folder grants of the selected client and requires operator approval.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void submit({
            action: "register",
            name: form.get("name"),
            parentId: form.get("parentId"),
            redirectUris: String(form.get("redirectUris"))
              .split(/\r?\n/)
              .map((value) => value.trim())
              .filter(Boolean),
            authMethod: form.get("authMethod"),
          });
        }}
      >
        <label htmlFor="oauth-name">App name</label>
        <input
          id="oauth-name"
          name="name"
          placeholder="ChatGPT"
          required
          maxLength={100}
        />
        <label htmlFor="oauth-parent">Folder permission client</label>
        <select id="oauth-parent" name="parentId" required defaultValue="">
          <option disabled value="">
            Select client
          </option>
          {parents
            .filter((parent) => !parent.revoked)
            .map((parent) => (
              <option value={parent.id} key={parent.id}>
                {parent.name}
              </option>
            ))}
        </select>
        <label htmlFor="oauth-callbacks">Callback URLs (one per line)</label>
        <textarea
          id="oauth-callbacks"
          name="redirectUris"
          required
          rows={3}
          placeholder="Paste the complete callback URL from your AI app"
        />
        <label htmlFor="oauth-method">Token endpoint authentication</label>
        <select
          id="oauth-method"
          name="authMethod"
          defaultValue="client_secret_post"
        >
          <option value="client_secret_post">client_secret_post</option>
          <option value="client_secret_basic">client_secret_basic</option>
          <option value="none">none (public client with PKCE)</option>
        </select>
        <button disabled={busy} className="secondary">
          Register OAuth client
        </button>
      </form>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {credential && (
        <div className="token-box">
          <strong>OAuth credentials — copy now</strong>
          <p>
            Client ID: <code>{credential.clientId}</code>
          </p>
          <p>
            Client secret:{" "}
            <code>{credential.clientSecret ?? "Not required"}</code>
          </p>
          <p>
            Token endpoint auth method: <code>{credential.authMethod}</code>
          </p>
          <button className="quiet" onClick={() => setCredential(null)}>
            Hide credentials
          </button>
        </div>
      )}
      <h3>Registered apps</h3>
      {!clients.length ? (
        <p>No OAuth clients registered.</p>
      ) : (
        <ul className="record-list">
          {clients.map((client) => (
            <li key={client.id}>
              <div>
                <strong>{client.name}</strong>
                <small>
                  {client.id} · {client.auth_method} · {client.parent_name}
                </small>
                {client.redirect_uris.map((uri) => (
                  <small key={uri}>{uri}</small>
                ))}
              </div>
              <span className="pill">
                {client.revoked ? "REVOKED" : "REGISTERED"}
              </span>
              {!client.revoked && (
                <button
                  disabled={busy}
                  className="quiet danger"
                  onClick={() =>
                    void submit({ action: "revoke_client", id: client.id })
                  }
                >
                  Revoke app
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Authorizations</h3>
      {!grants.length ? (
        <p>No approved OAuth connections yet.</p>
      ) : (
        <ul className="record-list">
          {grants.map((grant) => (
            <li key={grant.id}>
              <div>
                <strong>{grant.client_name}</strong>
                <small>
                  {grant.scope} · Expires{" "}
                  {new Date(grant.expires_at).toISOString().slice(0, 10)}
                </small>
              </div>
              <span className="pill">
                {grant.revoked
                  ? "REVOKED"
                  : grant.expired
                    ? "EXPIRED"
                    : "AUTHORIZED"}
              </span>
              {!grant.revoked && (
                <button
                  disabled={busy}
                  className="quiet danger"
                  onClick={() =>
                    void submit({ action: "revoke_grant", id: grant.id })
                  }
                >
                  Revoke connection
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
