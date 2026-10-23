import type { PlatformBehaviorSource } from "@follow/feed-source-contracts"

import type {
  BehaviorObject,
  BehaviorReadRequest,
  BehaviorReadResult,
  PlatformBehaviorAdapter,
  RenderedBehaviorEntry,
} from "../platform-behavior-adapter"
import { PlatformBehaviorError } from "../platform-behavior-adapter"
import { escapeXML } from "../web-list-extraction"
import type { PlatformAdapterOptions } from "./shared"
import {
  beijingTime,
  BROWSER_USER_AGENT,
  cookieHeader,
  count,
  failedStatus,
  httpsURL,
  isoFromSeconds,
  PacedRequests,
  parseJSON,
  plainText,
  readUntimedList,
  requestFailure,
  text,
  titleWithin,
} from "./shared"

const API_ORIGIN = "https://www.zhihu.com"
const PAGE_SIZE = 20
/** Pages read per list when many new objects appeared since the last check. */
const MAX_PAGES = 3
const MAX_FOLDERS = 100
// Zhihu answers fast sequential paging with 403; the PersonalOS collector only got through it by
// retrying. Two seconds between requests keeps a full follow list read within a few checks.
const MINIMUM_REQUEST_DELAY_MS = 2_000
// Zhihu now and then refuses a single page with 403 (error 10003, asking for its client
// signature) and serves it again seconds later; a refused page is retried after these pauses.
const RETRY_PAUSES_MS = [5_000, 10_000]
// Zhihu's own web client asks for these fields; without them followees omit headline and avatar.
const FOLLOWEE_INCLUDE =
  "data[*].id,url_token,name,headline,avatar_url,answer_count,articles_count,follower_count,is_org,user_type"
const FAVLIST_INCLUDE =
  "data[*].id,title,description,answer_count,is_public,updated_time,created_time,url"

interface ZhihuPage<T> {
  data?: T[]
  paging?: { is_end?: boolean; totals?: number }
}
interface ZhihuUser {
  avatar_url?: string
  follower_count?: number
  headline?: string
  id?: string
  is_org?: boolean
  name?: string
  url_token?: string
}
interface ZhihuFolder {
  id: number | string
  title?: string
  updated_time?: number
}
interface ZhihuContent {
  author?: ZhihuUser
  collect_time?: number
  comment_count?: number
  content?: unknown
  created?: number
  created_time?: number
  excerpt?: string
  excerpt_title?: string
  id?: number | string
  image_url?: string
  is_deleted?: boolean
  question?: { id?: number | string; title?: string }
  thumbnail?: string
  title?: string
  type?: string
  url?: string
  voteup_count?: number
}

const TYPE_LABELS: Record<string, string> = {
  answer: "回答",
  article: "文章",
  pin: "想法",
  zvideo: "视频",
  question: "问题",
}
const peopleURL = (token: string) => `https://www.zhihu.com/people/${token}`

/** Zhihu HTTP failures as owner-facing errors; messages never repeat the response body. */
export const zhihuFailure = (status: number | null): PlatformBehaviorError => {
  if (status === 401)
    return new PlatformBehaviorError(
      "behavior_auth_invalid",
      "Zhihu login is missing or expired; update the bound credential",
      503,
    )
  if (status === 404)
    return new PlatformBehaviorError(
      "behavior_access_denied",
      "Zhihu does not show this list; check the account and its privacy settings",
      503,
    )
  // Zhihu answers suspicious traffic with 403 before it starts counting requests.
  if (status === 403 || status === 429)
    return new PlatformBehaviorError(
      "behavior_rate_limited",
      "Zhihu restricted the request; it is retried later",
      429,
    )
  return new PlatformBehaviorError(
    "behavior_platform_error",
    `Zhihu request failed${status ? ` with HTTP ${status}` : ""}`,
  )
}

/** A full cookie header is used as given; a bare value is taken to be z_c0. */
export const zhihuCookieHeader = (credential: string): string => cookieHeader(credential, "z_c0")

