import { describe, expect, it } from "vitest"

import { readabilityFromHTML } from "./index"

describe("readabilityFromHTML", () => {
  it("extracts the article and resolves relative media without fetching", () => {
    const result = readabilityFromHTML(
      "https://example.com/posts/phase-one",
      `<!doctype html><html><head><title>Phase one</title></head><body>
        <nav>Navigation should not be included in the article.</nav>
        <article>
          <h1>Building an independent reader</h1>
          ${Array.from(
            { length: 12 },
            (_, index) =>
              `<p>Section ${index + 1}. ${"This paragraph contains the substantial article body and implementation details. ".repeat(4)}</p>`,
          ).join("\n")}
          <p><a href="/details">Read the implementation details</a></p>
          <img src="/cover.png" alt="Cover" />
        </article>
      </body></html>`,
    )
    expect(result?.content).toContain("Building an independent reader")
    expect(result?.content).not.toContain("Navigation should not be included")
    expect(result?.content).toContain('href="https://example.com/details"')
    expect(result?.content).toContain('src="https://example.com/cover.png"')
  })
})
