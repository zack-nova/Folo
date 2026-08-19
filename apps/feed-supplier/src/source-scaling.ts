import { createHash, randomUUID } from "node:crypto"

export interface CachedRssHubResponse {
  body: string
  contentType: string | null
  etag: string | null
  lastModified: string | null
  upstreamURL: string
}

export interface SourceResponseCache {
  acquireLease(policyKey: string, limit: number, leaseMs: number): Promise<string | null>
  close(): Promise<void>
  consumeRateLimit(
    policyKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision>
  getResponse(logicalURL: string): Promise<CachedRssHubResponse | null>
  isReady(): boolean
  releaseLease(policyKey: string, token: string): Promise<void>
  setResponse(logicalURL: string, response: CachedRssHubResponse, ttlSeconds: number): Promise<void>
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

export interface SourceScalingSnapshot {
  activeRequestCount: number
  cacheHitCount: number
  cacheMissCount: number
  coalescedRequestCount: number
  concurrencyRejectedRequestCount: number
  rateLimitedRequestCount: number
}

export class SourceScalingTelemetry {
  private activeRequestCount = 0
  private cacheHitCount = 0
  private cacheMissCount = 0
  private coalescedRequestCount = 0
  private concurrencyRejectedRequestCount = 0
  private rateLimitedRequestCount = 0

  beginRequest(): () => void {
    this.activeRequestCount += 1
    return () => {
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1)
    }
  }

  recordCacheHit(): void {
    this.cacheHitCount += 1
  }

  recordCacheMiss(): void {
    this.cacheMissCount += 1
  }

  recordCoalescedRequest(): void {
    this.coalescedRequestCount += 1
  }

  recordConcurrencyRejection(): void {
    this.concurrencyRejectedRequestCount += 1
  }

  recordRateLimit(): void {
    this.rateLimitedRequestCount += 1
  }

  snapshot(): SourceScalingSnapshot {
    return {
      activeRequestCount: this.activeRequestCount,
      cacheHitCount: this.cacheHitCount,
      cacheMissCount: this.cacheMissCount,
      coalescedRequestCount: this.coalescedRequestCount,
      concurrencyRejectedRequestCount: this.concurrencyRejectedRequestCount,
      rateLimitedRequestCount: this.rateLimitedRequestCount,
    }
  }
}

export class SourceScalingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export interface CoalescedResult<T> {
  coalesced: boolean
  value: T
}

export const sourceCacheKey = (logicalURL: string): string =>
  createHash("sha256").update(logicalURL).digest("hex")

export class MemorySourceResponseCache implements SourceResponseCache {
  private readonly responses = new Map<
    string,
    { expiresAt: number; response: CachedRssHubResponse }
  >()
  private readonly rateLimits = new Map<string, { count: number; expiresAt: number }>()
  private readonly leases = new Map<string, Map<string, number>>()

  async acquireLease(policyKey: string, limit: number, leaseMs: number): Promise<string | null> {
    const key = sourceCacheKey(policyKey)
    const now = Date.now()
    const leases = this.leases.get(key) ?? new Map<string, number>()
    for (const [token, expiresAt] of leases) {
      if (expiresAt <= now) leases.delete(token)
    }
    if (leases.size >= limit) return null
    const token = randomUUID()
    leases.set(token, now + leaseMs)
    this.leases.set(key, leases)
    return token
  }

  async close(): Promise<void> {}

  async consumeRateLimit(
    policyKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const key = sourceCacheKey(policyKey)
    const now = Date.now()
    const current = this.rateLimits.get(key)
    const entry =
      !current || current.expiresAt <= now
        ? { count: 0, expiresAt: now + windowSeconds * 1_000 }
        : current
    entry.count += 1
    this.rateLimits.set(key, entry)
    return {
      allowed: entry.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000)),
    }
  }

  async getResponse(logicalURL: string): Promise<CachedRssHubResponse | null> {
    const key = sourceCacheKey(logicalURL)
    const entry = this.responses.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.responses.delete(key)
      return null
    }
    return { ...entry.response }
  }

  async setResponse(
    logicalURL: string,
    response: CachedRssHubResponse,
    ttlSeconds: number,
  ): Promise<void> {
    this.responses.set(sourceCacheKey(logicalURL), {
      expiresAt: Date.now() + ttlSeconds * 1_000,
      response: { ...response },
    })
  }

  isReady(): boolean {
    return true
  }

  async releaseLease(policyKey: string, token: string): Promise<void> {
    const key = sourceCacheKey(policyKey)
    const leases = this.leases.get(key)
    leases?.delete(token)
    if (leases?.size === 0) this.leases.delete(key)
  }
}

export class SourceRequestCoalescer {
  private readonly pending = new Map<string, Promise<unknown>>()

  async run<T>(logicalURL: string, load: () => Promise<T>): Promise<CoalescedResult<T>> {
    const key = sourceCacheKey(logicalURL)
    const existing = this.pending.get(key) as Promise<T> | undefined
    if (existing) return { coalesced: true, value: await existing }

    const pending = load().finally(() => this.pending.delete(key))
    this.pending.set(key, pending)
    return { coalesced: false, value: await pending }
  }
}
