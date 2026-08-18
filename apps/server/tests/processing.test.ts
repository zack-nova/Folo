import { setTimeout as delay } from "node:timers/promises"

import { FollowClient } from "@follow-app/client-sdk"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AIProvider } from "../src/ai/provider"
import { createAuth } from "../src/auth"
import { MemoryDataStore } from "../src/data/memory-store"
import type { EntrySummaryRecord } from "../src/data/types"
import { buildServer } from "../src/server"

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>AI feed</title><link>https://example.com</link>
<item><guid>ai-entry</guid><title>Local AI changes RSS reading</title><link>https://example.com/ai</link>
<description><![CDATA[<p>A detailed article about personally controlled information flows.</p>]]></description></item>
</channel></rss>`

class SummaryFailingDataStore extends MemoryDataStore {
  override async setEntrySummary(_userId: string, _summary: EntrySummaryRecord): Promise<void> {
    throw new Error("summary storage unavailable")
  }
}

describe("entry evaluation processing", () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()))
  })

  it("processes an entry into an immutable evaluation and reuses the satisfied configuration", async () => {
    const complete = vi.fn<AIProvider["complete"]>().mockResolvedValue({
      content: JSON.stringify({
        importance_score: 80,
        timeliness_score: 70,
        relevance_score: 90,
        recommendation_reason: "Directly supports a personally controlled reading workflow.",
        primary_category: "Technology",
        secondary_category: "RSS",
        tags: ["self-hosted", "ai"],
        summary: "A local AI pipeline can enrich RSS entries without surrendering data control.",
      }),
      model: "reader-model",
      usage: { inputTokens: 120, outputTokens: 80 },
    })
    const auth = createAuth({
      baseURL: "http://localhost:3000",
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      secret: "processing-test-secret-that-is-at-least-32-characters",
      trustedOrigins: ["http://localhost:2233"],
    })
    const dataStore = new SummaryFailingDataStore()
    const server = await buildServer({
      aiProvider: { complete },
      auth,
      clientOrigins: ["http://localhost:2233"],
      dataStore,
      feedFetcher: {
        fetch: async (url) => ({
          body: rss,
          contentType: "application/rss+xml",
          etag: null,
          lastModified: null,
          url,
        }),
      },
      processingMaxAttempts: 1,
      processingWorkerPollIntervalMs: 5,
    })
    servers.push(server)

    const registration = await server.inject({
      method: "POST",
      url: "/better-auth/sign-up/email",
      headers: { origin: "http://localhost:2233" },
      payload: {
        email: "owner@example.com",
        name: "Owner",
        password: "correct-horse-battery-staple",
      },
    })
    const cookie = registration.headers["set-cookie"]?.toString().split(";", 1)[0]
    expect(cookie).toBeTruthy()

    const client = new FollowClient({
      baseURL: "http://localhost:3000",
      fetch: async (input, init) => {
        const request = new Request(input, init)
        const response = await server.inject({
          method: request.method as "GET" | "POST",
          url: new URL(request.url).pathname + new URL(request.url).search,
          headers: { ...Object.fromEntries(request.headers.entries()), cookie: cookie! },
          payload:
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : await request.text(),
        })
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as unknown as HeadersInit,
        })
      },
    })
    await client.api.subscriptions.create({ url: "https://feeds.example.com/ai.xml", view: 0 })
    const entryId = (await client.api.entries.list({ view: 0 })).data.at(0)!.entries.id

    const profile = await server.inject({
      method: "POST",
      url: "/api/extensions/profiles",
      headers: { cookie: cookie! },
      payload: { content: { interests: ["self-hosted software", "RSS"] }, name: "default" },
    })
    expect(profile.statusCode).toBe(201)
    await server.inject({
      method: "POST",
      url: "/api/extensions/profiles",
      headers: { cookie: cookie! },
      payload: { content: { interests: ["RSS", "version two"] }, name: "default" },
    })
    await delay(2)
    const latestProfile = await server.inject({
      method: "POST",
      url: "/api/extensions/profiles",
      headers: { cookie: cookie! },
      payload: { content: { interests: ["latest profile"] }, name: "latest" },
    })
    const profiles = await server.inject({
      method: "GET",
      url: "/api/extensions/profiles",
      headers: { cookie: cookie! },
    })
    expect(profiles.json().data.current.id).toBe(latestProfile.json().data.id)
    const taxonomy = await server.inject({
      method: "POST",
      url: "/api/extensions/taxonomies",
      headers: { cookie: cookie! },
      payload: {
        content: { categories: [{ name: "Technology", children: ["RSS"] }] },
        name: "default",
      },
    })
    expect(taxonomy.statusCode).toBe(201)
    await server.inject({
      method: "POST",
      url: "/api/extensions/taxonomies",
      headers: { cookie: cookie! },
      payload: { content: { categories: ["Technology", "Research"] }, name: "default" },
    })
    await delay(2)
    const latestTaxonomy = await server.inject({
      method: "POST",
      url: "/api/extensions/taxonomies",
      headers: { cookie: cookie! },
      payload: { content: { categories: ["Latest"] }, name: "latest" },
    })
    const taxonomies = await server.inject({
      method: "GET",
      url: "/api/extensions/taxonomies",
      headers: { cookie: cookie! },
    })
    expect(taxonomies.json().data.current.id).toBe(latestTaxonomy.json().data.id)

    const queued = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/jobs",
      headers: { cookie: cookie! },
      payload: { entry_id: entryId },
    })
    expect(queued.statusCode).toBe(202)
    expect(queued.json()).toMatchObject({ code: 0, data: { outcome: "created" } })
    const jobId = queued.json().data.job.id as string

    let job: Record<string, unknown> | undefined
    for (let index = 0; index < 50; index += 1) {
      const response = await server.inject({
        method: "GET",
        url: `/api/extensions/processing/jobs/${jobId}`,
        headers: { cookie: cookie! },
      })
      job = response.json().data
      if (job?.status === "succeeded") break
      await delay(5)
    }
    expect(job).toMatchObject({ attempt_count: 1, status: "succeeded" })

    const evaluation = await server.inject({
      method: "GET",
      url: `/api/extensions/entries/${entryId}/evaluation`,
      headers: { cookie: cookie! },
    })
    expect(evaluation.statusCode).toBe(200)
    expect(evaluation.json()).toMatchObject({
      code: 0,
      data: {
        current: {
          importance_score: 80,
          timeliness_score: 70,
          relevance_score: 90,
          overall_score: 83,
          primary_category: "Technology",
          secondary_category: "RSS",
          tags: ["self-hosted", "ai"],
          configuration_outdated: false,
        },
        history: [{ overall_score: 83 }],
      },
    })
    expect(complete).toHaveBeenCalledTimes(1)

    const duplicate = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/jobs",
      headers: { cookie: cookie! },
      payload: { entry_id: entryId },
    })
    expect(duplicate.statusCode).toBe(200)
    expect(duplicate.json()).toMatchObject({ code: 0, data: { outcome: "already_satisfied" } })
    expect(complete).toHaveBeenCalledTimes(1)

    complete.mockResolvedValueOnce({
      content: JSON.stringify({
        importance_score: 60,
        timeliness_score: 50,
        relevance_score: 70,
        recommendation_reason: "Useful, but less aligned after a deliberate re-evaluation.",
        primary_category: "Technology",
        secondary_category: "AI",
        tags: ["reevaluated"],
      }),
      model: "reader-model",
      usage: { inputTokens: 110, outputTokens: 60 },
    })
    const forced = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/jobs",
      headers: { cookie: cookie! },
      payload: { entry_id: entryId, force_rerun: true },
    })
    expect(forced.statusCode).toBe(202)
    const forcedJobId = forced.json().data.job.id as string
    for (let index = 0; index < 50; index += 1) {
      const response = await server.inject({
        method: "GET",
        url: `/api/extensions/processing/jobs/${forcedJobId}`,
        headers: { cookie: cookie! },
      })
      if (response.json().data.status === "succeeded") break
      await delay(5)
    }

    const history = await server.inject({
      method: "GET",
      url: `/api/extensions/entries/${entryId}/evaluation`,
      headers: { cookie: cookie! },
    })
    expect(history.json().data.current.overall_score).toBe(63)
    expect(history.json().data.history).toHaveLength(2)
    const firstEvaluationId = history
      .json()
      .data.history.find((item: { overall_score: number }) => item.overall_score === 83)
      .id as string

    const selected = await server.inject({
      method: "POST",
      url: `/api/extensions/entries/${entryId}/evaluation/${firstEvaluationId}/select`,
      headers: { cookie: cookie! },
      payload: { reason: "manual_rollback" },
    })
    expect(selected.statusCode).toBe(200)
    expect(selected.json().data.overall_score).toBe(83)
    expect(complete).toHaveBeenCalledTimes(2)

    complete.mockRejectedValueOnce(new Error("provider temporarily unavailable"))
    const failing = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/jobs",
      headers: { cookie: cookie! },
      payload: { entry_id: entryId, force_rerun: true },
    })
    const failingJobId = failing.json().data.job.id as string
    let failedJob: Record<string, unknown> | undefined
    for (let index = 0; index < 50; index += 1) {
      const response = await server.inject({
        method: "GET",
        url: `/api/extensions/processing/jobs/${failingJobId}`,
        headers: { cookie: cookie! },
      })
      failedJob = response.json().data
      if (failedJob?.status === "failed") break
      await delay(5)
    }
    expect(failedJob).toMatchObject({
      attempt_count: 1,
      last_error_code: "ai_provider_error",
      status: "failed",
    })
    const preserved = await server.inject({
      method: "GET",
      url: `/api/extensions/entries/${entryId}/evaluation`,
      headers: { cookie: cookie! },
    })
    expect(preserved.json().data.current.overall_score).toBe(83)
    expect(preserved.json().data.history).toHaveLength(2)

    complete.mockResolvedValueOnce({
      content: JSON.stringify({
        importance_score: 70,
        timeliness_score: 60,
        relevance_score: 80,
        recommendation_reason: "The explicit retry recovered the processing result.",
        primary_category: "Technology",
        secondary_category: "Operations",
        tags: ["recovered"],
      }),
      model: "reader-model",
      usage: { inputTokens: 100, outputTokens: 50 },
    })
    const retried = await server.inject({
      method: "POST",
      url: `/api/extensions/processing/jobs/${failingJobId}/retry`,
      headers: { cookie: cookie! },
    })
    expect(retried.statusCode).toBe(202)
    let recoveredJob: Record<string, unknown> | undefined
    for (let index = 0; index < 50; index += 1) {
      const response = await server.inject({
        method: "GET",
        url: `/api/extensions/processing/jobs/${failingJobId}`,
        headers: { cookie: cookie! },
      })
      recoveredJob = response.json().data
      if (recoveredJob?.status === "succeeded") break
      await delay(5)
    }
    expect(recoveredJob).toMatchObject({ attempt_count: 2, status: "succeeded" })
    const recovered = await server.inject({
      method: "GET",
      url: `/api/extensions/entries/${entryId}/evaluation`,
      headers: { cookie: cookie! },
    })
    expect(recovered.json().data.current.overall_score).toBe(73)
    expect(recovered.json().data.history).toHaveLength(3)

    const preview = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/re-evaluation-preview",
      headers: { cookie: cookie! },
      payload: { entry_ids: [entryId] },
    })
    expect(preview.statusCode).toBe(200)
    expect(preview.json()).toMatchObject({
      code: 0,
      data: { already_satisfied: 1, estimated_calls: 0, matched: 1 },
    })
    const bulk = await server.inject({
      method: "POST",
      url: "/api/extensions/processing/re-evaluation-jobs",
      headers: { cookie: cookie! },
      payload: { entry_ids: [entryId] },
    })
    expect(bulk.statusCode).toBe(202)
    expect(bulk.json()).toMatchObject({
      code: 0,
      data: { already_satisfied: 1, created: 0, matched: 1, reused: 0 },
    })
  })
})
