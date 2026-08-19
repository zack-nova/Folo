import { describe, expect, it, vi } from "vitest"

import { MemorySupplierRepository } from "../src/memory-repository"
import { PageChangeService } from "../src/page-change-service"
import { extractPageContent, PageFetcher, PageFetchError } from "../src/page-fetcher"

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }]

const createService = (fetchImplementation: typeof fetch) => {
  const repository = new MemorySupplierRepository(Buffer.alloc(32, 3))
  const fetcher = new PageFetcher({
    fetchImplementation,
    lookup: publicLookup,
    maxBytes: 1024 * 1024,
    maxContentBytes: 256 * 1024,
    timeoutMs: 5_000,
  })
  return { repository, service: new PageChangeService(repository, fetcher) }
}

describe("page content extraction", () => {
  it("uses the configured region and removes ignored dynamic content", () => {
    expect(
      extractPageContent(
        `<html><head><title>Status</title></head><body>
          <main><span class="clock">12:00</span><p>Service operational</p></main>
          <footer>noise</footer>
        </body></html>`,
        { contentSelector: "main", ignoreSelectors: [".clock"] },
        4096,
      ),
    ).toEqual({ content: "Service operational", title: "Status" })
  })

  it("rejects private targets before sending a request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const fetcher = new PageFetcher({
      fetchImplementation,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      maxBytes: 4096,
      maxContentBytes: 4096,
      timeoutMs: 5_000,
    })
    const repository = new MemorySupplierRepository(Buffer.alloc(32))
    const service = new PageChangeService(repository, fetcher)
    const source = await service.createSource(
      { name: "private", targetURL: "http://localhost/private" },
      "test",
    )

    const stored = await repository.findPageChangeSource(source.id)
    await expect(fetcher.fetch(stored!)).rejects.toBeInstanceOf(PageFetchError)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("revalidates redirects and rejects private destinations", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { headers: { location: "http://localhost/internal" }, status: 302 }),
      )
    const fetcher = new PageFetcher({
      fetchImplementation,
      lookup: publicLookup,
      maxBytes: 4096,
      maxContentBytes: 4096,
      timeoutMs: 5_000,
    })
    const repository = new MemorySupplierRepository(Buffer.alloc(32))
    const service = new PageChangeService(repository, fetcher)
    const source = await service.createSource(
      { name: "redirect", targetURL: "https://example.com/redirect" },
      "test",
    )

    const stored = await repository.findPageChangeSource(source.id)
    await expect(fetcher.fetch(stored!)).rejects.toMatchObject({ code: "page_private_address" })
    expect(fetchImplementation).toHaveBeenCalledTimes(1)
  })
})

describe("page change state machine", () => {
  it("publishes the first non-empty observation, then confirms later changes with new GUIDs", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<main>Version one</main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main>Version two</main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main>Version two</main>", { headers: { "content-type": "text/html" } }),
      )
    const { service } = createService(fetchImplementation)
    const source = await service.createSource(
      {
        confirmDelaySeconds: 300,
        contentSelector: "main",
        name: "Release notes",
        targetURL: "https://example.com/releases",
      },
      "owner",
    )

    const initial = await service.checkSource(source.id, new Date("2026-08-19T08:00:00.000Z"))
    expect(initial).toMatchObject({ status: "initial_published" })
    expect(initial?.event).toMatchObject({ beforeFingerprint: null, content: "Version one" })

    const candidate = await service.checkSource(source.id, new Date("2026-08-19T08:01:00.000Z"))
    expect(candidate).toMatchObject({ event: null, status: "candidate_pending" })
    expect(candidate?.source.pendingConfirmAfter).toBe("2026-08-19T08:06:00.000Z")

    const confirmed = await service.checkSource(source.id, new Date("2026-08-19T08:06:00.000Z"))
    expect(confirmed).toMatchObject({ status: "change_published" })
    expect(confirmed?.event).toMatchObject({ content: "Version two" })
    expect(confirmed?.event?.guid).not.toBe(initial?.event?.guid)
    expect(confirmed?.source.eventCount).toBe(2)

    const feed = await service.materializeFeed(source.feedURL)
    expect(feed.body).toContain(initial!.event!.guid)
    expect(feed.body).toContain(confirmed!.event!.guid)
    expect(feed.body).toContain("Before:")
    await expect(service.materializeFeed(source.feedURL)).resolves.toMatchObject({
      etag: feed.etag,
    })
    await service.updateSource(source.id, { name: "Renamed release notes" }, "owner")
    const renamedFeed = await service.materializeFeed(source.feedURL)
    expect(renamedFeed.etag).not.toBe(feed.etag)
    expect(renamedFeed.body).toContain("<title>Renamed release notes</title>")
  })

  it("keeps an empty baseline until the first non-empty page can produce a message", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<main> </main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main>First useful value</main>", {
          headers: { "content-type": "text/html" },
        }),
      )
    const { service } = createService(fetchImplementation)
    const source = await service.createSource(
      { contentSelector: "main", name: "First value", targetURL: "https://example.com/value" },
      "owner",
    )

    const empty = await service.checkSource(source.id, new Date("2026-08-19T09:00:00.000Z"))
    expect(empty).toMatchObject({ event: null, status: "empty" })
    expect(empty?.source.baselineFingerprint).toBeNull()

    const first = await service.checkSource(source.id, new Date("2026-08-19T10:00:00.000Z"))
    expect(first).toMatchObject({ status: "initial_published" })
    expect(first?.event?.content).toBe("First useful value")
  })

  it("uses a 304 response to confirm that a pending candidate remained stable", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<main>A</main>", {
          headers: { "content-type": "text/html", etag: '"a"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<main>B</main>", {
          headers: { "content-type": "text/html", etag: '"b"' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const { service } = createService(fetchImplementation)
    const source = await service.createSource(
      { contentSelector: "main", name: "ETag", targetURL: "https://example.com/etag" },
      "owner",
    )

    await service.checkSource(source.id, new Date("2026-08-19T11:00:00.000Z"))
    await service.checkSource(source.id, new Date("2026-08-19T11:01:00.000Z"))
    const confirmed = await service.checkSource(source.id, new Date("2026-08-19T11:06:00.000Z"))

    expect(confirmed).toMatchObject({ status: "change_published" })
    expect(confirmed?.event?.content).toBe("B")
  })

  it("drops a pending candidate when extraction becomes empty", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<main>A</main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main>B</main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main> </main>", { headers: { "content-type": "text/html" } }),
      )
      .mockResolvedValueOnce(
        new Response("<main>B</main>", { headers: { "content-type": "text/html" } }),
      )
    const { service } = createService(fetchImplementation)
    const source = await service.createSource(
      {
        confirmDelaySeconds: 300,
        contentSelector: "main",
        name: "Transient empty",
        targetURL: "https://example.com/value",
      },
      "owner",
    )

    await service.checkSource(source.id, new Date("2026-08-19T12:00:00.000Z"))
    await service.checkSource(source.id, new Date("2026-08-19T12:01:00.000Z"))
    const empty = await service.checkSource(source.id, new Date("2026-08-19T12:06:00.000Z"))
    expect(empty).toMatchObject({ status: "empty" })
    expect(empty?.source.pendingFingerprint).toBeNull()

    const candidateAgain = await service.checkSource(
      source.id,
      new Date("2026-08-19T12:07:00.000Z"),
    )
    expect(candidateAgain).toMatchObject({ event: null, status: "candidate_pending" })
    expect(candidateAgain?.source.pendingConfirmAfter).toBe("2026-08-19T12:12:00.000Z")
  })
})
