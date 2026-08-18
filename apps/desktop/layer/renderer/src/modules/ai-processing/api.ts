import { fetchAPI } from "~/lib/api-client"

import type {
  AIProviderConfiguration,
  EntryEvaluation,
  EntryEvaluationHistory,
  EntryProjection,
  ProcessingJob,
  ProcessingJobOutcome,
  ProcessingStatusHistory,
  ReEvaluationPreview,
  ReEvaluationResult,
  ReEvaluationScope,
  SnapshotCollection,
} from "./types"

type ExtensionFetch = (path: string, init?: RequestInit) => Promise<Response>
type APIEnvelope<T> = { code: 0; data: T }

export class AIProcessingAPIError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "AIProcessingAPIError"
  }
}

const responsePayload = async <T>(response: Response): Promise<T> => {
  const payload = (await response.json()) as
    APIEnvelope<T> | { code?: string | number; message?: string }
  if (!response.ok || payload.code !== 0 || !("data" in payload)) {
    throw new AIProcessingAPIError(
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "AI processing request failed",
      String(payload.code ?? "ai_processing_request_failed"),
      response.status,
    )
  }
  return payload.data
}

const jsonBody = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
})

export const createAIProcessingClient = (request: ExtensionFetch) => ({
  async getProvider() {
    return responsePayload<AIProviderConfiguration>(await request("/api/extensions/ai/provider"))
  },
  async saveProvider(input: { api_key: string; base_url: string; model: string }) {
    return responsePayload<AIProviderConfiguration>(
      await request("/api/extensions/ai/provider", { ...jsonBody(input), method: "PUT" }),
    )
  },
  async deleteProvider() {
    return responsePayload<null>(await request("/api/extensions/ai/provider", { method: "DELETE" }))
  },
  async getProfiles() {
    return responsePayload<SnapshotCollection>(await request("/api/extensions/profiles"))
  },
  async createProfile(input: { name: string; content: Record<string, unknown> }) {
    return responsePayload<SnapshotCollection["snapshots"][number]>(
      await request("/api/extensions/profiles", { ...jsonBody(input), method: "POST" }),
    )
  },
  async getTaxonomies() {
    return responsePayload<SnapshotCollection>(await request("/api/extensions/taxonomies"))
  },
  async createTaxonomy(input: { name: string; content: Record<string, unknown> }) {
    return responsePayload<SnapshotCollection["snapshots"][number]>(
      await request("/api/extensions/taxonomies", { ...jsonBody(input), method: "POST" }),
    )
  },
  async getEntryProjections(entryIds: string[]) {
    const uniqueIds = [...new Set(entryIds)]
    const batches = Array.from({ length: Math.ceil(uniqueIds.length / 100) }, (_, index) =>
      uniqueIds.slice(index * 100, index * 100 + 100),
    )
    const responses = await Promise.all(
      batches.map(async (batch) =>
        responsePayload<Record<string, EntryProjection>>(
          await request("/api/extensions/entries/projections", {
            ...jsonBody({
              entry_ids: batch,
              include: ["evaluation", "processing_status"],
            }),
            method: "POST",
          }),
        ),
      ),
    )
    return Object.assign({}, ...responses) as Record<string, EntryProjection>
  },
  async getEntryEvaluation(entryId: string) {
    return responsePayload<EntryEvaluationHistory>(
      await request(`/api/extensions/entries/${encodeURIComponent(entryId)}/evaluation`),
    )
  },
  async selectEntryEvaluation(entryId: string, evaluationId: string) {
    return responsePayload<EntryEvaluation>(
      await request(
        `/api/extensions/entries/${encodeURIComponent(entryId)}/evaluation/${encodeURIComponent(evaluationId)}/select`,
        { ...jsonBody({ reason: "manual_rollback" }), method: "POST" },
      ),
    )
  },
  async getProcessingStatus(entryId: string) {
    return responsePayload<ProcessingStatusHistory>(
      await request(`/api/extensions/entries/${encodeURIComponent(entryId)}/processing-status`),
    )
  },
  async createProcessingJob(entryId: string, forceRerun = false) {
    return responsePayload<ProcessingJobOutcome>(
      await request("/api/extensions/processing/jobs", {
        ...jsonBody({ entry_id: entryId, force_rerun: forceRerun }),
        method: "POST",
      }),
    )
  },
  async retryProcessingJob(jobId: string) {
    return responsePayload<ProcessingJob>(
      await request(`/api/extensions/processing/jobs/${encodeURIComponent(jobId)}/retry`, {
        ...jsonBody({}),
        method: "POST",
      }),
    )
  },
  async previewReEvaluation(scope: ReEvaluationScope) {
    return responsePayload<ReEvaluationPreview>(
      await request("/api/extensions/processing/re-evaluation-preview", {
        ...jsonBody(scope),
        method: "POST",
      }),
    )
  },
  async createReEvaluationJobs(scope: ReEvaluationScope) {
    return responsePayload<ReEvaluationResult>(
      await request("/api/extensions/processing/re-evaluation-jobs", {
        ...jsonBody(scope),
        method: "POST",
      }),
    )
  },
})

export const aiProcessingClient = createAIProcessingClient(fetchAPI)
