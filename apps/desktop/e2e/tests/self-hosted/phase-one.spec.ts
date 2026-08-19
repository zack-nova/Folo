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
}, testInfo) => {
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

  let statusRequests = 0
  let feedRetries = 0
  let jobRetries = 0
  const failedJobId = "operations-browser-failed-job"
  await page.route("**/api/extensions/operations/status", async (route) => {
    statusRequests += 1
    await route.fulfill({
      contentType: "application/json",
      json: {
        code: 0,
        data: {
          alerts: [
            { code: "feed_acquisition_degraded", count: 1, severity: "warning" },
            { code: "processing_jobs_failed", count: 1, severity: "warning" },
          ],
          failed_processing_jobs: [
            {
              attempt_count: 3,
              content_fingerprint: "browser-e2e-fingerprint",
              entry_id: "browser-e2e-entry",
              finished_at: new Date().toISOString(),
              force_rerun: false,
              id: failedJobId,
              last_error_code: "provider_timeout",
              last_error_summary: "Provider timed out during the final processing attempt.",
              next_retry_at: null,
              priority: 0,
              processor_name: "owner-provider",
              processor_version: "1",
              profile_snapshot_id: "browser-e2e-profile",
              purpose: "evaluation",
              queued_at: new Date().toISOString(),
              score_formula_version: "1",
              started_at: new Date().toISOString(),
              status: "failed",
              superseded_by_job_id: null,
              taxonomy_snapshot_id: "browser-e2e-taxonomy",
            },
          ],
          feed_failures: [
            {
              consecutive_failures: 3,
              feed_id: feedId,
              last_error_at: new Date().toISOString(),
              last_error_summary: "The upstream feed returned HTTP 503.",
              next_fetch_at: new Date(Date.now() + 60_000).toISOString(),
              title: "Self-hosted browser feed",
              url: feedURL,
            },
          ],
          last_cleanup: {
            at: new Date().toISOString(),
            report: {
              diagnosticPayloadsCleared: 4,
              entryEvaluationsDeleted: 2,
              feedFetchAttemptsDeleted: 7,
              processingAttemptsDeleted: 5,
              processingJobsDeleted: 3,
            },
          },
          last_feed_polling_cycle: {
            at: new Date().toISOString(),
            result: { deferred: 2, errors: [], failed: 1, refreshed: 8 },
          },
          stats: {
            feedAcquisitionFailures: 1,
            feedsDue: 2,
            processingJobs: {
              failed: 1,
              queued: 2,
              running: 1,
              succeeded: 12,
              superseded: 0,
            },
            subscribedFeeds: 9,
          },
          status: "degraded",
        },
      },
      status: 200,
    })
  })
  await page.route(`**/api/extensions/operations/feeds/${feedId}/retry`, async (route) => {
    feedRetries += 1
    await route.fulfill({
      contentType: "application/json",
      json: { code: 0, data: null },
      status: 202,
    })
  })
  await page.route(`**/api/extensions/processing/jobs/${failedJobId}/retry`, async (route) => {
    jobRetries += 1
    await route.fulfill({
      contentType: "application/json",
      json: { code: 0, data: { id: failedJobId, status: "queued" } },
      status: 202,
    })
  })

  await openSettings(page, "operations")
  await expect(page.getByTestId("operations-status-banner")).toBeVisible()
  await expect(page.getByTestId(`operations-feed-failure-${feedId}`)).toBeVisible()
  await expect(page.getByTestId(`operations-failed-job-${failedJobId}`)).toBeVisible()

  const operationsPage = page.getByTestId("operations-settings")
  await operationsPage.evaluate((element) => element.scrollIntoView({ block: "start" }))
  const desktopScreenshot = testInfo.outputPath("operations-desktop.png")
  await page.screenshot({ path: desktopScreenshot })
  await testInfo.attach("operations-desktop", {
    contentType: "image/png",
    path: desktopScreenshot,
  })

  await page.getByTestId("operations-refresh").click()
  await expect.poll(() => statusRequests).toBeGreaterThan(1)

  const diagnosticsToggle = page.getByTestId(`operations-diagnostics-toggle-${feedId}`)
  await diagnosticsToggle.click()
  await expect(page.getByTestId(`operations-diagnostics-${feedId}`)).toBeVisible()
  const diagnosticsScreenshot = testInfo.outputPath("operations-diagnostics.png")
  await page.screenshot({ path: diagnosticsScreenshot })
  await testInfo.attach("operations-diagnostics", {
    contentType: "image/png",
    path: diagnosticsScreenshot,
  })
  await diagnosticsToggle.click()
  await expect(page.getByTestId(`operations-diagnostics-${feedId}`)).toHaveCount(0)

  await page.getByTestId(`operations-retry-feed-${feedId}`).click()
  await expect.poll(() => feedRetries).toBe(1)
  await page.getByTestId(`operations-retry-job-${failedJobId}`).click()
  await expect.poll(() => jobRetries).toBe(1)

  await page.setViewportSize({ height: 720, width: 900 })
  await operationsPage.evaluate((element) => element.scrollIntoView({ block: "start" }))
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true)
  const compactScreenshot = testInfo.outputPath("operations-compact.png")
  await page.screenshot({ path: compactScreenshot })
  await testInfo.attach("operations-compact", {
    contentType: "image/png",
    path: compactScreenshot,
  })
})
