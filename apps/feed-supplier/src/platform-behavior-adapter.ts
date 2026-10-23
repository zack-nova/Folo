import type {
  PlatformBehaviorPlatform,
  PlatformBehaviorScope,
  PlatformBehaviorSource,
} from "@follow/feed-source-contracts"

import type { BehaviorSnapshot } from "./platform-behavior-repository"

export class PlatformBehaviorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 502,
  ) {
    super(message)
  }
}

/** One followed account or favorited item as the platform lists it right now. */
export interface BehaviorObject {
  /** Stable platform identity within the scope, such as a UID or BV number */
  key: string
  /** When the user followed or favorited it, if the platform says */
  occurredAt: string | null
  title: string
  url: string
  snapshot: BehaviorSnapshot
}

export interface BehaviorReadRequest {
  accountId: string
  scope: PlatformBehaviorScope
  /** Login value from the bound credential, or null to read anonymously */
  credential: string | null
  /**
   * Objects up to this time were read before, so paging can stop once a page reaches it. Null on
   * the baseline read, which only reads the newest page.
   */
  knownUntil: string | null
  /** No request starts after this `Date.now()` value; what was read until then still counts. */
  deadline: number
  /** Where an unfinished baseline read stopped, as returned in `nextCursor` */
  cursor: string | null
  /** A dry run for the owner: adapters may read only the first page of each list */
  preview: boolean
  /** Which of these keys the source has seen, so lists without times can stop paging */
  known: (keys: string[]) => Promise<Set<string>>
}

export interface BehaviorReadResult {
  objects: BehaviorObject[]
  requestCount: number
  /** Parts that were not read, in words the owner can act on */
  notes: string[]
  /**
   * Set when a baseline read of a list without platform times ran out of time: the next check
   * continues here and nothing is published until a read completes.
   */
  nextCursor: string | null
  /** The platform pushed back during an unfinished baseline; it continues later than usual. */
  pushedBack?: boolean
}

export interface RenderedBehaviorEntry {
  /** Objects the entry announces; their keys also make the entry GUID */
  objectKeys: string[]
  title: string
  url: string
  summary: string
  /** HTML body */
  content: string
  imageURL: string | null
  /** When it happened on the platform; null publishes it at the time it was discovered */
  occurredAt: string | null
}

/**
 * What a platform contributes to behavior sources (ADR-0037): reading the current follows or
 * favorites of one account, and describing newly appeared ones as feed entries. Baselines,
 * diffs, scheduling and storage are shared.
 */
export interface PlatformBehaviorAdapter {
  readonly platform: PlatformBehaviorPlatform
  readonly scopes: readonly PlatformBehaviorScope[]
  readonly accountIdPattern: RegExp
  read(request: BehaviorReadRequest): Promise<BehaviorReadResult>
  render(source: PlatformBehaviorSource, objects: BehaviorObject[]): RenderedBehaviorEntry[]
  /** Page the feed links to as its channel */
  profileURL(source: PlatformBehaviorSource): string
}
