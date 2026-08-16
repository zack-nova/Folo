import { describe, expect, it } from "vitest"

import { checkCapability } from "./capabilities"

describe("self-hosted capabilities", () => {
  it("keeps capability-gated UI hidden while the manifest is loading", () => {
    expect(checkCapability(undefined, "subscriptions.core")).toBe(false)
  })

  it("preserves legacy official behavior but hides capabilities omitted by a manifest", () => {
    expect(checkCapability(null, "rsshub.hosted")).toBe(true)
    expect(checkCapability(new Set(["subscriptions.core"]), "subscriptions.core")).toBe(true)
    expect(checkCapability(new Set(["subscriptions.core"]), "subscriptions.opml")).toBe(false)
    expect(checkCapability(new Set(["subscriptions.core"]), "rsshub.hosted")).toBe(false)
  })
})
