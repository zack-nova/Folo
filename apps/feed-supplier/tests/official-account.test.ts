import { createServer as createHTTPServer } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { connect as netConnect, createServer as createTCPServer } from "node:net"

import type { OfficialAccountSummary, SourceAuditEvent } from "@follow/feed-source-contracts"
import { afterEach, describe, expect, it, vi } from "vitest"

import { loadFeedSupplierConfig } from "../src/config"
import type {
  OfficialHTTPRequest,
  OfficialHTTPResponse,
  OfficialTransport,
} from "../src/folo-official-client"
import {
  fetchTransport,
  FoloOfficialClient,
  OfficialAPIError,
  OfficialConnectionError,
  proxyTransport,
} from "../src/folo-official-client"
import { MemorySupplierRepository } from "../src/memory-repository"
import { PostgresSupplierRepository } from "../src/postgres-repository"
import type { SupplierRepository } from "../src/repository"
import { buildFeedSupplier } from "../src/server"
import { isolatedDatabaseURL } from "./support/postgres-database"

const TOKEN = "official-session-token-1234567890.signature"
const OTHER_TOKEN = "official-session-token-abcdefghij.signature"

const baseEnvironment = {
  INTERNAL_TOKEN: "internal-supplier-token-0000000000000000",
  NODE_ENV: "test",
  RSSHUB_ACCESS_KEY: "rsshub-access-key-11111111111111111111",
  RSSHUB_BASE_URL: "http://rsshub:1200",
}
const officialEnvironment = { ...baseEnvironment, FOLO_OFFICIAL_API_URL: "https://api.folo.test" }
const config = loadFeedSupplierConfig(officialEnvironment)
const admin = { authorization: `Bearer ${config.adminToken}` }

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({
    body: JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json", ...headers }),
    status,
  }) satisfies OfficialHTTPResponse

const session = (overrides: { role?: string; userId?: string } = {}) =>
  json(200, {
    feedSubscriptionLimit: 150,
    role: overrides.role ?? "free",
    rsshubSubscriptionLimit: 30,
    session: { createdAt: "2026-10-05T06:19:29.065Z", expiresAt: "2026-11-04T06:19:29.065Z" },
    user: { email: "owner@example.com", id: overrides.userId ?? "1171163283428605952" },
  })

/** A fake official API keyed by session token. */
const fakeOfficialAPI = () => {
  const accepted = new Map<string, () => OfficialHTTPResponse>([[TOKEN, () => session()]])
  const requests: OfficialHTTPRequest[] = []
  const transport = vi.fn<OfficialTransport>(async (request) => {
    requests.push(request)
    const token = /better-auth\.session_token=([^;]+)$/.exec(request.headers.cookie ?? "")?.[1]
    const respond = token ? accepted.get(token) : undefined
    return respond ? respond() : json(200, null)
  })
  return { accepted, requests, transport }
}

const databaseURL = process.env.TEST_FEED_SUPPLIER_DATABASE_URL
  ? await isolatedDatabaseURL(process.env.TEST_FEED_SUPPLIER_DATABASE_URL, "official_accounts")
  : undefined
const repositories: Array<[string, () => SupplierRepository]> = [
  ["memory", () => new MemorySupplierRepository(config.auditHmacKey)],
  ...(databaseURL
    ? [
        [
          "postgres",
          () =>
            new PostgresSupplierRepository({
              auditKey: config.auditHmacKey,
              connectionString: databaseURL,
              maxConnections: 2,
            }),
        ] as [string, () => SupplierRepository],
      ]
    : []),
]

const rssHubProbe = vi.fn<typeof fetch>(async () => new Response("ok"))

