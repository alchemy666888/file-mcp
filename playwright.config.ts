import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  use: {
    baseURL: "http://localhost:3000",
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] }
      : {},
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
