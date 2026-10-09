import { randomUUID } from "node:crypto"

import { z } from "zod"

import type { AIProvider } from "../ai/provider"
import type {
  AIChatMessageRecord,
  AIChatSessionRecord,
  AITaskRecord,
  AITaskRunKind,
  AITaskRunRecord,
  AITaskRunStatus,
  DataStore,
} from "../data/types"
import { FEATURED_SCORE_THRESHOLD } from "../processing/featured"
import { cleanJSONCompletion, ProcessingError } from "../processing/service"
import type { BriefingFooter } from "./briefing"
import {
  briefingSystemPrompt,
  briefingUserMessage,
  emptyBriefing,
  failedBriefing,
  parseBriefingOutput,
  renderBriefing,
  selectBriefingEntries,
} from "./briefing"
import { taskPromptText } from "./prompt-text"
import { latestDueScheduleRun, nextScheduleRun, schedulePeriodStart } from "./schedule"

const MINUTE_MS = 60 * 1_000
/** Delays before the second, third and fourth attempt of a scheduled run (ADR-0036). */
const DEFAULT_RETRY_DELAYS_MS = [5 * MINUTE_MS, 15 * MINUTE_MS, 45 * MINUTE_MS]
/** A run still marked running after this long was interrupted, for example by a restart. */
const DEFAULT_STALE_RUN_MS = 30 * MINUTE_MS
/**
 * Entries imported just before a slot may still be queued for evaluation. The next window starts
 * at this slot, so a briefing that ran without them would never include them: a scheduled run
 * waits for those evaluations, checking again every few minutes, for at most this long.
 */
const DEFAULT_EVALUATION_WAIT_MS = 30 * MINUTE_MS
const EVALUATION_RECHECK_MS = 2 * MINUTE_MS
const TICK_BATCH = 20
const LAST_RESULT_CHARACTERS = 200

export interface AITaskServiceOptions {
  dataStore: DataStore
  onError?: (error: unknown) => void
  pollIntervalMs?: number
  /** Briefings are written for the owner, so they count as owner-requested work. */
  resolveProvider: (userId: string) => Promise<AIProvider>
  retryDelaysMs?: number[]
  staleRunMs?: number
  evaluationWaitMs?: number
  timeZone: string
  now?: () => Date
}

export class AITaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const publicError = (error: unknown): { code: string; summary: string } => {
  if (error instanceof ProcessingError || error instanceof AITaskError) {
    return { code: error.code, summary: error.message }
  }
  if (error instanceof z.ZodError) {
    return { code: "invalid_ai_response", summary: "AI response did not match the briefing schema" }
  }
  if (error instanceof SyntaxError) {
    return { code: "invalid_ai_response", summary: "AI response was not valid JSON" }
  }
  return {
    code: "ai_provider_error",
    summary: error instanceof Error ? error.message.slice(0, 1_000) : "Briefing generation failed",
  }
}

/** Not a failure: the run goes back to the queue without using up an attempt. */
class AITaskDeferred extends Error {
  constructor(readonly until: Date) {
    super("Waiting for pending evaluations")
  }
}

type RunCounts = Record<
  AITaskRunKind,
  Record<Exclude<AITaskRunStatus, "queued" | "running">, number>
>

/** Chat ids start with `ai-task-{taskId}`, which the client uses to find a task's reports. */
export const aiTaskSessionId = (taskId: string, runId: string) => `ai-task-${taskId}-${runId}`

export class AITaskService {
  private timer: NodeJS.Timeout | null = null
  private activeTick: Promise<void> | null = null
  private readonly counts: RunCounts = {
    scheduled: { failed: 0, skipped: 0, succeeded: 0 },
    test: { failed: 0, skipped: 0, succeeded: 0 },
  }
  private readonly tokens = { cachedInput: 0, input: 0, output: 0 }

  constructor(private readonly options: AITaskServiceOptions) {}

  private now() {
    return this.options.now?.() ?? new Date()
  }