describe("official account configuration", () => {
  it("is absent unless the official API URL is set", () => {
    expect(loadFeedSupplierConfig(baseEnvironment).officialAcquisition).toBeNull()
    expect(config.officialAcquisition).toMatchObject({
      apiURL: "https://api.folo.test",
      cacheTTLSeconds: 300,
      concurrency: 2,
      entryLimit: 50,
      proxyURL: null,
    })
  })

  it("rejects unsafe or impossible settings", () => {
    expect(() =>
      loadFeedSupplierConfig({
        ...officialEnvironment,
        FOLO_OFFICIAL_API_URL: "https://a.test/v1",
      }),
    ).toThrow(/origin/)
    expect(() =>
      loadFeedSupplierConfig({ ...officialEnvironment, FOLO_OFFICIAL_ENTRY_LIMIT: "101" }),
    ).toThrow()
    expect(() =>
      loadFeedSupplierConfig({
        ...officialEnvironment,
        FOLO_OFFICIAL_PROXY_URL: "http://proxy.test:7890/path",
      }),
    ).toThrow(/origin/)
    expect(
      loadFeedSupplierConfig({
        ...officialEnvironment,
        FOLO_OFFICIAL_PROXY_URL: "http://user:secret@proxy.test:7890",
      }).officialAcquisition?.proxyURL,
    ).toBe("http://user:secret@proxy.test:7890")
  })

  it("requires HTTPS in production", () => {
    expect(() =>
      loadFeedSupplierConfig({
        ...baseEnvironment,
        ADMIN_TOKEN: "production-admin-token-000000000000000000",
        AUDIT_HMAC_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        CREDENTIAL_ENCRYPTION_KEY: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
        DATABASE_URL: "postgresql://supplier@db/supplier",
        FOLO_OFFICIAL_API_URL: "http://api.folo.test",
        NODE_ENV: "production",
        REDIS_URL: "redis://redis:6379/1",
      }),
    ).toThrow(/FOLO_OFFICIAL_API_URL must use HTTPS/)
  })
})

describe("official API client", () => {
  const clientWith = (transport: OfficialTransport) =>
    new FoloOfficialClient({
      apiURL: "https://api.folo.test",
      retryDelayMs: 0,
      timeoutMs: 1_000,
      transport,
    })

  it("authenticates with the session cookie and identifies itself honestly", async () => {
    const { requests, transport } = fakeOfficialAPI()
    await expect(clientWith(transport).getSession(TOKEN)).resolves.toEqual({
      externalUserId: "1171163283428605952",
      feedSubscriptionLimit: 150,
      role: "free",
      rssHubSubscriptionLimit: 30,
      sessionExpiresAt: "2026-11-04T06:19:29.065Z",
    })
    const [request] = requests
    expect(request!.url.toString()).toBe("https://api.folo.test/better-auth/get-session")
    expect(request!.headers.cookie).toContain(`better-auth.session_token=${TOKEN}`)
    expect(request!.headers.authorization).toBeUndefined()
    expect(request!.headers["user-agent"]).toMatch(/^Folo-Feed-Supplier\//)
  })

  it("maps official errors", async () => {
    const cases: Array<[OfficialHTTPResponse, string, number | null]> = [
      [json(200, null), "auth_invalid", null],
      [json(401, { code: 1000, message: "Unauthorized" }), "auth_invalid", null],
      [json(402, { code: 17003, feature: "PRIVATE_SUBSCRIPTION" }), "plan_denied", null],
      [json(429, { message: "slow down" }, { "retry-after": "12" }), "rate_limited", 12],
      [json(400, { code: 2003, reason: "404 Not Found" }), "unsupported_route", null],
      [json(400, { code: 3 }), "invalid_response", null],
      [json(503, { message: "down" }), "unavailable", null],
      [{ body: "<html>", headers: new Headers(), status: 502 }, "unavailable", null],
      [json(200, { user: {} }), "invalid_response", null],
    ]
    for (const [response, kind, retryAfterSeconds] of cases) {
      const error = await clientWith(async () => response)
        .getSession(TOKEN)
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OfficialAPIError)
      expect((error as OfficialAPIError).kind).toBe(kind)
      if (retryAfterSeconds) expect((error as OfficialAPIError).retryAfterSeconds).toBe(12)
    }
  })

  it("rejects malformed tokens without sending them", async () => {
    const transport = vi.fn<OfficialTransport>()
    for (const token of ["short", `${TOKEN}; other=1`, `${TOKEN} space`]) {
      await expect(clientWith(transport).getSession(token)).rejects.toMatchObject({
        kind: "auth_invalid",
      })
    }
    expect(transport).not.toHaveBeenCalled()
  })

  it("retries only failures that happened before the request was sent", async () => {
    const unsent = vi
      .fn<OfficialTransport>()
      .mockRejectedValueOnce(new OfficialConnectionError("reset", false))
      .mockRejectedValueOnce(new OfficialConnectionError("reset", false))
      .mockResolvedValueOnce(session())
    await expect(clientWith(unsent).getSession(TOKEN)).resolves.toMatchObject({ role: "free" })
    expect(unsent).toHaveBeenCalledTimes(3)

    const sent = vi
      .fn<OfficialTransport>()
      .mockRejectedValue(new OfficialConnectionError("interrupted", true))
    await expect(
      clientWith(sent).request("subscriptions.create", TOKEN, { body: {} }),
    ).rejects.toMatchObject({ kind: "unavailable" })
    expect(sent).toHaveBeenCalledTimes(1)

    const failing = vi
      .fn<OfficialTransport>()
      .mockRejectedValue(new OfficialConnectionError("refused", false))
    await expect(clientWith(failing).getSession(TOKEN)).rejects.toMatchObject({
      kind: "unavailable",
    })
    expect(failing).toHaveBeenCalledTimes(4)
  })

  it("classifies fetch failures by whether the request could have been sent", async () => {
    const failWith = (code: string, message: string) =>
      fetchTransport(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) })
      })
    const request = {
      headers: {},
      maxBytes: 1_000,
      method: "POST",
      timeoutMs: 1_000,
      url: new URL("https://api.folo.test/subscriptions"),
    }
    await expect(
      failWith(
        "ECONNRESET",
        "Client network socket disconnected before secure TLS connection was established",
      )(request),
    ).rejects.toMatchObject({ requestSent: false })
    await expect(failWith("ECONNREFUSED", "connect ECONNREFUSED")(request)).rejects.toMatchObject({
      requestSent: false,
    })
    await expect(failWith("ECONNRESET", "other side closed")(request)).rejects.toMatchObject({
      requestSent: true,
    })
  })

  it("bounds the response size", async () => {
    const transport = fetchTransport(async () => new Response("x".repeat(2_000)))
    await expect(
      transport({
        headers: {},
        maxBytes: 1_000,
        method: "GET",
        timeoutMs: 1_000,
        url: new URL("https://api.folo.test/feeds"),
      }),
    ).rejects.toBeInstanceOf(OfficialConnectionError)
  })
})

