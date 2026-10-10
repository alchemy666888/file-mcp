"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
type Client = {
  id: string;
  name: string;
  can_write: boolean;
  revoked: boolean;
};
export function OperatorControls({ clients }: { clients: Client[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  async function submit(input: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Request failed");
      if (value.token) setToken(value.token);
      setMessage(
        value.token
          ? "Credential created. Copy it before leaving this page."
          : "Changes saved.",
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="control-grid">
        <section className="panel">
          <span className="eyebrow">01 / AGENT ACCESS</span>
          <h2>Create a client</h2>
          <p>Each credential receives its own folder grants.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void submit({
                action: "create_client",
                name: form.get("name"),
                canWrite: form.get("canWrite") === "on",
              });
            }}
          >
            <label htmlFor="client-name">Client name</label>
            <input
              id="client-name"
              name="name"
              placeholder="agent-bot"
              required
              maxLength={100}
            />
            <label className="checkbox">
              <input name="canWrite" type="checkbox" /> Allow write capabilities
            </label>
            <button disabled={busy} className="secondary">
              Create credential <span>+</span>
            </button>
          </form>
        </section>
        <section className="panel">
          <span className="eyebrow">02 / FOLDER BOUNDARY</span>
          <h2>Approve a folder</h2>
          <p>
            Access includes its subfolders. Use the folder ID from its Google
            Drive URL.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void submit({
                action: "grant",
                clientId: form.get("clientId"),
                folderId: form.get("folderId"),
                canWrite: form.get("canWrite") === "on",
              });
            }}
          >
            <label htmlFor="grant-client">Client</label>
            <select id="grant-client" name="clientId" required defaultValue="">
              <option value="" disabled>
                Select client
              </option>
              {clients
                .filter((client) => !client.revoked)
                .map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
            </select>
            <label htmlFor="folder-id">Google Drive folder ID</label>
            <input
              id="folder-id"
              name="folderId"
              required
              pattern="[A-Za-z0-9_-]+"
              maxLength={200}
              placeholder="1Abc…"
            />
            <label className="checkbox">
              <input type="checkbox" name="canWrite" /> Read and write in this
              folder
            </label>
            <button disabled={busy} className="secondary">
              Approve folder <span>→</span>
            </button>
          </form>
        </section>
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {token && (
        <section className="token-box">
          <strong>One-time bearer credential</strong>
          <code>{token}</code>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(token)
                .then(() => setMessage("Copied credential."))
                .catch(() =>
                  setMessage("Select and copy the credential manually."),
                )
            }
          >
            Copy credential
          </button>
          <button type="button" className="quiet" onClick={() => setToken("")}>
            Hide
          </button>
        </section>
      )}
      <section className="panel">
        <h2>Client credentials</h2>
        {clients.length === 0 ? (
          <p>No clients yet. Create your first credential above.</p>
        ) : (
          <ul className="record-list">
            {clients.map((client) => (
              <li key={client.id}>
                <div>
                  <strong>{client.name}</strong>
                  <small>{client.id}</small>
                </div>
                <span className="pill">
                  {client.revoked
                    ? "REVOKED"
                    : client.can_write
                      ? "READ + WRITE"
                      : "READ ONLY"}
                </span>
                {!client.revoked && (
                  <button
                    className="quiet danger"
                    disabled={busy}
                    onClick={() =>
                      void submit({
                        action: "revoke_client",
                        clientId: client.id,
                      })
                    }
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
export function RemoveGrant({
  clientId,
  folderId,
}: {
  clientId: string;
  folderId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        className="quiet danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const response = await fetch("/api/operator", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "remove_grant",
                clientId,
                folderId,
              }),
            });
            if (!response.ok) throw new Error("Could not remove grant");
            router.refresh();
          } catch {
            setError("Could not remove grant");
          } finally {
            setBusy(false);
          }
        }}
      >
        Remove
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
export function Disconnect() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        className="quiet danger"
        onClick={async () => {
          try {
            const response = await fetch("/api/operator", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "disconnect" }),
            });
            if (!response.ok) throw new Error();
            router.refresh();
          } catch {
            setMessage("Could not disconnect. Try again.");
          }
        }}
      >
        Disconnect
      </button>
      {message && <span role="alert">{message}</span>}
    </>
  );
}
