import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { join } from "pathe"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CodexCliProvider } from "../src/ai/codex-cli"
import type { AIProvider } from "../src/ai/provider"
import { AIProviderRouter } from "../src/ai/router"

const fakeCodex = fileURLToPath(new URL("./fixtures/codex/fake-codex.mjs", import.meta.url))

describe("CodexCliProvider", () => {
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "folo-codex-"))
  })
  afterEach(async () => {
    await rm(directory, { force: true, recursive: true })
  })
  const mode = async (value: string) => {
    await mkdir(join(directory, "home"), { recursive: true })
    await writeFile(join(directory, "home", "mode"), value)
  }
  const provider = (timeoutMs = 10_000) =>
    new CodexCliProvider({
      codexHome: join(directory, "home"),
      command: fakeCodex,
      model: "gpt-5-codex",
      reasoningEffort: "low",
      timeoutMs,
      workDirectory: join(directory, "work"),
    })

  it("runs codex exec non-interactively with a JSON-only prompt and reports usage", async () => {
    const result = await provider().complete({
      json: true,
      system: "Score the entry.",
      user: '{"entry":{"title":"Hello"}}',
    })
    const reply = JSON.parse(result.content) as { args: string[]; echo: string; home: string }
    expect(reply.echo).toBe("ok")
    expect(reply.home).toBe(join(directory, "home"))
    expect(reply.args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        "gpt-5-codex",
        "--config",
        'model_reasoning_effort="low"',
        "-",
      ]),
    )
    expect(result.model).toBe("gpt-5-codex")
    expect(result.usage).toEqual({ cachedInputTokens: 13184, inputTokens: 21073, outputTokens: 12 })
    // The last-message file is removed after the run.
    expect(await readdir(join(directory, "work"))).toEqual([])
  })

  it("strips a code fence from JSON replies", async () => {
    await mode("fenced")
    const result = await provider().complete({ json: true, system: "s", user: "u" })
    expect(JSON.parse(result.content)).toEqual({ echo: "fenced" })
  })

  it("surfaces CLI errors and timeouts", async () => {
    await mode("error")
    await expect(provider().complete({ json: true, system: "s", user: "u" })).rejects.toThrow(
      /exited with 1: model unavailable/,
    )
    await mode("hang")
    await expect(provider(500).complete({ json: true, system: "s", user: "u" })).rejects.toThrow(
      /timed out after 500ms/,
    )
  })

  it("fails clearly when the command does not exist", async () => {
    const missing = new CodexCliProvider({
      codexHome: join(directory, "home"),
      command: join(directory, "no-such-codex"),
      workDirectory: join(directory, "work"),
    })
    await expect(missing.complete({ system: "s", user: "u" })).rejects.toThrow(
      /could not be started/,
    )
  })
})

describe("AIProviderRouter", () => {
  const stub = (name: string): AIProvider => ({
    complete: async () => ({
      content: name,
      model: name,
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
  })
  const codex = stub("codex")
  const api = stub("api")
  let day = "2026-10-08"
  const router = (scope: "all" | "manual", withApi = true, dailyLimit = 2) =>
    new AIProviderRouter(
      async () => (withApi ? api : null),
      { dailyLimit, model: null, provider: codex, scope },
      () => new Date(`${day}T12:00:00Z`),
    )

  it("sends only manual re-evaluations to Codex by default", async () => {
    const r = router("manual")
    expect(await r.resolve("u", { ownerRequested: false })).toBe(api)
    expect(await r.resolve("u", { ownerRequested: true })).toBe(codex)
    expect(r.status()).toEqual({ daily_limit: 2, model: null, scope: "manual", used_today: 1 })
  })

  it("falls back to the API provider once the daily budget is used, and resets next day", async () => {
    const r = router("all")
    expect(await r.resolve("u", { ownerRequested: false })).toBe(codex)
    expect(await r.resolve("u", { ownerRequested: false })).toBe(codex)
    expect(await r.resolve("u", { ownerRequested: false })).toBe(api)
    expect(r.status()?.used_today).toBe(2)
    day = "2026-10-09"
    expect(await r.resolve("u", { ownerRequested: false })).toBe(codex)
    expect(r.status()?.used_today).toBe(1)
  })

  it("reports a clear error without an API provider", async () => {
    day = "2026-10-10"
    const r = router("manual", false, 1)
    await expect(r.resolve("u", { ownerRequested: false })).rejects.toMatchObject({
      code: "ai_provider_not_configured",
    })
    expect(await r.resolve("u", { ownerRequested: true })).toBe(codex)
    await expect(r.resolve("u", { ownerRequested: true })).rejects.toMatchObject({
      code: "codex_budget_exhausted",
    })
  })

  it("has no Codex status when it is not configured", async () => {
    const r = new AIProviderRouter(async () => api, null)
    expect(r.status()).toBeNull()
    expect(await r.resolve("u", { ownerRequested: true })).toBe(api)
  })
})