describe("official API proxy transport", () => {
  const closers: Array<() => Promise<void>> = []
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()))
  })

  const listen = async (server: ReturnType<typeof createHTTPServer | typeof createTCPServer>) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          if ("closeAllConnections" in server) server.closeAllConnections()
        }),
    )
    return (server.address() as AddressInfo).port
  }

  /** A CONNECT proxy that records tunnel requests and can refuse them. */
  const startProxy = async (refuseWith?: number) => {
    const tunnels: Array<{ authority: string; authorization: string | undefined }> = []
    const sockets = new Set<Socket>()
    const proxy = createHTTPServer()
    proxy.on("connect", (request, client: Socket) => {
      tunnels.push({
        authority: request.url ?? "",
        authorization: request.headers["proxy-authorization"],
      })
      if (refuseWith) {
        client.end(`HTTP/1.1 ${refuseWith} Refused\r\n\r\n`)
        return
      }
      const [host, port] = (request.url ?? "").split(":")
      const upstream = netConnect(Number(port), host!, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        upstream.pipe(client)
        client.pipe(upstream)
      })
      sockets.add(upstream).add(client)
      upstream.on("error", () => client.destroy())
      client.on("error", () => upstream.destroy())
    })
    const port = await listen(proxy)
    closers.push(async () => {
      for (const socket of sockets) socket.destroy()
    })
    return { port, tunnels }
  }

  const request = (url: string, body?: string): OfficialHTTPRequest => ({
    body,
    headers: { accept: "application/json", "content-type": "application/json" },
    maxBytes: 10_000,
    method: body === undefined ? "GET" : "POST",
    timeoutMs: 5_000,
    url: new URL(url),
  })

  it("tunnels requests and returns the response", async () => {
    const received: Array<{ body: string; method?: string; url?: string }> = []
    const target = createHTTPServer((incoming, outgoing) => {
      let body = ""
      incoming.on("data", (chunk) => (body += chunk))
      incoming.on("end", () => {
        received.push({ body, method: incoming.method, url: incoming.url })
        outgoing.writeHead(200, { "content-type": "application/json", "x-test": "yes" })
        outgoing.end(JSON.stringify({ ok: true }))
      })
    })
    const targetPort = await listen(target)
    const proxy = await startProxy()

    const response = await proxyTransport(`http://user:p%40ss@127.0.0.1:${proxy.port}`)(
      request(`http://127.0.0.1:${targetPort}/entries?x=1`, '{"feedId":"1"}'),
    )
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(response.headers.get("x-test")).toBe("yes")
    expect(received).toEqual([{ body: '{"feedId":"1"}', method: "POST", url: "/entries?x=1" }])
    expect(proxy.tunnels).toEqual([
      {
        authority: `127.0.0.1:${targetPort}`,
        authorization: `Basic ${Buffer.from("user:p@ss").toString("base64")}`,
      },
    ])
  })

  it("reports refused tunnels and failed handshakes as unsent", async () => {
    const refusing = await startProxy(407)
    await expect(
      proxyTransport(`http://127.0.0.1:${refusing.port}`)(request("https://api.folo.test/feeds")),
    ).rejects.toMatchObject({ requestSent: false })

    // A target that drops the connection during the TLS handshake.
    const dropping = createTCPServer((socket) => socket.destroy())
    const droppingPort = await listen(dropping)
    const proxy = await startProxy()
    await expect(
      proxyTransport(`http://127.0.0.1:${proxy.port}`)(
        request(`https://127.0.0.1:${droppingPort}/better-auth/get-session`),
      ),
    ).rejects.toMatchObject({ requestSent: false })
  })
})

