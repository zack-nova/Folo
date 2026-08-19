import { createHash, randomUUID } from "node:crypto"

import { z } from "zod"

import type { AIProvider } from "../ai/provider"
import type {
  DataStore,
  EnqueueProcessingJobResult,
  EntryEvaluationRecord,
  EntryRecord,
  MaintenanceCleanupReport,
  ProcessingAttemptRecord,
  ProcessingJobRecord,
} from "../data/types"

const processorName = "personal-relevance"
const processorVersion = "1"
const scoreFormulaVersion = "weighted-v1"

const evaluationSchema = z.object({
  importance_score: z.number().min(0).max(100),
  timeliness_score: z.number().min(0).max(100),
  relevance_score: z.number().min(0).max(100),
  recommendation_reason: z.string().min(1).max(2_000),
  primary_category: z.string().min(1).max(200),
  secondary_category: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).default([]),
  summary: z.string().min(1).max(10_000).optional(),
})

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export const contentHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")

export const entryContentFingerprint = (entry: EntryRecord): string =>
  contentHash({
    content: entry.content,
    description: entry.description,
    publishedAt: entry.publishedAt.toISOString(),
    title: entry.title,
    url: entry.url,
  })

const cleanJSONCompletion = (content: string): string => {
  const trimmed = content.trim()
  if (!trimmed.startsWith("```")) return trimmed
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
}

const publicError = (error: unknown): { code: string; summary: string } => {
  if (error instanceof ProcessingError) return { code: error.code, summary: error.message }
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_ai_response",
      summary: "AI response did not match the evaluation schema",
    }
  }
  if (error instanceof SyntaxError) {
    return { code: "invalid_ai_response", summary: "AI response was not valid JSON" }
  }
  return {
    code: "ai_provider_error",
    summary: error instanceof Error ? error.message.slice(0, 1_000) : "AI processing failed",
  }
}

export class ProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface ProcessingServiceOptions {
  dataStore: DataStore
  maxAttempts?: number
  onError?: (error: unknown) => void
  onCleanup?: (report: MaintenanceCleanupReport) => void
  pollIntervalMs?: number
  resolveProvider: (userId: string) => Promise<AIProvider>
  retryBaseDelayMs?: number
}

export class ProcessingService {
  private activeDrain: Promise<void> | null = null
  private processing = false
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly maxAttempts: number
  private readonly retryBaseDelayMs: number

