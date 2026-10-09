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

describe("duplicate items", () => {
  it("keeps the first of two items with the same guid", () => {
    const { entries } = parseFeed(
      `<rss version="2.0"><channel><title>Dup</title>
        <item><guid>https://example.com/a</guid><title>First copy</title></item>
        <item><guid>https://example.com/b</guid><title>Other</title></item>
        <item><guid>https://example.com/a</guid><title>Second copy</title></item>
      </channel></rss>`,
      "https://example.com/feed",
    )
    expect(entries.map((entry) => entry.title)).toEqual(["First copy", "Other"])
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2)
  })
})

describe("character references in text", () => {
  it("decodes titles, authors and categories, also when they are escaped twice or in CDATA", () => {
    const { feed, entries } = parseFeed(
      `<rss version="2.0"><channel><title>Tom&#39;s &amp;amp; Jerry&#8217;s</title>
        <item>
          <guid>https://example.com/a</guid>
          <title>It&#39;s &#x201C;here&#x201D; &amp;#39;now&amp;#39; &amp;mdash; AT&amp;amp;T</title>
          <author>O&#39;Brien</author>
          <category>Q&amp;amp;A</category>
          <description>&lt;p&gt;Don&amp;#39;t&lt;/p&gt;</description>
        </item>
        <item>
          <guid>https://example.com/b</guid>
          <title><![CDATA[Don&#39;t stop &amp; go]]></title>
        </item>
      </channel></rss>`,
      "https://example.com/feed",
    )

    expect(feed.title).toBe("Tom's & Jerry’s")
    expect(entries.map((entry) => entry.title)).toEqual([
      "It's “here” 'now' — AT&T",
      "Don't stop & go",
    ])
    expect(entries[0]!.author).toBe("O'Brien")
    expect(entries[0]!.categories).toEqual(["Q&A"])
    // Markup fields stay HTML, decoded once by the XML parser.
    expect(entries[0]!.description).toBe("<p>Don&#39;t</p>")
  })

  it("decodes Atom titles and author names", () => {
    const { entries } = parseFeed(
      atom(`
        <entry>
          <id>https://example.com/a</id>
          <title type="html">What&amp;#39;s new &#8211; today</title>
          <author><name>Zo&#235;</name></author>
        </entry>`),
      "https://example.com/feed",
    )

    expect(entries[0]!.title).toBe("What's new – today")
    expect(entries[0]!.author).toBe("Zoë")
  })
})