/** Zhihu API calls of one read. */
class ZhihuSession {
  constructor(
    readonly requests: PacedRequests,
    private readonly cookie: string | null,
  ) {}
  get requestCount(): number {
    return this.requests.requestCount
  }
  hasTime(): boolean {
    return this.requests.hasTime()
  }
  async page<T>(path: string, parameters: Record<string, number | string>, referer: string) {
    const url = new URL(`/api/v4${path}`, API_ORIGIN)
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      referer,
      "user-agent": BROWSER_USER_AGENT,
    })
    if (this.cookie) headers.set("cookie", this.cookie)
    let body = ""
    for (let attempt = 0; ; attempt++) {
      try {
        body = await this.requests.getText(url, headers)
        break
      } catch (error) {
        const status = failedStatus(error)
        const pause = RETRY_PAUSES_MS[attempt]
        if (status === 403 && pause !== undefined && this.requests.hasTime(pause)) {
          await this.requests.pause(pause)
          continue
        }
        throw status ? zhihuFailure(status) : requestFailure(error, "Zhihu")
      }
    }
    let parsed: ZhihuPage<T> & { error?: unknown }
    try {
      parsed = parseJSON(body) as ZhihuPage<T> & { error?: unknown }
    } catch {
      throw new PlatformBehaviorError("behavior_response_invalid", "Zhihu returned invalid JSON")
    }
    if (parsed.error || !Array.isArray(parsed.data)) throw zhihuFailure(null)
    return { items: parsed.data, isEnd: parsed.paging?.is_end !== false }
  }
}

const reachedKnown = (objects: { occurredAt: string | null }[], knownUntil: string | null) =>
  knownUntil === null ||
  objects.some((object) => object.occurredAt === null || object.occurredAt <= knownUntil)

/** Body text: an HTML string, or for posts (想法) a list of blocks with HTML text. */
const contentBody = (content: ZhihuContent): string =>
  plainText(
    Array.isArray(content.content)
      ? content.content
          .map((block) => text((block as { content?: unknown } | null)?.content))
          .join(" ")
      : text(content.content),
  )
const contentTitle = (content: ZhihuContent): string => {
  if (content.type === "answer" && content.question?.title) return content.question.title
  const title = plainText(text(content.title) || text(content.excerpt_title))
  if (title) return title
  const body = contentBody(content)
  return body ? titleWithin(body, 60) : ""
}
const contentURL = (content: ZhihuContent): string => {
  const id = content.id === undefined ? "" : String(content.id)
  if (content.type === "answer" && content.question?.id && id)
    return `https://www.zhihu.com/question/${content.question.id}/answer/${id}`
  if (content.type === "article" && id) return `https://zhuanlan.zhihu.com/p/${id}`
  if (content.type === "question" && id) return `https://www.zhihu.com/question/${id}`
  if (content.type === "zvideo" && id) return `https://www.zhihu.com/zvideo/${id}`
  if (content.type === "pin" && id) return `https://www.zhihu.com/pin/${id}`
  const url = text(content.url)
  return url.startsWith("https://") && !url.includes("/api/") ? url : ""
}

export class ZhihuBehaviorAdapter implements PlatformBehaviorAdapter {
  readonly platform = "zhihu" as const
  readonly scopes = ["favorites", "follows"] as const
  /** The `url_token` in a profile address such as zhihu.com/people/<token> */
  readonly accountIdPattern = /^[\w-]{1,64}$/
  constructor(private readonly options: PlatformAdapterOptions) {}

  async read(request: BehaviorReadRequest): Promise<BehaviorReadResult> {
    const session = new ZhihuSession(
      new PacedRequests(
        {
          ...this.options,
          requestDelayMs: Math.max(this.options.requestDelayMs, MINIMUM_REQUEST_DELAY_MS),
        },
        request.deadline,
      ),
      request.credential ? zhihuCookieHeader(request.credential) : null,
    )
    if (request.scope === "follows")
      return { ...(await this.readFollows(session, request)), requestCount: session.requestCount }
    const notes: string[] = []
    const objects = await this.readFavorites(session, request, notes)
    // Favorites carry their favorite time, so the newest pages are a complete baseline.
    return { objects, requestCount: session.requestCount, notes, nextCursor: null }
  }

