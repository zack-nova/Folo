import { fileURLToPath } from "node:url"

import { defineConfig, devices } from "@playwright/test"
import { join } from "pathe"

import { resolveDesktopE2EEnv } from "./support/env"

const env = resolveDesktopE2EEnv()
const repositoryRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..")

export default defineConfig({
  testDir: "./tests/self-hosted",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "test-results/self-hosted",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: env.webBaseURL,
    channel: "chromium",
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm server:db:up && pnpm --filter @follow/server dev",
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ALLOW_PRIVATE_FEEDS: "true",
        ALLOW_PUBLIC_REGISTRATION: "true",
        BETTER_AUTH_SECRET: "self-hosted-e2e-secret-that-is-at-least-32-characters",
        CLIENT_ORIGINS: "http://localhost:2233",
        DATABASE_URL: "postgres://folo:folo@localhost:54329/folo",
        SERVER_URL: "http://localhost:3000",
        UPLOADS_DIRECTORY: "/tmp/folo-self-hosted-e2e-uploads",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: "http://localhost:3000/health",
    },
    {
      command: "pnpm run dev:web",
      cwd: env.desktopAppDir,
      env: {
        ...process.env,
        VITE_API_URL: "http://localhost:3000",
        VITE_WEB_URL: "http://localhost:2233",
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: env.webDevServerURL,
    },
  ],
})
