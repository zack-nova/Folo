export type AIProviderConfiguration = {
  base_url: string | null
  configured: boolean
  key_hint: string | null
  key_source: "stored" | "environment" | null
  model: string | null
  type: "openai-compatible"
}

export type ProcessingSnapshot = {
  id: string
  name: string
  version: number
  content: Record<string, unknown>
  contentHash: string
  createdAt: string
}

export type EntryEvaluation = {
  id: string
  entry_id: string
  importance_score: number
  timeliness_score: number
  relevance_score: number
  overall_score: number
  recommendation_reason: string
  primary_category: string
  secondary_category: string | null
  tags: string[]
  processor_type: string
  processor_name: string
  processor_version: string
  score_formula_version: string
  profile_snapshot_id: string
  taxonomy_snapshot_id: string
  content_fingerprint: string
  processed_at: string
  details: Record<string, unknown>
  configuration_outdated: boolean
}

export type ProcessingJobStatus = "queued" | "running" | "succeeded" | "failed" | "superseded"

export type ProcessingJob = {
  id: string
  entry_id: string
  purpose: "entry_evaluation"
  processor_name: string
  processor_version: string
  score_formula_version: string
  profile_snapshot_id: string
  taxonomy_snapshot_id: string
  status: ProcessingJobStatus
  priority: number
  attempt_count: number
  queued_at: string
  started_at: string | null
  finished_at: string | null
  next_retry_at: string | null
  last_error_code: string | null
  last_error_summary: string | null
  force_rerun: boolean
  superseded_by_job_id: string | null
}

export type EntryProjection = {
  evaluation: EntryEvaluation | null
  processing_status: ProcessingJob | null
}

export type EntryEvaluationHistory = {
  current: EntryEvaluation | null
  history: EntryEvaluation[]
}

export type ProcessingStatusHistory = {
  current: ProcessingJob | null
  jobs: ProcessingJob[]
}

export type ProcessingJobOutcome =
  | { outcome: "already_satisfied"; evaluation: EntryEvaluation }
  | { outcome: "created"; job: ProcessingJob; superseded: number }
  | { outcome: "reused"; job: ProcessingJob }

export type ReEvaluationScope = {
  entry_ids?: string[]
  feed_id?: string
  feed_ids?: string[]
  view?: number
  published_after?: string
  published_before?: string
  force_rerun?: boolean
  profile_snapshot_id?: string
  taxonomy_snapshot_id?: string
  limit?: number
}

export type ReEvaluationPreview = {
  active: number
  already_satisfied: number
  estimated_calls: number
  matched: number
  profile_snapshot_id: string
  taxonomy_snapshot_id: string
}

export type ReEvaluationResult = {
  already_satisfied: number
  created: number
  job_ids: string[]
  matched: number
  reused: number
  skipped: number
  superseded: number
}

export type SnapshotCollection = {
  current: ProcessingSnapshot | null
  snapshots: ProcessingSnapshot[]
}
