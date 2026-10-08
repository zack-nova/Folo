import { ProcessingError } from "../processing/service"
import type { AIProvider } from "./provider"

/** Which processing jobs the Codex CLI handles. */
export type CodexScope = "all" | "manual"

export interface CodexRoutingOptions {
  dailyLimit: number
  model: string | null
  provider: AIProvider
  scope: CodexScope
}

export interface CodexRoutingStatus {
  daily_limit: number
  model: string | null
  scope: CodexScope
  used_today: number
}

/**
 * What a request tells the router. Owner-requested work is a manual re-evaluation, a summary or
 * a translation the owner asked for while reading; automatic processing of new entries is not.
 */
export interface RoutedJob {
  ownerRequested: boolean
}

/**
 * Chooses between the owner's Codex CLI and the API provider. Codex only takes the jobs its
 * scope allows and only within a daily call budget; everything else goes to the API provider.
 * The budget counts calls started per UTC day and lives in memory, so a restart resets it.
 */
export class AIProviderRouter {
  private usedToday = 0
  private usageDay = ""

  constructor(
    private readonly resolveAPIProvider: (userId: string) => Promise<AIProvider | null>,
    private readonly codex: CodexRoutingOptions | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(userId: string, job: RoutedJob): Promise<AIProvider> {
    const api = await this.resolveAPIProvider(userId)
    if (this.codex && this.codexHandles(job)) {
      if (this.consumeBudget()) return this.codex.provider
      if (api) return api
      throw new ProcessingError(
        "codex_budget_exhausted",
        `The Codex daily limit of ${this.codex.dailyLimit} calls is used up and no API provider is configured`,
      )
    }
    if (api) return api
    throw new ProcessingError(
      "ai_provider_not_configured",
      this.codex
        ? "Configure an API provider; Codex only handles owner-requested work"
        : "Configure an AI provider first",
    )
  }

  status(): CodexRoutingStatus | null {
    if (!this.codex) return null
    this.rollDay()
    return {
      daily_limit: this.codex.dailyLimit,
      model: this.codex.model,
      scope: this.codex.scope,
      used_today: this.usedToday,
    }
  }

  private codexHandles(job: RoutedJob): boolean {
    return this.codex?.scope === "all" || job.ownerRequested
  }

  private consumeBudget(): boolean {
    if (!this.codex) return false
    this.rollDay()
    if (this.usedToday >= this.codex.dailyLimit) return false
    this.usedToday += 1
    return true
  }

  private rollDay(): void {
    const day = this.now().toISOString().slice(0, 10)
    if (day !== this.usageDay) {
      this.usageDay = day
      this.usedToday = 0
    }
  }
}
