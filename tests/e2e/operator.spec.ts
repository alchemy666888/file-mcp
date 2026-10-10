import { test, expect } from "@playwright/test";
test("setup page is responsive and dashboard requires authentication", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Your folders. Your agent. Your rules.",
    }),
  ).toBeVisible();
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/$/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("operator logs in, creates a client, sees its token once, and signs out", async ({
  page,
}) => {
  test.skip(
    !process.env.TEST_DATABASE_URL,
    "Requires the isolated test database",
  );
  await page.goto("/");
  await page
    .getByLabel("Operator password")
    .fill(process.env.DASHBOARD_SECRET!);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "A place for your agent." }),
  ).toBeVisible();
  await page.getByLabel("Client name").fill("Browser test client");
  await page.getByRole("button", { name: "Create credential" }).click();
  await expect(page.getByText("One-time bearer credential")).toBeVisible();
  await page.reload();
  await expect(page.getByText("One-time bearer credential")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
});
