#!/usr/bin/env node
// A stand-in for `codex exec --json`: echoes a JSON reply derived from the prompt on stdin.
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const prompt = readFileSync(0, "utf8")
const lastMessageIndex = args.indexOf("--output-last-message")
// The provider passes a minimal environment, so the test selects a mode through CODEX_HOME.
let mode = "ok"
try {
  mode = readFileSync(`${process.env.CODEX_HOME}/mode`, "utf8").trim() || "ok"
} catch {}
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

emit({ type: "thread.started", thread_id: "t1" })
emit({ type: "turn.started" })
if (mode === "error") {
  emit({ type: "item.completed", item: { id: "i0", type: "error", message: "model unavailable" } })
  process.exit(1)
}
if (mode === "hang") {
  setTimeout(() => {}, 60_000)
} else {
  const text =
    mode === "fenced"
      ? '```json\n{"echo": "fenced"}\n```'
      : JSON.stringify({
          args,
          echo: prompt.includes("<user>") ? "ok" : "no-user",
          home: process.env.CODEX_HOME,
        })
  emit({ type: "item.completed", item: { id: "i1", type: "agent_message", text } })
  if (lastMessageIndex !== -1) writeFileSync(args[lastMessageIndex + 1], text)
  emit({
    type: "turn.completed",
    usage: { input_tokens: 21073, cached_input_tokens: 13184, output_tokens: 12 },
  })
}
