import { createHmac, timingSafeEqual } from "node:crypto"

import type { SourceAuditAction, SourceAuditEvent } from "@follow/feed-source-contracts"

export type AuditDetails = Record<string, boolean | number | string | null>

export interface AuditEventDraft {
  action: SourceAuditAction
  actor: string
  details: AuditDetails
  id: string
  occurredAt: string
  resourceId: string | null
  resourceType: SourceAuditEvent["resourceType"]
}

const stableValue = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value)
  }
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    )
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`
  }
  throw new Error("Audit values must be JSON serializable")
}

export const auditEventHash = (
  event: AuditEventDraft,
  previousHash: string | null,
  key: Buffer,
): string =>
  createHmac("sha256", key)
    .update(
      stableValue({
        action: event.action,
        actor: event.actor,
        details: event.details,
        id: event.id,
        occurredAt: event.occurredAt,
        previousHash,
        resourceId: event.resourceId,
        resourceType: event.resourceType,
      }),
    )
    .digest("hex")

export const auditHashesMatch = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "hex")
  const rightBuffer = Buffer.from(right, "hex")
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}
