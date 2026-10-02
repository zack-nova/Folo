/**
 * Heuristics for Chinese official notice pages, ported from the Feeds Agent `official_policy`
 * cleaner: facts such as the document number and issuing body, page toolbars and footers that
 * must not reach the feed, and attachment links that live next to the article body.
 */

export type NoticeFact = [label: string, value: string]

export interface NoticeFacts {
  facts: NoticeFact[]
  /**
   * Raw date texts, best first: page metadata, then publication labels, then drafting labels.
   * The caller parses them in the source time zone and keeps the first valid one.
   */
  publishedCandidates: string[]
}

const text = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim()

const dateMetaNames = [
  "pubdate",
  "publishdate",
  "publishedtime",
  "article:published_time",
  "firstpublishedtime",
  "createdate",
  "date",
]
const sourceMetaNames = ["contentsource", "source"]

const metaValues = (document: Document): Map<string, string> => {
  const values = new Map<string, string>()
  for (const meta of document.querySelectorAll("meta[content]")) {
    const key = (
      meta.getAttribute("name") ??
      meta.getAttribute("property") ??
      meta.getAttribute("http-equiv") ??
      ""
    ).toLowerCase()
    const value = meta.getAttribute("content")?.trim()
    if (key && value && !values.has(key)) values.set(key, value)
  }
  return values
}

const labelledFact =
  /(发布时间|发布日期|成文日期|发文日期|信息来源|来源)\s*[:：]\s*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|[^\s:：|｜]{2,40})/g
const metadataLine =
  /^(?:发布时间|发布日期|成文日期|发文日期|信息来源|来源|浏览次数|阅读次数|点击数|访问量|作者)\s*[:：]/
// Only a number in parentheses after the title or alone on its own line is the notice's own;
// numbers inside sentences are usually citations of other documents.
const titleDocumentNumber =
  /[（(]\s*([\p{Script=Han}a-z]{2,10}[〔﹝［[]\d{4}[〕﹞］\]]\d{1,6}号)\s*[）)]/iu
const lineDocumentNumber = /^([\p{Script=Han}a-z]{2,10}[〔﹝［[]\d{4}[〕﹞］\]]\d{1,6}号)$/iu

const blockElements =
  "p, div, table, ul, ol, li, section, article, blockquote, h1, h2, h3, h4, h5, h6"

/** Short inline lines whose text starts with a metadata label, such as "发布时间：… 来源：…". */
const metadataLines = (scope: Element): Element[] =>
  [...scope.querySelectorAll("p, div, span, li, td, em")].filter((element) => {
    const value = text(element)
    return (
      value.length <= 120 &&
      metadataLine.test(value) &&
      // A wrapper that also holds article blocks is never a metadata line.
      !element.querySelector(blockElements) &&
      ![...element.children].some((child) => metadataLine.test(text(child)))
    )
  })

/** Read the publication date and issuing body before boilerplate pruning removes them. */
export const noticeFacts = (document: Document, root: Element, title: string): NoticeFacts => {
  const meta = metaValues(document)
  const metaDates = dateMetaNames.flatMap((name) => meta.get(name) ?? [])
  const publicationDates: string[] = []
  const draftingDates: string[] = []
  let source = sourceMetaNames.map((name) => meta.get(name)).find(Boolean) ?? null
  // The title block that carries these lines is usually a sibling of the body container.
  for (const element of metadataLines(root.parentElement ?? root)) {
    for (const [, label, value] of text(element).matchAll(labelledFact)) {
      if (!value) continue
      if (/来源/.test(label!)) source ??= value
      else if (label!.startsWith("发布")) publicationDates.push(value)
      else draftingDates.push(value)
    }
  }
  const number =
    title.replaceAll(/\s+/g, "").match(titleDocumentNumber)?.[1] ??
    [...root.querySelectorAll("p, div, span, td, h2, h3, h4")]
      .map((element) => text(element).replaceAll(/\s+/g, "").match(lineDocumentNumber)?.[1])
      .find(Boolean) ??
    null
  const facts: NoticeFact[] = []
  if (source) facts.push(["来源", source.slice(0, 64)])
  if (number) facts.push(["文号", number])
  return { facts, publishedCandidates: [...metaDates, ...publicationDates, ...draftingDates] }
}

const toolWords =
  /打印本页|打印|关闭窗口|关闭|分享到|分享|收藏|返回顶部|字号|字体|扫一扫|在手机打开|在手机上打开|手机扫码|当前页|公报电子书|点击阅读|文件下载|附件下载|微信|微博|QQ空间|默认|[大中小]/g
