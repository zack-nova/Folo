import type { Server } from "node:http"
import { createServer } from "node:http"

import { expect, test } from "@playwright/test"

import { createTestAccount } from "../../support/account"
import {
  expectTimelineSwitchAndEntryReadFlow,
  openSettings,
  openWebApp,
  registerWithCredential,
} from "../../support/app"
import { resolveDesktopE2EEnv } from "../../support/env"

const fixturePort = 18_765
const feedURL = `http://127.0.0.1:${fixturePort}/feed.xml`
const entryTitle = "Self-hosted phase one browser entry"

let fixtureServer: Server

test.beforeAll(async () => {
  fixtureServer = createServer((request, response) => {
    if (request.url !== "/feed.xml") {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": "application/rss+xml; charset=utf-8" })
    response.end(`<?xml version="1.0"?>
      <rss version="2.0"><channel><title>Self-hosted browser feed</title>
      <link>http://127.0.0.1:${fixturePort}/</link>
      <item><guid>phase-one-browser-entry</guid><title>${entryTitle}</title>
      <link>http://127.0.0.1:${fixturePort}/article</link>
      <description>Browser end-to-end content</description></item>
      </channel></rss>`)
  })
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject)
    fixtureServer.listen(fixturePort, "127.0.0.1", resolve)
  })
})

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    fixtureServer.close((error) => (error ? reject(error) : resolve()))
  })
})

test("registers, subscribes, renders, and persists read state against the local backend", async ({
  page,
}) => {
  const env = resolveDesktopE2EEnv()
  await openWebApp(page, env)
  await registerWithCredential(page, createTestAccount("self-hosted-phase-one"))

  const subscription = await page.evaluate(
    async ({ apiURL, url }) => {
      const response = await fetch(`${apiURL}/subscriptions`, {
        body: JSON.stringify({ url, view: 0 }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      return { body: await response.text(), status: response.status }
    },
    { apiURL: env.apiURL, url: feedURL },
  )
  expect(subscription.status, subscription.body).toBe(200)

  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.getByText(entryTitle).first()).toBeVisible({ timeout: 120_000 })
  await expectTimelineSwitchAndEntryReadFlow(page)
  await expect(page.getByTestId("entry-evaluation-panel")).toBeVisible()

  await openSettings(page, "ai")
  await expect(page.getByTestId("autonomous-ai-settings")).toBeVisible()
  await expect(page.locator("#autonomous-ai-base-url")).toBeVisible()
  await expect(page.locator("#autonomous-profile-document")).toBeVisible()
  await expect(page.locator("#autonomous-taxonomy-document")).toBeVisible()
})