  /** Zhihu does not say when an account was followed, so follows are an untimed list. */
  private async readFollows(session: ZhihuSession, request: BehaviorReadRequest) {
    return readUntimedList({
      label: "follows",
      platform: "Zhihu",
      request,
      requests: session.requests,
      fetchPage: async (cursor) => {
        const offset = Number(cursor ?? 0) || 0
        const { items, isEnd } = await session.page<ZhihuUser>(
          `/members/${request.accountId}/followees`,
          { include: FOLLOWEE_INCLUDE, offset, limit: PAGE_SIZE },
          `${peopleURL(request.accountId)}/following`,
        )
        const objects = items
          .filter((user) => user.id)
          .map((user): BehaviorObject => {
            const token = text(user.url_token)
            return {
              key: String(user.id),
              occurredAt: null,
              title: text(user.name) || token,
              url: token ? peopleURL(token) : "https://www.zhihu.com/",
              snapshot: {
                id: String(user.id),
                urlToken: token,
                name: text(user.name),
                headline: plainText(text(user.headline)).slice(0, 500),
                avatar: httpsURL(user.avatar_url),
                followers: count(user.follower_count),
                isOrg: Boolean(user.is_org),
              },
            }
          })
        return { objects, nextCursor: isEnd ? null : String(offset + items.length) }
      },
    })
  }

