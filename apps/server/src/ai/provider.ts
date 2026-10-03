export interface AICompletionRequest {
  system: string
  user: string
  json?: boolean
  temperature?: number
}

export interface AICompletionResult {
  content: string
  model: string
  usage: {
    inputTokens: number | null
    /** Input tokens served from the provider's prompt cache, when it reports them. */
    cachedInputTokens?: number | null
    outputTokens: number | null
  }
}

/** A provider-reported token count, or null when it is missing or not a usable count. */
export const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null

export interface AIProvider {
  complete(request: AICompletionRequest): Promise<AICompletionResult>
}

export interface OpenAICompatibleProviderOptions {
  apiKey: string
  baseUrl: string
  fetch?: typeof globalThis.fetch
  model: string
  timeoutMs?: number
}

interface OpenAICompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
  model?: string
  usage?: {
    completion_tokens?: number
    prompt_tokens?: number
    // OpenAI and most compatible providers
    prompt_tokens_details?: { cached_tokens?: number }
    // DeepSeek
    prompt_cache_hit_tokens?: number
  }
  error?: { message?: string }
}

export class OpenAICompatibleProvider implements AIProvider {
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResult> {
    const response = await this.fetcher(`${this.options.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          { content: request.system, role: "system" },
          { content: request.user, role: "user" },
        ],
        model: this.options.model,
        ...(request.json ? { response_format: { type: "json_object" } } : {}),
        temperature: request.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    const payload = (await response.json().catch(() => ({}))) as OpenAICompletionResponse
    if (!response.ok) {
      throw new Error(
        `AI provider request failed (${response.status}): ${payload.error?.message ?? response.statusText}`,
      )
    }
    const content = payload.choices?.at(0)?.message?.content
    if (!content) throw new Error("AI provider returned an empty completion")
    return {
      content,
      model: payload.model ?? this.options.model,
      usage: {
        inputTokens: tokenCount(payload.usage?.prompt_tokens),
        cachedInputTokens:
          tokenCount(payload.usage?.prompt_tokens_details?.cached_tokens) ??
          tokenCount(payload.usage?.prompt_cache_hit_tokens),
        outputTokens: tokenCount(payload.usage?.completion_tokens),
      },
    }
  }
}
