/** Minimal client for the supplier admin API, shared by the preset import and export tools. */
export class SupplierAdminClient {
  private readonly baseURL: URL
  private readonly fetchImplementation: typeof fetch

  constructor(
    baseURL: string,
    private readonly adminToken: string,
    fetchImplementation: typeof fetch = globalThis.fetch,
  ) {
    this.baseURL = new URL(`${baseURL.replace(/\/$/, "")}/`)
    this.fetchImplementation = fetchImplementation
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImplementation(new URL(path, this.baseURL), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.adminToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
      // Detail previews can take a full fetch timeout per request.
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await response.json().catch(() => null)) as
      (T & { code?: string; message?: string }) | null
    if (!response.ok) {
      throw new Error(
        payload?.message
          ? `${payload.code ?? response.status}: ${payload.message}`
          : `HTTP ${response.status}`,
      )
    }
    return payload as T
  }
}