  private async readFavorites(
    session: ZhihuSession,
    request: BehaviorReadRequest,
    notes: string[],
  ): Promise<BehaviorObject[]> {
    const folders: ZhihuFolder[] = []
    for (let offset = 0; folders.length < MAX_FOLDERS; offset += PAGE_SIZE) {
      const { items, isEnd } = await session.page<ZhihuFolder>(
        `/members/${request.accountId}/favlists`,
        { include: FAVLIST_INCLUDE, offset, limit: PAGE_SIZE },
        `${peopleURL(request.accountId)}/collections`,
      )
      folders.push(...items)
      if (isEnd || !items.length) break
    }
    if (folders.length >= MAX_FOLDERS) notes.push(`Only the first ${MAX_FOLDERS} folders are read`)
    // A folder's update time moves when something is added, so unchanged folders are skipped.
    const changed = folders.filter((folder) => {
      const updatedAt = isoFromSeconds(folder.updated_time)
      return request.knownUntil === null || updatedAt === null || updatedAt > request.knownUntil
    })
    const items = new Map<string, BehaviorObject & { folders: string[] }>()
    let unread = 0
    for (const folder of request.preview ? changed.slice(0, 1) : changed) {
      if (!session.hasTime()) {
        unread++
        continue
      }
      const folderTitle = text(folder.title) || String(folder.id)
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { items: contents, isEnd } = await session.page<ZhihuContent>(
          `/collections/${folder.id}/contents`,
          { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE },
          `https://www.zhihu.com/collection/${folder.id}`,
        )
        const pageObjects: BehaviorObject[] = []
        for (const raw of contents) {
          const object = this.favoriteObject(raw, folderTitle)
          if (!object) continue
          pageObjects.push(object)
          const existing = items.get(object.key)
          if (!existing) {
            items.set(object.key, { ...object, folders: [folderTitle] })
            continue
          }
          // Content kept in several folders is one favorite, at its latest favorite time.
          if (!existing.folders.includes(folderTitle)) existing.folders.push(folderTitle)
          if ((object.occurredAt ?? "") > (existing.occurredAt ?? "")) {
            existing.occurredAt = object.occurredAt
            existing.snapshot.favoritedAt = object.occurredAt
          }
        }
        if (isEnd || !contents.length || reachedKnown(pageObjects, request.knownUntil)) break
        if (page === MAX_PAGES || !session.hasTime()) {
          notes.push(`Older items of folder ${folderTitle} were not read`)
          break
        }
      }
    }
    if (unread) notes.push(`${unread} folders were left for the next check`)
    return [...items.values()].map(({ folders: inFolders, ...object }) => ({
      ...object,
      snapshot: { ...object.snapshot, folders: inFolders.join("、") },
    }))
  }

  private favoriteObject(content: ZhihuContent, folderTitle: string): BehaviorObject | null {
    if (content.is_deleted || !content.type || content.id === undefined) return null
    const title = contentTitle(content)
    const url = contentURL(content)
    if (!title || !url) return null
    const favoritedAt = isoFromSeconds(content.collect_time)
    const excerpt = plainText(text(content.excerpt)) || contentBody(content)
    return {
      key: `${content.type}:${content.id}`,
      occurredAt: favoritedAt,
      title,
      url,
      snapshot: {
        type: content.type,
        id: String(content.id),
        title,
        excerpt: excerpt.slice(0, 1000),
        authorName: text(content.author?.name),
        authorToken: text(content.author?.url_token),
        authorHeadline: plainText(text(content.author?.headline)).slice(0, 300),
        thumbnail: httpsURL(content.thumbnail || content.image_url),
        voteup: count(content.voteup_count),
        comments: count(content.comment_count),
        createdAt: isoFromSeconds(content.created_time ?? content.created),
        folders: folderTitle,
        favoritedAt,
      },
    }
  }

  render(source: PlatformBehaviorSource, objects: BehaviorObject[]): RenderedBehaviorEntry[] {
    const sorted = [...objects].sort((left, right) =>
      (right.occurredAt ?? "").localeCompare(left.occurredAt ?? ""),
    )
    if (!sorted.length) return []
    return source.scope === "follows"
      ? [this.renderFollows(source, sorted)]
      : sorted.map((object) => this.renderFavorite(object))
  }

  /** All follows found in one check become one entry that lists every account. */
  private renderFollows(
    source: PlatformBehaviorSource,
    objects: BehaviorObject[],
  ): RenderedBehaviorEntry {
    const names = objects.map((object) => object.title)
    const only = objects.length === 1 ? objects[0]! : null
    const items = objects
      .map(({ snapshot, title, url }) => {
        const avatar = text(snapshot.avatar)
        const headline = text(snapshot.headline)
        return [
          "<li>",
          avatar ? `<img src="${escapeXML(avatar)}" alt="" width="48" height="48"> ` : "",
          `<a href="${escapeXML(url)}">${escapeXML(title)}</a>`,
          snapshot.isOrg ? "（机构号）" : "",
          headline ? `<br>${escapeXML(headline)}` : "",
          `<br><small>${count(snapshot.followers)} 位关注者</small>`,
          "</li>",
        ].join("")
      })
      .join("")
    return {
      objectKeys: objects.map((object) => object.key),
      title: titleWithin(
        only
          ? `新关注知乎用户：${only.title}`
          : `新关注 ${names.length} 位知乎用户：${names.join("、")}`,
      ),
      url: only ? only.url : `${peopleURL(source.accountId)}/following`,
      summary: `新关注：${names.join("、")}`,
      content: `<p><small>知乎不提供关注时间，这里的时间是发现时间。</small></p><ul>${items}</ul>`,
      imageURL: only ? text(only.snapshot.avatar) || null : null,
      // Zhihu gives no follow time; the service publishes these at their discovery time.
      occurredAt: null,
    }
  }

  private renderFavorite(object: BehaviorObject): RenderedBehaviorEntry {
    const { snapshot } = object
    const authorName = text(snapshot.authorName)
    const authorToken = text(snapshot.authorToken)
    const excerpt = text(snapshot.excerpt)
    const folders = text(snapshot.folders)
    const thumbnail = text(snapshot.thumbnail)
    const kind = TYPE_LABELS[text(snapshot.type)] ?? "内容"
    const facts = [
      authorName
        ? `作者：${authorToken ? `<a href="${escapeXML(peopleURL(authorToken))}">${escapeXML(authorName)}</a>` : escapeXML(authorName)}${snapshot.authorHeadline ? `（${escapeXML(text(snapshot.authorHeadline))}）` : ""}`
        : null,
      `类型：${kind}`,
      folders ? `收藏夹：${escapeXML(folders)}` : null,
      `收藏时间：${beijingTime(object.occurredAt)}`,
      snapshot.createdAt ? `发布时间：${beijingTime(text(snapshot.createdAt))}` : null,
      `赞同 ${count(snapshot.voteup)} · 评论 ${count(snapshot.comments)}`,
    ].filter((fact): fact is string => fact !== null)
    return {
      objectKeys: [object.key],
      title: titleWithin(object.title),
      url: object.url,
      summary: [authorName && `${kind}·${authorName}`, folders && `收藏夹：${folders}`, excerpt]
        .filter(Boolean)
        .join("｜"),
      content: [
        thumbnail ? `<p><img src="${escapeXML(thumbnail)}" alt=""></p>` : "",
        `<ul>${facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>`,
        excerpt ? `<p>${escapeXML(excerpt)}</p>` : "",
      ].join(""),
      imageURL: thumbnail || null,
      occurredAt: object.occurredAt,
    }
  }

  profileURL(source: PlatformBehaviorSource): string {
    return source.scope === "follows"
      ? `${peopleURL(source.accountId)}/following`
      : `${peopleURL(source.accountId)}/collections`
  }
}
