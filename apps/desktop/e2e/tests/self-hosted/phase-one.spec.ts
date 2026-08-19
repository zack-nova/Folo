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
      const body = await response.text()
      return { body, data: JSON.parse(body) as { feed?: { id?: string } }, status: response.status }
    },
    { apiURL: env.apiURL, url: feedURL },
  )
  expect(subscription.status, subscription.body).toBe(200)
  const feedId = subscription.data.feed?.id
  expect(feedId).toBeTruthy()

  const runtime = await page.evaluate(
    async ({ apiURL, feedId }) => {
      const urls = [
        "/ready",
        "/api/extensions/capabilities",
        `/api/extensions/subscriptions/${feedId}/acquisition`,
        `/api/extensions/subscriptions/${feedId}/acquisition/diagnostics`,
        "/api/extensions/operations/status",
      ]
      return Promise.all(
        urls.map(async (url) => {
          const response = await fetch(`${apiURL}${url}`, { credentials: "include" })
          return { body: await response.text(), status: response.status, url }
        }),
      )
    },
    { apiURL: env.apiURL, feedId: feedId! },
  )
  expect(
    runtime.slice(0, 4).every((response) => response.status === 200),
    JSON.stringify(runtime),
  ).toBe(true)
  expect(runtime[4]?.status).toBe(403)
  expect(JSON.parse(runtime[4]!.body)).toMatchObject({ code: "forbidden" })
  expect(JSON.parse(runtime[1]!.body).data.stage).toBe(4)
  expect(JSON.parse(runtime[2]!.body).data).toMatchObject({
    active_provider: "standard_rss",
    status: "healthy",
  })
  expect(JSON.parse(runtime[3]!.body).data.items).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "succeeded" })]),
  )

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
