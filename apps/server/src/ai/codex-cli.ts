import { spawn } from "node:child_process"
import { mkdir, readFile, rm } from "node:fs/promises"

import { join } from "pathe"

import type { AICompletionRequest, AICompletionResult, AIProvider } from "./provider"
import { tokenCount } from "./provider"

export interface CodexCliProviderOptions {
  /** Path of the Codex CLI binary */
  command: string
  /** `CODEX_HOME`: where the CLI keeps its login; must be writable */
  codexHome: string
  /** Directory the agent is pointed at; nothing in it is read by the prompts */
  workDirectory: string
  model?: string
  timeoutMs?: number
}

interface CodexEvent {
  item?: { text?: string; type?: string; message?: string }
  type?: string
  usage?: {
    cached_input_tokens?: number
    input_tokens?: number
    output_tokens?: number
  }
}

const JSON_ONLY_INSTRUCTION =
  "You are being called as a batch API, not as a coding agent. Do not run commands, read files or use any tool. Reply with the requested JSON object only, with no prose and no code fence."

/**
 * Runs the owner's Codex CLI (signed in with their ChatGPT plan) as an AI provider. Calls are
 * serialized: the CLI is a full agent run per request and the plan is rate limited, so this is
 * meant for low-volume use such as manual re-evaluations, not for every incoming entry.
 */
export class CodexCliProvider implements AIProvider {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly timeoutMs: number

  constructor(private readonly options: CodexCliProviderOptions) {
    this.timeoutMs = options.timeoutMs ?? 180_000
  }

  complete(request: AICompletionRequest): Promise<AICompletionResult> {
    const run = this.queue.then(() => this.run(request))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async run(request: AICompletionRequest): Promise<AICompletionResult> {
    await mkdir(this.options.workDirectory, { recursive: true })
    await mkdir(this.options.codexHome, { recursive: true })
    const lastMessageFile = join(
      this.options.workDirectory,
      `last-message-${process.pid}-${Date.now()}.txt`,
    )
    const prompt = [
      request.json ? JSON_ONLY_INSTRUCTION : "",
      "<system>",
      request.system,
      "</system>",
      "<user>",
      request.user,
      "</user>",
    ]
      .filter(Boolean)
      .join("\n")
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      this.options.workDirectory,
      "--output-last-message",
      lastMessageFile,
      ...(this.options.model ? ["--model", this.options.model] : []),
      "-",
    ]
    try {
      const { events, exitCode, stderr } = await this.spawn(args, prompt)
      const usage = events.find((event) => event.type === "turn.completed")?.usage
      const message = events
        .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
        .at(-1)?.item?.text
      const content =
        (message ?? (await readFile(lastMessageFile, "utf8").catch(() => ""))).trim() || null
      if (exitCode !== 0 || !content) {
        const failure = events.find(
          (event) => event.type === "item.completed" && event.item?.type === "error",
        )?.item?.message
        throw new Error(
          `Codex CLI ${exitCode === 0 ? "returned no message" : `exited with ${exitCode}`}: ${
            failure ?? stderr.trim().split("\n").at(-1) ?? ""
          }`.slice(0, 500),
        )
      }
      return {
        content: request.json ? stripCodeFence(content) : content,
        model: this.options.model ?? "codex",
        usage: {
          cachedInputTokens: tokenCount(usage?.cached_input_tokens),
          inputTokens: tokenCount(usage?.input_tokens),
          outputTokens: tokenCount(usage?.output_tokens),
        },
      }
    } finally {
      await rm(lastMessageFile, { force: true })
    }
  }

  private spawn(
    args: string[],
    prompt: string,
  ): Promise<{ events: CodexEvent[]; exitCode: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.command, args, {
        env: {
          CODEX_HOME: this.options.codexHome,
          HOME: this.options.codexHome,
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000)
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(new Error(`Codex CLI could not be started: ${error.message}`))
      })
      child.once("close", (exitCode) => {
        clearTimeout(timer)
        const events: CodexEvent[] = []
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue
          try {
            events.push(JSON.parse(line) as CodexEvent)
          } catch {
            // The CLI may print non-JSON lines around the events.
          }
        }
        resolve({ events, exitCode, stderr })
      })
      child.stdin.end(prompt)
    })
  }
}

const stripCodeFence = (content: string): string =>
  content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
