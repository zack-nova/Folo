import { randomUUID } from "node:crypto"

import { createClient } from "@redis/client"
import { z } from "zod"

import type { CachedRssHubResponse, RateLimitDecision, SourceResponseCache } from "./source-scaling"
import { sourceCacheKey } from "./source-scaling"

const cachedResponse = z
  .object({
    body: z.string(),
    contentType: z.string().max(256).nullable(),
    etag: z.string().max(512).nullable(),
    lastModified: z.string().max(128).nullable(),
    upstreamURL: z.string().max(2_048),
  })
  .strict()

interface RedisCacheClient {
  readonly isOpen: boolean
  readonly isReady: boolean
  del(key: string): Promise<number>
  destroy(): void
  get(key: string): Promise<string | null>
  sendCommand(args: string[]): Promise<unknown>
  set(key: string, value: string, options: { EX: number }): Promise<string | null>
}

const rateLimitScript = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('TTL', KEYS[1]) }
`
const acquireLeaseScript = `
local serverTime = redis.call('TIME')
local now = (tonumber(serverTime[1]) * 1000) + math.floor(tonumber(serverTime[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

export class RedisSourceResponseCache implements SourceResponseCache {
  private constructor(
    private readonly client: RedisCacheClient,
    private readonly maximumBodyBytes: number,
  ) {}

  static async connect(
    url: string,
    connectTimeoutMs: number,
    maximumBodyBytes: number,
  ): Promise<RedisSourceResponseCache> {
    const client = createClient({
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: (retries) =>
          retries >= 5 ? false : Math.min(100 * 2 ** retries, 2_000),
      },
      url,
    })
    client.on("error", () => {})
    await client.connect()
    return new RedisSourceResponseCache(client, maximumBodyBytes)
  }

  async acquireLease(policyKey: string, limit: number, leaseMs: number): Promise<string | null> {
    const token = randomUUID()
    const result = await this.client.sendCommand([
      "EVAL",
      acquireLeaseScript,
      "1",
      this.leaseKey(policyKey),
      String(limit),
      String(leaseMs),
      token,
    ])
    if (Number(result) === 0) return null
    if (Number(result) !== 1) throw new Error("Redis returned an invalid lease result")
    return token
  }

  async close(): Promise<void> {
    if (this.client.isOpen) this.client.destroy()
  }

  async consumeRateLimit(
    policyKey: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const result = await this.client.sendCommand([
      "EVAL",
      rateLimitScript,
      "1",
      `folo:feed-supplier:v1:rate:${sourceCacheKey(policyKey)}`,
      String(windowSeconds),
    ])
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error("Redis returned an invalid rate limit result")
    }
    const count = Number(result[0])
    const retryAfterSeconds = Number(result[1])
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(retryAfterSeconds)) {
      throw new TypeError("Redis returned an invalid rate limit result")
    }
    return { allowed: count <= limit, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
  }

  async getResponse(logicalURL: string): Promise<CachedRssHubResponse | null> {
    const value = await this.client.get(this.key(logicalURL))
    if (!value) return null
    try {
      const parsed = cachedResponse.safeParse(JSON.parse(value))
      if (parsed.success && Buffer.byteLength(parsed.data.body) <= this.maximumBodyBytes) {
        return parsed.data
      }
    } catch {}
    await this.client.del(this.key(logicalURL))
    return null
  }

  isReady(): boolean {
    return this.client.isReady
  }

  async releaseLease(policyKey: string, token: string): Promise<void> {
    await this.client.sendCommand(["ZREM", this.leaseKey(policyKey), token])
  }

  async setResponse(
    logicalURL: string,
    response: CachedRssHubResponse,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(this.key(logicalURL), JSON.stringify(response), { EX: ttlSeconds })
  }

  private key(logicalURL: string): string {
    return `folo:feed-supplier:v1:response:${sourceCacheKey(logicalURL)}`
  }

  private leaseKey(policyKey: string): string {
    return `folo:feed-supplier:v1:lease:${sourceCacheKey(policyKey)}`
  }
}