  start(): void {
    if (this.timer) return
    const interval = this.options.pollIntervalMs ?? MINUTE_MS
    if (interval <= 0) return
    this.timer = setInterval(() => void this.tick(), interval)
    this.timer.unref()
    void this.tick()
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.activeTick
  }

  runCounts(): RunCounts {
    return structuredClone(this.counts)
  }

  tokenUsage() {
    return { ...this.tokens }
  }

  /** One scheduler pass: records due slots, then works through runnable runs one at a time. */
  tick(): Promise<void> {
    this.activeTick ??= this.runTick()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        this.activeTick = null
      })
    return this.activeTick
  }

  private async runTick(): Promise<void> {
    const { dataStore } = this.options
    for (const task of await dataStore.listDueAITasks(this.now(), TICK_BATCH)) {
      await this.scheduleDueTask(task)
    }
    const staleBefore = new Date(
      this.now().getTime() - (this.options.staleRunMs ?? DEFAULT_STALE_RUN_MS),
    )
    for (const run of await dataStore.listRunnableAITaskRuns(this.now(), staleBefore, TICK_BATCH)) {
      const claimed = await dataStore.claimAITaskRun(run.id, this.now(), staleBefore)
      if (claimed) await this.execute(claimed)
    }
  }

  private newRun(
    task: AITaskRecord,
    kind: AITaskRunKind,
    scheduledFor: Date,
    window: { end: Date; start: Date },
  ): AITaskRunRecord {
    const now = this.now()
    return {
      attemptCount: 0,
      candidateCount: null,
      createdAt: now,
      errorCode: null,
      errorSummary: null,
      finishedAt: null,
      id: randomUUID(),
      kind,
      nextAttemptAt: now,
      scheduledFor,
      selectedCount: null,
      sessionId: null,
      startedAt: null,
      status: "queued",
      taskId: task.id,
      pendingEvaluationCount: null,
      usage: null,
      userId: task.userId,
      windowEnd: window.end,
      windowStart: window.start,
    }
  }

  private async scheduleDueTask(task: AITaskRecord): Promise<void> {
    const slot = task.nextRunAt
    if (!slot) return
    const { timeZone } = this.options
    const { latest, missed, next } = latestDueScheduleRun(task.schedule, slot, this.now(), timeZone)
    if (missed > 0) {
      // The service was down past more than one slot: only the latest one is caught up.
      const skipped = {
        ...this.newRun(task, "scheduled", slot, { end: slot, start: slot }),
        errorCode: "missed_slots_skipped",
        errorSummary: `${missed} missed slot(s) skipped; the latest one runs instead`,
        finishedAt: this.now(),
        nextAttemptAt: null,
        status: "skipped" as const,
      }
      if (await this.options.dataStore.scheduleAITaskRun(skipped, latest)) {
        this.counts.scheduled.skipped += 1
      }
      return
    }
    const previous = await this.options.dataStore.getPreviousAITaskRun(task.id, slot)
    const start =
      previous?.status === "succeeded"
        ? previous.windowEnd
        : schedulePeriodStart(task.schedule, slot, timeZone)
    await this.options.dataStore.scheduleAITaskRun(
      this.newRun(task, "scheduled", slot, { end: slot, start }),
      next,
    )
  }

  /**
   * Runs the task now over the last schedule period without moving its schedule. Waits for the
   * report so the client can open it.
   */
  async testRun(task: AITaskRecord): Promise<{ sessionId: string } | { error: string }> {
    const now = this.now()
    const run = this.newRun(task, "test", now, {
      end: now,
      start: schedulePeriodStart(task.schedule, now, this.options.timeZone),
    })
    await this.options.dataStore.createAITaskRun({
      ...run,
      attemptCount: 1,
      nextAttemptAt: null,
      startedAt: now,
      status: "running",
    })
    const result = await this.execute({
      ...run,
      attemptCount: 1,
      startedAt: now,
      status: "running",
    })
    return result.sessionId ? { sessionId: result.sessionId } : { error: result.error ?? "Failed" }
  }

  private async execute(run: AITaskRunRecord): Promise<{ error?: string; sessionId?: string }> {
    const { dataStore } = this.options
    const task = await dataStore.getAITask(run.userId, run.taskId)
    if (!task) {
      await dataStore.updateAITaskRun({
        ...run,
        errorCode: "task_not_found",
        errorSummary: "The task was deleted",
        finishedAt: this.now(),
        status: "failed",
      })
      return { error: "The task was deleted" }
    }
    try {
      return { sessionId: await this.generate(task, run) }
    } catch (error) {
      if (error instanceof AITaskDeferred) {
        await dataStore.updateAITaskRun({
          ...run,
          attemptCount: run.attemptCount - 1,
          nextAttemptAt: error.until,
          startedAt: null,
          status: "queued",
        })
        return { error: error.message }
      }
      const failure = publicError(error)
      const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
      const failed = { ...run, errorCode: failure.code, errorSummary: failure.summary }
      if (run.kind === "scheduled" && run.attemptCount <= delays.length) {
        await dataStore.updateAITaskRun({
          ...failed,
          nextAttemptAt: new Date(this.now().getTime() + delays[run.attemptCount - 1]!),
          status: "queued",
        })
        return { error: failure.summary }
      }
      this.counts[run.kind].failed += 1
      if (run.kind === "test") {
        await dataStore.updateAITaskRun({ ...failed, finishedAt: this.now(), status: "failed" })
        return { error: failure.summary }
      }
      // A scheduled run that gives up still leaves a report: the client does not show lastError.
      const sessionId = aiTaskSessionId(task.id, run.id)
      await this.store(
        task,
        { ...failed, sessionId, status: "failed" },
        {
          lastError: `${failure.code}: ${failure.summary}`,
          lastResult: null,
          markdown: failedBriefing(failure, run.attemptCount),
          metadata: {},
        },
      )
      return { error: failure.summary }
    }
  }

  private async generate(task: AITaskRecord, run: AITaskRunRecord): Promise<string> {
    const { dataStore, timeZone } = this.options
    const startedAt = this.now()
    const [{ candidates, pendingEvaluationCount }, profiles, taxonomies] = await Promise.all([
      dataStore.listBriefingCandidates({
        insertedAfter: run.windowStart,
        insertedBefore: run.windowEnd,
        minimumScore: FEATURED_SCORE_THRESHOLD,
        userId: task.userId,
      }),
      dataStore.listProcessingProfileSnapshots(task.userId),
      dataStore.listProcessingTaxonomySnapshots(task.userId),
    ])
    const waitUntil =
      run.scheduledFor.getTime() + (this.options.evaluationWaitMs ?? DEFAULT_EVALUATION_WAIT_MS)
    if (
      run.kind === "scheduled" &&
      pendingEvaluationCount > 0 &&
      this.now().getTime() < waitUntil
    ) {
      throw new AITaskDeferred(
        new Date(Math.min(this.now().getTime() + EVALUATION_RECHECK_MS, waitUntil)),
      )
    }
    const entries = selectBriefingEntries(candidates, taxonomies, run.windowEnd)
    const footer: BriefingFooter = {
      candidateCount: candidates.length,
      pendingEvaluationCount,
      selectedCount: entries.length,
      timeZone,
      windowEnd: run.windowEnd,
      windowStart: run.windowStart,
    }
    const counted = {
      ...run,
      candidateCount: candidates.length,
      pendingEvaluationCount,
      selectedCount: entries.length,
    }
    const sessionId = aiTaskSessionId(task.id, run.id)
    if (entries.length === 0) {
      const markdown = emptyBriefing(footer)
      await this.store(
        task,
        { ...counted, sessionId, status: "succeeded" },
        {
          lastError: null,
          lastResult: "这段时间没有达到精选门槛的新条目。",
          markdown,
          metadata: { duration: this.now().getTime() - startedAt.getTime() },
        },
      )
      return sessionId
    }

    const provider = await this.options.resolveProvider(task.userId)
    const completion = await provider.complete({
      json: true,
      system: briefingSystemPrompt(profiles.at(0)?.content ?? null),
      temperature: 0.3,
      user: briefingUserMessage({
        entries,
        instructions: taskPromptText(task.prompt),
        timeZone,
        windowEnd: run.windowEnd,
        windowStart: run.windowStart,
      }),
    })
    const usage = completion.usage
    this.tokens.input += usage.inputTokens ?? 0
    this.tokens.cachedInput += usage.cachedInputTokens ?? 0
    this.tokens.output += usage.outputTokens ?? 0
    const output = parseBriefingOutput(cleanJSONCompletion(completion.content))
    const { markdown } = renderBriefing(output, entries, footer)
    const overview = output.overview.trim()
    await this.store(
      task,
      {
        ...counted,
        sessionId,
        status: "succeeded",
        usage: { model: completion.model, ...usage },
      },
      {
        lastError: null,
        lastResult: [...(overview || markdown)].slice(0, LAST_RESULT_CHARACTERS).join(""),
        markdown,
        metadata: {
          duration: this.now().getTime() - startedAt.getTime(),
          modelUsed: completion.model,
          providerType: "byok",
          ...(usage.inputTokens !== null && usage.outputTokens !== null
            ? { totalTokens: usage.inputTokens + usage.outputTokens }
            : {}),
          ...(usage.outputTokens === null ? {} : { outputTokens: usage.outputTokens }),
          ...(usage.cachedInputTokens == null
            ? {}
            : { cachedInputTokens: usage.cachedInputTokens }),
        },
      },
    )
    return sessionId
  }

  /** Writes the report session and the run's final state together. */
  private async store(
    task: AITaskRecord,
    run: AITaskRunRecord & { sessionId: string; status: "failed" | "succeeded" },
    report: {
      lastError: string | null
      lastResult: string | null
      markdown: string
      metadata: Record<string, unknown>
    },
  ): Promise<void> {
    const finishedAt = this.now()
    const day = new Intl.DateTimeFormat("zh-CN", {
      day: "numeric",
      month: "long",
      timeZone: this.options.timeZone,
    }).format(run.kind === "test" ? finishedAt : run.scheduledFor)
    const session: AIChatSessionRecord = {
      chatId: run.sessionId,
      createdAt: finishedAt,
      // Earlier than updatedAt, so a new report starts unread.
      lastSeenAt: new Date(finishedAt.getTime() - 1),
      title: `${task.name} · ${day}${run.kind === "test" ? " · 试运行" : ""}`,
      updatedAt: finishedAt,
      userId: task.userId,
    }
    const message: AIChatMessageRecord = {
      chatId: session.chatId,
      createdAt: finishedAt,
      finishedAt,
      id: randomUUID(),
      // The client refetches assistant messages without metadata on every open.
      metadata: { finishTime: finishedAt.toISOString(), ...report.metadata },
      messageParts: [{ text: report.markdown, type: "text" }],
      role: "assistant",
      status: run.status === "failed" ? "error" : "completed",
    }
    await this.options.dataStore.completeAITaskRun({
      message,
      run: { ...run, finishedAt, nextAttemptAt: null },
      session,
      task: {
        countRun: run.kind === "scheduled",
        id: task.id,
        lastError: report.lastError,
        lastResult: report.lastResult,
        lastRunAt: finishedAt,
      },
    })
    if (run.status === "succeeded") this.counts[run.kind].succeeded += 1
  }

  /** The first slot after now, for a task that was created, edited or re-enabled. */
  nextRunAfterNow(task: Pick<AITaskRecord, "isEnabled" | "schedule">): Date | null {
    return task.isEnabled ? nextScheduleRun(task.schedule, this.now(), this.options.timeZone) : null
  }
}
