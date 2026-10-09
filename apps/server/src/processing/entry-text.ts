// HTML 4 Latin-1 entity names, in code point order from U+00A0.
const latin1Names =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  )
const namedEntities = new Map<string, string>([
  ...latin1Names.map((name, index) => [name, String.fromCodePoint(0xa0 + index)] as const),
  ["amp", "&"],
  ["apos", "'"],
  ["bdquo", "„"],
  ["bull", "•"],
  ["darr", "↓"],
  ["emsp", " "],
  ["ensp", " "],
  ["euro", "€"],
  ["gt", ">"],
  ["hellip", "…"],
  ["larr", "←"],
  ["ldquo", "“"],
  ["lsaquo", "‹"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["prime", "′"],
  ["quot", '"'],
  ["rarr", "→"],
  ["rdquo", "”"],
  ["rsaquo", "›"],
  ["rsquo", "’"],
  ["sbquo", "‚"],
  ["thinsp", " "],
  ["trade", "™"],
  ["uarr", "↑"],
])

const decodeEntities = (value: string): string =>
  value.replaceAll(
    /&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z][a-z\d]{1,9}));/gi,
    (match, decimal, hex, name) => {
      if (name) return namedEntities.get(name) ?? namedEntities.get(name.toLowerCase()) ?? match
      const codePoint = Number.parseInt(decimal ?? hex, decimal ? 10 : 16)
      return codePoint > 0 && codePoint <= 0x10_ffff ? String.fromCodePoint(codePoint) : match
    },
  )

const blockElements = new Set(
  "address article aside blockquote br dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td tfoot th thead tr ul".split(
    " ",
  ),
)
// Elements whose text is never article content; their bodies are skipped up to the end tag.
const skippedElements = new Set(["noscript", "script", "style", "svg", "template", "textarea"])

/** Work and memory bounds: markup beyond this many input characters is never read. */
const maximumInputCharacters = (maximumOutput: number) => maximumOutput * 40 + 200_000

/**
 * Plain text for the evaluation prompt. A single forward pass with indexOf-style scans keeps it
 * linear in the input, so hostile markup cannot stall the worker; only real tags count as markup
 * and inline tags do not split words.
 */
export const entryPromptText = (content: string | null, maximum: number): string | null => {
  if (!content) return null
  const html = content.slice(0, maximumInputCharacters(maximum))
  const parts: string[] = []
  let length = 0
  // Stop collecting once the result is certainly long enough to be truncated.
  const push = (text: string) => {
    if (length > maximum * 2) return
    parts.push(text)
    length += text.length
  }
  let index = 0
  while (index < html.length && length <= maximum * 2) {
    const tagStart = html.indexOf("<", index)
    if (tagStart === -1) {
      push(decodeEntities(html.slice(index)))
      break
    }
    if (tagStart > index) push(decodeEntities(html.slice(index, tagStart)))
    const next = html[tagStart + 1] ?? ""
    if (!/[a-z/!?]/i.test(next)) {
      // A lone "<" such as "x < 3" is text.
      push("<")
      index = tagStart + 1
      continue
    }
    if (html.startsWith("<!--", tagStart)) {
      const end = html.indexOf("-->", tagStart + 4)
      index = end === -1 ? html.length : end + 3
      continue
    }
    let tagEnd = tagStart + 1
    let quote = ""
    for (; tagEnd < html.length; tagEnd += 1) {
      const character = html[tagEnd]
      if (quote) {
        if (character === quote) quote = ""
      } else if (character === '"' || character === "'") {
        quote = character
      } else if (character === ">") {
        break
      }
    }
    if (tagEnd >= html.length) break
    const tag = html.slice(tagStart + 1, tagEnd)
    const name = /^\/?\s*([a-z][\w:-]*)/i.exec(tag)?.[1]?.toLowerCase() ?? ""
    const closing = tag.startsWith("/")
    index = tagEnd + 1
    if (!closing && skippedElements.has(name) && !tag.endsWith("/")) {
      const end = new RegExp(`</${name}\\s*>`, "gi")
      end.lastIndex = index
      const match = end.exec(html)
      index = match ? match.index + match[0].length : html.length
      continue
    }
    if (blockElements.has(name)) push("\n")
  }
  const text = parts
    .join("")
    .split("\n")
    .map((line) => line.replaceAll(/[\t\n\v\f\r \xa0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
  if (!text) return null
  const characters = [...text]
  return characters.length <= maximum
    ? text
    : `${characters.slice(0, maximum).join("").trimEnd()}\n[Content truncated]`
}

/** Characters of description shown under a title in entry lists. */
export const DEFAULT_EXCERPT_CHARACTERS = 400

/**
 * Plain-text excerpt of an entry description for list views. Clients print `description` as
 * text, the way the official service stores it, so feeds whose description is HTML (X posts with
 * `<br>` and links, image markup) would otherwise show the tags. Lines collapse to one and a
 * truncated excerpt ends with an ellipsis.
 */
export const entryExcerpt = (
  description: string | null,
  maximum = DEFAULT_EXCERPT_CHARACTERS,
): string | null => {
  const text = entryPromptText(description, maximum)
  if (!text) return null
  const truncated = text.endsWith("\n[Content truncated]")
  const body = truncated ? text.slice(0, -"\n[Content truncated]".length) : text
  const line = body.replaceAll(/\s*\n\s*/g, " ").trim()
  return line ? (truncated ? `${line}…` : line) : null
}
