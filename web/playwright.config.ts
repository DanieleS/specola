import { defineConfig } from "@playwright/test";

// Use a disposable local database, never a production DATABASE_URL.
if (!process.env.SPECOLA_E2E_DATABASE_URL) {
  throw new Error("Set SPECOLA_E2E_DATABASE_URL to a disposable migrated/test database");
}
const servers = [
  { name: "app-origin", port: 4177, view: "" },
  { name: "view-origin", port: 4178, view: "http://localhost:4178" },
];
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 1,
  timeout: 60_000,
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: servers.map(({ name, port }) => ({ name, use: { baseURL: `http://127.0.0.1:${port}` } })),
  webServer: servers.map(({ port, view }) => ({
    command: "cd .. && go run ./cmd/specola",
    url: `http://127.0.0.1:${port}/api/me`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      SPECOLA_DATABASE_URL: process.env.SPECOLA_E2E_DATABASE_URL!,
      SPECOLA_LISTEN: `127.0.0.1:${port}`,
      SPECOLA_BASE_URL: `http://127.0.0.1:${port}`,
      SPECOLA_VIEW_ORIGIN: view,
      SPECOLA_DEV_AUTH_EMAIL: "links-e2e@example.test",
      SPECOLA_TRUSTED_USER_HEADER: "",
      SPECOLA_OIDC_ISSUER: "",
      SPECOLA_SESSION_SECRET: "local-e2e-only-not-a-production-secret",
    },
  })),
});
