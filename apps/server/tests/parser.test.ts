import { describe, expect, it } from "vitest"

import { parseFeed } from "../src/feeds/parser"

const atom = (entries: string) => `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example</title>
  <link href="https://example.com/"/>
  ${entries}
</feed>`

describe("Atom content types", () => {
  it("keeps the markup of xhtml content and summaries without the wrapping div", () => {
    const { entries } = parseFeed(
      atom(`
        <entry>
          <id>https://example.com/a</id>
          <title>First</title>
          <content type="xhtml">
            <div xmlns="http://www.w3.org/1999/xhtml">
              <p>Hello <a href="https://example.com/x?a=1&amp;b=2">world</a></p>
              <div class="note">Nested <i>div</i></div>
            </div>
          </content>
        </entry>
        <entry>
          <id>https://example.com/b</id>
          <title>Second</title>
          <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Summary only</p></div></summary>
        </entry>`),
      "https://example.com/feed",
    )

    expect(entries[0]!.content).toContain(
      '<p>Hello <a href="https://example.com/x?a=1&amp;b=2">world</a></p>',
    )
    expect(entries[0]!.content).toContain('<div class="note">Nested <i>div</i></div>')
    expect(entries[0]!.content).not.toContain("xmlns")
    expect(entries[1]!.description).toBe("<p>Summary only</p>")
    expect(entries[1]!.content).toBe("<p>Summary only</p>")
  })

  it("still decodes html and text content, also next to xhtml entries", () => {
    const { entries } = parseFeed(
      atom(`
        <entry>
          <id>https://example.com/a</id>
          <content type="html">&lt;p&gt;Escaped &amp;amp; decoded&lt;/p&gt;</content>
        </entry>
        <entry>
          <id>https://example.com/b</id>
          <content type="html"><![CDATA[<p>From CDATA</p>]]></content>
        </entry>
        <entry>
          <id>https://example.com/c</id>
          <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Markup</p></div></content>
        </entry>
        <entry>
          <id>https://example.com/d</id>
          <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"/></content>
        </entry>`),
      "https://example.com/feed",
    )

    expect(entries.map((entry) => entry.content)).toEqual([
      "<p>Escaped &amp; decoded</p>",
      "<p>From CDATA</p>",
      "<p>Markup</p>",
      null,
    ])
  })
})