const attachmentHref = /\.(?:7z|docx?|et|pdf|pptx?|rar|wps|xlsx?|zip)(?:[?#]|$)/i
/** Links to attachment files survive pruning even when their text reads like a toolbar. */
const holdsAttachment = (element: Element): boolean =>
  [...(element.matches("a[href]") ? [element] : []), ...element.querySelectorAll("a[href]")].some(
    (anchor) => attachmentHref.test(anchor.getAttribute("href") ?? ""),
  )
const isToolbar = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 40 &&
  value.replace(toolWords, "").replace(/[\s【】[\]|｜:：、/·.()（）-]/g, "") === ""

const stopStart = /^(?:上一篇|下一篇|上一条|下一条|责任编辑|相关链接|相关文章|相关阅读)/
// Structural footer marks; a sentence such as "著作权人版权所有" alone is not one.
const strongFooter = /ICP备|网站标识码|政府网站找错|Copyright\s*©|©\s*\d{4}|版权所有\s*[:：©(（]/i
const weakFooter = /版权所有|主办单位|承办单位|联系我们|网站地图|技术支持/g
const isFooter = (value: string): boolean =>
  strongFooter.test(value) || new Set(value.match(weakFooter)).size >= 2
const isStopMarker = (value: string): boolean =>
  value.length <= 200 && (stopStart.test(value) || isFooter(value))

/** Characters of `root` text that precede `target`, used to keep footer cuts out of the body. */
const textOffset = (root: Element, target: Element): number => {
  let offset = 0
  const walk = (node: ChildNode): boolean => {
    if (node === target) return true
    if (node.nodeType === 3) {
      offset += (node.textContent ?? "").replace(/\s+/g, "").length
      return false
    }
    return [...node.childNodes].some(walk)
  }
  ;[...root.childNodes].some(walk)
  return offset
}

/** Remove everything from `element` to the end of `root`, in document order. */
const truncateFrom = (element: Element, root: Element): void => {
  let current: Element | null = element
  while (current && current !== root) {
    let sibling = current.nextSibling
    while (sibling) {
      const next = sibling.nextSibling
      sibling.remove()
      sibling = next
    }
    const parent: Element | null = current.parentElement
    if (current === element) current.remove()
    current = parent
  }
}

/** Strip toolbars, metadata lines and everything after the first footer marker. */
export const pruneNoticeBoilerplate = (root: Element): void => {
  for (const element of [...root.querySelectorAll("*")]) {
    if (!element.isConnected) continue
    const value = text(element)
    if (isToolbar(value) && !element.querySelector("img") && !holdsAttachment(element)) {
      element.remove()
    }
  }
  for (const element of metadataLines(root)) element.remove()
  const total = (root.textContent ?? "").replace(/\s+/g, "").length
  const stop = [...root.querySelectorAll("*")].find((element) => {
    const value = text(element)
    if (!isStopMarker(value) || [...element.children].some((child) => isStopMarker(text(child)))) {
      return false
    }
    // "版权所有" can appear in the body of a copyright policy; footers sit in the back half.
    return stopStart.test(value) || textOffset(root, element) >= total / 2
  })
  if (stop) truncateFrom(stop, root)
}

const attachmentPath = /\.(?:7z|docx?|et|pdf|pptx?|rar|wps|xlsx?|zip)$/i
export const isAttachmentURL = (url: string): boolean => {
  try {
    return attachmentPath.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** Attachment links placed next to (not inside) the body container, e.g. a 附件 block. */
export const nearbyAttachments = (
  root: Element,
  resolve: (href: string) => string | null,
): { title: string; url: string }[] => {
  const scope = root.parentElement
  if (!scope) return []
  const inside = new Set(
    [...root.querySelectorAll("a[href]")].map((anchor) => resolve(anchor.getAttribute("href")!)),
  )
  const seen = new Set<string>()
  const attachments: { title: string; url: string }[] = []
  for (const anchor of scope.querySelectorAll("a[href]")) {
    if (root.contains(anchor)) continue
    const url = resolve(anchor.getAttribute("href")!)
    if (!url || inside.has(url) || seen.has(url) || !isAttachmentURL(url)) continue
    seen.add(url)
    attachments.push({ title: text(anchor) || new URL(url).pathname.split("/").pop()!, url })
    if (attachments.length >= 20) break
  }
  return attachments
}
