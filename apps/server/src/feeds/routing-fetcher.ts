import type { FeedFetcher, FetchedFeed } from "./importer"

export class RoutingFeedFetcher implements FeedFetcher {
  constructor(
    private readonly standardFetcher: FeedFetcher,
    private readonly supplierFetcher: FeedFetcher,
  ) {}

  supports(input: string): boolean {
    if (this.supplierFetcher.supports?.(input)) return true
    return this.standardFetcher.supports?.(input) ?? /^https?:\/\//.test(input)
  }

  providerFor(input: string) {
    return this.supplierFetcher.supports?.(input)
      ? (this.supplierFetcher.providerFor?.(input) ??
          this.supplierFetcher.providerId ??
          "feed_supplier")
      : (this.standardFetcher.providerFor?.(input) ??
          this.standardFetcher.providerId ??
          "standard_rss")
  }

  getProviderStatuses() {
    return this.supplierFetcher.getProviderStatuses?.() ?? Promise.resolve([])
  }

  fetch(
    input: string,
    options?: { etag?: string | null; lastModified?: string | null },
  ): Promise<FetchedFeed> {
    return this.supplierFetcher.supports?.(input)
      ? this.supplierFetcher.fetch(input, options)
      : this.standardFetcher.fetch(input, options)
  }
}
