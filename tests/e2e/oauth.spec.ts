import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

test("operator registers OAuth, reviews consent, and exchanges a PKCE code", async ({
  page,
  request,
}) => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires isolated PostgreSQL");
  const parent = randomUUID();
  const database = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await database.connect();
  try {
    await database.query(
      "INSERT INTO mcp_clients(id,name,token_hash,can_write) VALUES($1,'OAuth browser folders',$2,true)",
      [parent, createHash("sha256").update(randomUUID()).digest("hex")],
    );
    await database.query(
      "INSERT INTO root_grants(client_id,folder_id,name,can_write) VALUES($1,'browser-root','Browser approved folder',true)",
      [parent],
    );
    await page.goto("/");
    await page
      .getByLabel("Operator password")
      .fill(process.env.DASHBOARD_SECRET!);
    await page.getByRole("button", { name: "Open workspace" }).click();
    await expect(
      page.getByRole("heading", { name: "OAuth connections" }),
    ).toBeVisible();
    await page.getByLabel("App name").fill("ChatGPT browser test");
    await page.getByLabel("Folder permission client").selectOption(parent);
    const callback = "http://localhost:3000/oauth-test-callback";
    await page.getByLabel("Callback URLs (one per line)").fill(callback);
    await page.getByRole("button", { name: "Register OAuth client" }).click();
    await expect(page.getByText("OAuth credentials — copy now")).toBeVisible();
    const credentialBox = page
      .locator(".token-box")
      .filter({ hasText: "OAuth credentials" });
    const clientId = (await credentialBox
      .locator("code")
      .nth(0)
      .textContent())!;
    const clientSecret = (await credentialBox
      .locator("code")
      .nth(1)
      .textContent())!;
    await page.reload();
    await expect(page.getByText("OAuth credentials — copy now")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    const verifier = "k".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      response_type: "code",
      scope: "mcp:read mcp:write",
      resource: "http://localhost:3000/api/mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "browser-state",
    });
    await page.goto(`/oauth/authorize?${params}`);
    await expect(
      page.getByRole("heading", { name: "Sign in to File MCP" }),
    ).toBeVisible();
    await page
      .getByLabel("Operator password")
      .fill(process.env.DASHBOARD_SECRET!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Connect ChatGPT browser test?" }),
    ).toBeVisible();
    await expect(
      page.getByText("Browser approved folder", { exact: true }),
    ).toBeVisible();
    await page.route(`${callback}?*`, (route) =>
      route.fulfill({
        body: "OAuth test callback received",
        contentType: "text/plain",
      }),
    );
    await page.getByRole("button", { name: "Approve connection" }).click();
    await expect(page).toHaveURL(/oauth-test-callback\?/);
    const returned = new URL(page.url());
    expect(returned.searchParams.get("state")).toBe("browser-state");
    const response = await request.post("/oauth/token", {
      form: {
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code: returned.searchParams.get("code")!,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: "http://localhost:3000/api/mcp",
      },
    });
    expect(response.status()).toBe(200);
    const tokens = await response.json();
    const tools = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(tools.status()).toBe(200);
    expect((await tools.json()).result.tools.length).toBeGreaterThan(0);
    await page.goto("/dashboard");
    await page
      .getByRole("button", { name: "Revoke connection" })
      .first()
      .click();
    await expect(page.getByText("Access revoked.")).toBeVisible();
    const denied = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      data: { jsonrpc: "2.0", id: 1, method: "ping" },
    });
    expect(denied.status()).toBe(401);
  } finally {
    await database.query("DELETE FROM mcp_clients WHERE id=$1", [parent]);
    await database.end();
  }
});