  constructor(private readonly options: ProcessingServiceOptions) {
    this.maxAttempts = options.maxAttempts ?? 3
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.scheduleDrain(), this.options.pollIntervalMs ?? 1_000)
    this.timer.unref()
    this.runSafely(
      this.options.dataStore.cleanupProcessingHistory(new Date()),
      this.options.onCleanup,
    )
    this.cleanupTimer = setInterval(
      () =>
        this.runSafely(
          this.options.dataStore.cleanupProcessingHistory(new Date()),
          this.options.onCleanup,
        ),
      24 * 60 * 60 * 1_000,
    )
    this.cleanupTimer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = undefined
    await this.activeDrain
  }

  kick(): void {
    queueMicrotask(() => this.scheduleDrain())
  }

  private runSafely<T>(operation: Promise<T>, onSuccess?: (result: T) => void): void {
    void operation.then(onSuccess).catch((error: unknown) => this.options.onError?.(error))
  }

  private scheduleDrain(): void {
    if (this.activeDrain) return
    this.activeDrain = this.drain()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.activeDrain = null
      })
  }

  async enqueueEvaluation(
    userId: string,
    entryId: string,
    options: {
      automatic?: boolean
      forceRerun?: boolean
      priority?: number
      profileSnapshotId?: string
      taxonomySnapshotId?: string
    } = {},
  ): Promise<EnqueueProcessingJobResult> {
    const entry = await this.options.dataStore.getEntry(userId, entryId)
    if (!entry) throw new ProcessingError("entry_not_found", "Entry not found")
    const profiles = await this.options.dataStore.listProcessingProfileSnapshots(userId)
    const taxonomies = await this.options.dataStore.listProcessingTaxonomySnapshots(userId)
    const profile = options.profileSnapshotId
      ? await this.options.dataStore.getProcessingProfileSnapshot(userId, options.profileSnapshotId)
      : profiles.at(0)
    const taxonomy = options.taxonomySnapshotId
      ? await this.options.dataStore.getProcessingTaxonomySnapshot(
          userId,
          options.taxonomySnapshotId,
        )
      : taxonomies.at(0)
    if (!profile) {
      throw new ProcessingError("profile_required", "Create a processing profile before evaluation")
    }
    if (!taxonomy) {
      throw new ProcessingError("taxonomy_required", "Create a taxonomy before evaluation")
    }

    const fingerprint = entryContentFingerprint(entry)
    const idempotencyKey = contentHash({
      contentFingerprint: fingerprint,
      entryId,
      processorName,
      processorVersion,
      profileSnapshotId: profile.id,
      purpose: "entry_evaluation",
      scoreFormulaVersion,
      taxonomySnapshotId: taxonomy.id,
    })
    if (options.automatic) {
      const failedJob = (await this.options.dataStore.getEntryProcessingJobs(userId, entryId)).find(
        (candidate) => candidate.idempotencyKey === idempotencyKey && candidate.status === "failed",
      )
      if (failedJob) return { job: failedJob, outcome: "failed_requires_retry" }
    }
    const job: ProcessingJobRecord = {
      attemptCount: 0,
      contentFingerprint: fingerprint,
      entryId,
      finishedAt: null,
      forceRerun: options.forceRerun ?? false,
      id: `job_${randomUUID().replaceAll("-", "")}`,
      idempotencyKey,
      lastErrorCode: null,
      lastErrorSummary: null,
      nextRetryAt: null,
      priority: Math.min(Math.max(Math.trunc(options.priority ?? 0), -10), 10),
      processorName,
      processorVersion,
      profileSnapshotId: profile.id,
      purpose: "entry_evaluation",
      queuedAt: new Date(),
      scoreFormulaVersion,
      startedAt: null,
      status: "queued",
      supersededByJobId: null,
      taxonomySnapshotId: taxonomy.id,
      userId,
    }
    const result = await this.options.dataStore.enqueueProcessingJob(job)
    if (result.outcome === "created" || result.outcome === "reused") this.kick()
    return result
  }

  private async drain(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      for (;;) {
        const job = await this.options.dataStore.claimNextProcessingJob(new Date())
        if (!job) break
        await this.execute(job)
      }
    } finally {
      this.processing = false
    }
  }

  private async execute(job: ProcessingJobRecord): Promise<void> {
    const attemptStartedAt = new Date()
    try {
      const [entry, profile, taxonomy, provider] = await Promise.all([
        this.options.dataStore.getEntry(job.userId, job.entryId),
        this.options.dataStore.getProcessingProfileSnapshot(job.userId, job.profileSnapshotId),
        this.options.dataStore.getProcessingTaxonomySnapshot(job.userId, job.taxonomySnapshotId),
        this.options.resolveProvider(job.userId),
      ])
      if (!entry) throw new ProcessingError("entry_not_found", "Entry not found")
      if (!profile || !taxonomy) {
        throw new ProcessingError("configuration_not_found", "Processing configuration was removed")
      }
      const completion = await provider.complete({
        json: true,
        system:
          "You evaluate one RSS entry for its owner. Return only a JSON object matching the requested schema. Scores are integers from 0 to 100.",
        temperature: 0.1,
        user: JSON.stringify({
          entry: {
            author: entry.author,
            content: entry.content ?? entry.description,
            published_at: entry.publishedAt.toISOString(),
            title: entry.title,
            url: entry.url,
          },
          output_schema: {
            importance_score: "0..100",
            primary_category: "string",
            recommendation_reason: "string",
            relevance_score: "0..100",
            secondary_category: "string|null",
            summary: "string",
            tags: ["string"],
            timeliness_score: "0..100",
          },
          profile: profile.content,
          taxonomy: taxonomy.content,
        }),
      })
      const parsed = evaluationSchema.parse(JSON.parse(cleanJSONCompletion(completion.content)))
      const importanceScore = Math.round(parsed.importance_score)
      const timelinessScore = Math.round(parsed.timeliness_score)
      const relevanceScore = Math.round(parsed.relevance_score)
      const overallScore = Math.round(
        importanceScore * 0.3 + timelinessScore * 0.2 + relevanceScore * 0.5,
      )
      const processedAt = new Date()
      const evaluation: EntryEvaluationRecord = {
        contentFingerprint: job.contentFingerprint,
        details: {
          model: completion.model,
          usage: completion.usage,
        },
        entryId: job.entryId,
        id: `eval_${randomUUID().replaceAll("-", "")}`,
        importanceScore,
        overallScore,
        primaryCategory: parsed.primary_category,
        processedAt,
        processorName: job.processorName,
        processorType: "ai",
        processorVersion: job.processorVersion,
        profileSnapshotId: job.profileSnapshotId,
        recommendationReason: parsed.recommendation_reason,
        relevanceScore,
        scoreFormulaVersion: job.scoreFormulaVersion,
        secondaryCategory: parsed.secondary_category ?? null,
        tags: [...new Set(parsed.tags)],
        taxonomySnapshotId: job.taxonomySnapshotId,
        timelinessScore,
      }
      const attempt: ProcessingAttemptRecord = {
        attemptNumber: job.attemptCount,
        errorSummary: null,
        executionMetadata: { model: completion.model, usage: completion.usage },
        finishedAt: processedAt,
        id: `attempt_${randomUUID().replaceAll("-", "")}`,
        jobId: job.id,
        startedAt: attemptStartedAt,
        status: "succeeded",
      }
      await this.options.dataStore.completeProcessingJob({
        attempt,
        evaluation,
        jobId: job.id,
      })
      if (parsed.summary) {
        try {
          await this.options.dataStore.setEntrySummary(job.userId, {
            createdAt: processedAt,
            entryId: job.entryId,
            language: "auto",
            model: completion.model,
            summary: parsed.summary,
            target: "content",
          })
        } catch (error) {
          this.options.onError?.(error)
        }
      }
    } catch (error) {
      const finishedAt = new Date()
      const failure = publicError(error)
      const canRetry = job.attemptCount < this.maxAttempts
      const nextRetryAt = canRetry
        ? new Date(finishedAt.getTime() + this.retryBaseDelayMs * 2 ** (job.attemptCount - 1))
        : null
      await this.options.dataStore.failProcessingJob({
        attempt: {
          attemptNumber: job.attemptCount,
          errorSummary: failure.summary,
          executionMetadata: null,
          finishedAt,
          id: `attempt_${randomUUID().replaceAll("-", "")}`,
          jobId: job.id,
          startedAt: attemptStartedAt,
          status: "failed",
        },
        errorCode: failure.code,
        errorSummary: failure.summary,
        jobId: job.id,
        nextRetryAt,
      })
    }
  }
}
