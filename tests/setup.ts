process.env.APP_URL = "http://localhost:3000";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost/unconfigured_test";
process.env.DASHBOARD_SECRET = "test-dashboard-password-at-least-32-characters";
process.env.SESSION_SIGNING_SECRET =
  "test-session-signing-secret-at-least-32-characters";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-google-client";
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";