describe.each(repositories)("official account administration (%s)", (_name, createRepository) => {
  const build = async (
    options: {
      environment?: Record<string, string>
      repository?: SupplierRepository
      transport?: OfficialTransport
    } = {},
  ) => {
    const repository = options.repository ?? createRepository()
    const server = await buildFeedSupplier({
      config: loadFeedSupplierConfig(options.environment ?? officialEnvironment),
      fetchImplementation: rssHubProbe,
      officialTransport: options.transport ?? fakeOfficialAPI().transport,
      repository,
    })
    return { repository, server }
  }

  const account = async (server: Awaited<ReturnType<typeof build>>["server"]) =>
    (
      await server.inject({ headers: admin, method: "GET", url: "/v1/admin/official/account" })
    ).json<{ account: OfficialAccountSummary | null }>().account

  const officialProvider = async (server: Awaited<ReturnType<typeof build>>["server"]) =>
    (
      await server.inject({
        headers: { authorization: `Bearer ${config.internalToken}` },
        method: "GET",
        url: "/v1/providers",
      })
    )
      .json<{ providers: Array<{ id: string; officialAccountStatus?: string; status: string }> }>()
      .providers.find((provider) => provider.id === "folo_official")

  it("does not exist unless configured", async () => {
    const { server } = await build({ environment: baseEnvironment })
    const response = await server.inject({
      headers: admin,
      method: "GET",
      url: "/v1/admin/official/account",
    })
    // Unknown routes fall back to the internal token check, so the admin token gets a 401.
    expect([401, 404]).toContain(response.statusCode)
    expect(await officialProvider(server)).toBeUndefined()
    await server.close()
  })

  it("links, verifies and unlinks the account without exposing the session", async () => {
    const official = fakeOfficialAPI()
    const { server } = await build({ transport: official.transport })

    expect(await account(server)).toBeNull()
    expect(await officialProvider(server)).toMatchObject({
      officialAccountStatus: "unlinked",
      status: "unavailable",
    })

    const internal = await server.inject({
      headers: { authorization: `Bearer ${config.internalToken}` },
      method: "POST",
      payload: { token: TOKEN },
      url: "/v1/admin/official/account",
    })
    expect(internal.statusCode).toBe(401)

    const rejected = await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: OTHER_TOKEN },
      url: "/v1/admin/official/account",
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ code: "official_session_rejected" })

    const linked = await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: `  ${TOKEN}\n` },
      url: "/v1/admin/official/account",
    })
    expect(linked.statusCode).toBe(201)
    expect(linked.body).not.toContain(TOKEN)
    expect(linked.json<{ account: OfficialAccountSummary }>().account).toMatchObject({
      externalUserId: "1171163283428605952",
      role: "free",
      rssHubSubscriptionLimit: 30,
      sessionExpiresAt: "2026-11-04T06:19:29.065Z",
      status: "active",
    })
    expect(await officialProvider(server)).toMatchObject({
      officialAccountStatus: "active",
      status: "ready",
    })

    official.accepted.set(TOKEN, () => session({ role: "pro" }))
    const verified = await server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/official/account/verify",
    })
    expect(verified.json<{ account: OfficialAccountSummary }>().account.role).toBe("pro")

    const audit = await server.inject({ headers: admin, method: "GET", url: "/v1/admin/audit" })
    const events = audit.json<{ events: SourceAuditEvent[] }>().events
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["official_account.linked", "official_account.verified"]),
    )
    expect(audit.body).not.toContain(TOKEN)

    const unlinked = await server.inject({
      headers: admin,
      method: "DELETE",
      url: "/v1/admin/official/account",
    })
    expect(unlinked.statusCode).toBe(204)
    expect(await account(server)).toBeNull()
    const again = await server.inject({
      headers: admin,
      method: "DELETE",
      url: "/v1/admin/official/account",
    })
    expect(again.statusCode).toBe(404)
    await server.close()
  })

  it("marks a rejected session and recovers by linking again", async () => {
    const official = fakeOfficialAPI()
    const { server } = await build({ transport: official.transport })
    await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: TOKEN },
      url: "/v1/admin/official/account",
    })

    official.accepted.delete(TOKEN)
    const verified = await server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/official/account/verify",
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json<{ account: OfficialAccountSummary }>().account).toMatchObject({
      authInvalidAt: expect.any(String),
      status: "auth_invalid",
    })
    expect(await officialProvider(server)).toMatchObject({
      officialAccountStatus: "auth_invalid",
      status: "unavailable",
    })
    const requestsBefore = official.requests.length
    const repeated = await server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/official/account/verify",
    })
    expect(repeated.statusCode).toBe(409)
    expect(official.requests).toHaveLength(requestsBefore)

    official.accepted.set(OTHER_TOKEN, () => session())
    const relinked = await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: OTHER_TOKEN },
      url: "/v1/admin/official/account",
    })
    expect(relinked.statusCode).toBe(201)
    expect((await account(server))?.status).toBe("active")
    await server.close()
  })

  it("reports an unavailable official API without changing the account", async () => {
    let available = true
    const official = fakeOfficialAPI()
    const transport: OfficialTransport = async (request) => {
      if (!available) throw new OfficialConnectionError("refused", false)
      return official.transport(request)
    }
    const { server } = await build({ transport })
    await server.inject({
      headers: admin,
      method: "POST",
      payload: { token: TOKEN },
      url: "/v1/admin/official/account",
    })
    available = false
    const verified = await server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/official/account/verify",
    })
    expect(verified.statusCode).toBe(502)
    expect(verified.json()).toMatchObject({ code: "official_unavailable" })
    expect((await account(server))?.status).toBe("active")
    await server.close()
  }, 15_000)

  it("re-encrypts the session when the credential key is rotated", async () => {
    const official = fakeOfficialAPI()
    const repository = createRepository()
    const first = await build({ repository, transport: official.transport })
    await first.server.inject({
      headers: admin,
      method: "POST",
      payload: { token: TOKEN },
      url: "/v1/admin/official/account",
    })

    // The servers share one repository, and closing a server closes its repository, so only the
    // last one is closed.
    const rotatedEnvironment = {
      ...officialEnvironment,
      CREDENTIAL_DECRYPTION_KEYS_JSON: JSON.stringify({
        "local-primary": "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
      }),
      CREDENTIAL_ENCRYPTION_KEY: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=",
      CREDENTIAL_ENCRYPTION_KEY_ID: "rotated",
    }
    const second = await build({
      environment: rotatedEnvironment,
      repository: first.repository,
      transport: official.transport,
    })
    const rotated = await second.server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/credentials/rotate",
    })
    expect(rotated.json()).toMatchObject({ officialAccountRotatedCount: 1 })

    // Only the new key remains; the session must still decrypt.
    const third = await build({
      environment: { ...rotatedEnvironment, CREDENTIAL_DECRYPTION_KEYS_JSON: "{}" },
      repository: first.repository,
      transport: official.transport,
    })
    const verified = await third.server.inject({
      headers: admin,
      method: "POST",
      url: "/v1/admin/official/account/verify",
    })
    expect(verified.statusCode).toBe(200)
    expect(official.requests.at(-1)?.headers.cookie).toContain(TOKEN)
    await third.server.close()
  })
})
