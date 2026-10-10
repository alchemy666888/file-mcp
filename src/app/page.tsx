import Link from "next/link";
import { configured } from "@/server/config";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ready = configured();
  const { error } = await searchParams;
  return (
    <main className="landing">
      <nav className="topbar">
        <Link href="/" className="brand">
          <span className="mark">F</span> FILE MCP
        </Link>
        <span className="pill">GOOGLE DRIVE × AGENT-BOT</span>
      </nav>
      <div className="hero">
        <div>
          <span className="eyebrow">A PRIVATE BRIDGE TO YOUR FILES</span>
          <h1>
            Your folders.
            <br />
            Your agent.
            <br />
            <em>Your rules.</em>
          </h1>
          <p className="intro">
            Give your agent a place to read, write, and organize. Connect Google
            Drive once, choose the folders it can access, and keep everything
            else outside its reach.
          </p>
          <div className="features">
            <span>01 / Folder-scoped access</span>
            <span>02 / Resumable file transfers</span>
            <span>03 / Recorded operations</span>
          </div>
        </div>
        <section className="login-card">
          <div className="card-icon">↗</div>
          <span className="eyebrow">OPERATOR WORKSPACE</span>
          <h2>Connect with control.</h2>
          <p>
            Manage your Google connection, approved folders, and agent
            credentials.
          </p>
          {ready ? (
            <form method="post" action="/login">
              <label htmlFor="password">Operator password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={32}
              />
              {error === "login" && (
                <p className="error" role="alert">
                  That password was not accepted.
                </p>
              )}
              <button className="primary">
                Open workspace <span>→</span>
              </button>
            </form>
          ) : (
            <div className="notice">
              <strong>Setup required</strong>
              <p>
                Configure the server environment and run the database migration
                to open your workspace. See the project README for the setup
                steps.
              </p>
            </div>
          )}
          <div className="small-note">
            Private operator access · One connected Google account
          </div>
        </section>
      </div>
      <footer>
        FILE MANAGEMENT MCP <span>Built for agent-bot / Hosted on Vercel</span>
      </footer>
    </main>
  );
}
