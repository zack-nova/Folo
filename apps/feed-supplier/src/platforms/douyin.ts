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
import {
  beijingTime,
  cookieHeader,
  count,
  httpsURL,
  isoFromSeconds,
  PacedRequests,
  readUntimedList,
  text,
  titleWithin,
} from "./shared"

const PAGE_SIZE = 20
// Douyin watches automated access to logged-in accounts closely; three seconds between pages
// reads the owner's ~2000 follows within a few checks.
const MINIMUM_REQUEST_DELAY_MS = 3_000
// Image posts (图文) live under /note/; everything else is a video.
const NOTE_TYPE = 68

export interface DouyinAdapterOptions {
  /** Origin of the douyin-reader sidecar, such as http://douyin-reader:3011 */
  readerURL: string
  readerToken: string
  requestDelayMs: number
  timeoutMs: number
  fetchImplementation?: typeof fetch
  wait?: (milliseconds: number) => Promise<unknown>
}

interface ReaderPage<T> {
  items: T[]
  hasMore: boolean
  cursor: string | null
}
interface ReaderFollow {
  secUid: string
  nickname: string
  signature: string
  avatar: string
  uniqueId: string
  followerCount: number
  awemeCount: number
  verification: string
}
interface ReaderFavorite {
  awemeId: string
  awemeType: number
  description: string
  createTime: number
  authorName: string
  authorSecUid: string
  cover: string
  durationMs: number
  likes: number
  comments: number
  collects: number
  shares: number
}

const userURL = (secUid: string) => `https://www.douyin.com/user/${secUid}`

/** Reader failures as owner-facing errors; the reader never repeats Douyin's response body. */
export const douyinFailure = (status: number, code: string): PlatformBehaviorError => {
  if (status === 401)
    return new PlatformBehaviorError(
      "behavior_auth_invalid",
      "Douyin login is missing or expired; update the bound credential",
      503,
    )
  if (code === "douyin_account_mismatch")
    return new PlatformBehaviorError(
      "behavior_account_mismatch",
      "The bound Douyin login belongs to a different account than the source",
      503,
    )
  if (status === 403)
    return new PlatformBehaviorError(
      "behavior_access_denied",
      "Douyin privacy settings do not allow reading this list",
      503,
    )
  if (status === 429)
    return new PlatformBehaviorError(
      "behavior_rate_limited",
      "Douyin refused the request; it is retried later",
      429,
    )
  return new PlatformBehaviorError(
    "behavior_platform_error",
    `Douyin reader failed${code ? ` with ${code}` : ""}`,
  )
}

export class DouyinBehaviorAdapter implements PlatformBehaviorAdapter {
  readonly platform = "douyin" as const
  readonly scopes = ["favorites", "follows"] as const
  /** The sec_uid in a profile address such as douyin.com/user/MS4wLjABAAAA… */
  readonly accountIdPattern = /^[\w-]{20,128}$/
  constructor(private readonly options: DouyinAdapterOptions) {}

  async read(request: BehaviorReadRequest): Promise<BehaviorReadResult> {
    if (!request.credential)
      throw new PlatformBehaviorError(
        "behavior_auth_invalid",
        "Douyin sources need a bound login cookie",
        400,
      )
    // The reader needs the whole browser cookie (sessionid, ttwid, UIFID and others); a bare value
    // is still taken to be sessionid so a mistake fails as an expired login.
    const cookie = cookieHeader(request.credential, "sessionid")
    const requests = new PacedRequests(
      {
        requestDelayMs: Math.max(this.options.requestDelayMs, MINIMUM_REQUEST_DELAY_MS),
        wait: this.options.wait,
      },
      request.deadline,
    )
    const result =
      request.scope === "follows"
        ? await readUntimedList({
            label: "follows",
            platform: "Douyin",
            request,
            requests,
            fetchPage: async (cursor) => {
              const page = await this.page<ReaderFollow>(
                requests,
                "follows",
                cookie,
                request,
                cursor,
              )
              return {
                objects: page.items.map((user) => this.followObject(user)),
                nextCursor: page.hasMore ? page.cursor : null,
              }
            },
          })
        : await readUntimedList({
            label: "favorites",
            platform: "Douyin",
            request,
            requests,
            fetchPage: async (cursor) => {
              const page = await this.page<ReaderFavorite>(
                requests,
                "favorites",
                cookie,
                request,
                cursor,
              )
              return {
                objects: page.items.map((video) => this.favoriteObject(video)),
                nextCursor: page.hasMore ? page.cursor : null,
              }
            },
          })
    return { ...result, requestCount: requests.requestCount }
  }

  private async page<T>(
    requests: PacedRequests,
    scope: "favorites" | "follows",
    cookie: string,
    request: BehaviorReadRequest,
    cursor: string | null,
  ): Promise<ReaderPage<T>> {
    const fetchImplementation = this.options.fetchImplementation ?? globalThis.fetch
    let response: Response
    try {
      response = await requests.run(() =>
        fetchImplementation(new URL(`/v1/${scope}`, this.options.readerURL), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.readerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ cookie, accountId: request.accountId, cursor, count: PAGE_SIZE }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        }),
      )
    } catch {
      throw new PlatformBehaviorError(
        "behavior_request_failed",
        "The Douyin reader is unavailable",
        503,
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new PlatformBehaviorError(
        "behavior_response_invalid",
        "The Douyin reader returned invalid JSON",
      )
    }
    if (!response.ok)
      throw douyinFailure(response.status, text((body as { code?: unknown } | null)?.code))
    const page = body as Partial<ReaderPage<T>> | null
    if (!page || !Array.isArray(page.items))
      throw new PlatformBehaviorError(
        "behavior_response_invalid",
        "The Douyin reader returned no items",
      )
    return {
      items: page.items,
      hasMore: Boolean(page.hasMore),
      cursor: typeof page.cursor === "string" ? page.cursor : null,
    }
  }

  private followObject(user: ReaderFollow): BehaviorObject {
    return {
      key: user.secUid,
      // Douyin gives no follow time; the service publishes these at their discovery time.
      occurredAt: null,
      title: text(user.nickname) || text(user.uniqueId) || user.secUid,
      url: userURL(user.secUid),
      snapshot: {
        secUid: user.secUid,
        name: text(user.nickname),
        uniqueId: text(user.uniqueId),
        signature: text(user.signature).slice(0, 500),
        avatar: httpsURL(user.avatar),
        verification: text(user.verification),
        followers: count(user.followerCount),
        works: count(user.awemeCount),
      },
    }
  }

  private favoriteObject(video: ReaderFavorite): BehaviorObject {
    const description = text(video.description).trim()
    const path = video.awemeType === NOTE_TYPE ? "note" : "video"
    return {
      key: video.awemeId,
      // The favorites tab gives no favorite time either.
      occurredAt: null,
      title: titleWithin(description.split("\n")[0] || `抖音作品 ${video.awemeId}`, 100),
      url: `https://www.douyin.com/${path}/${video.awemeId}`,
      snapshot: {
        awemeId: video.awemeId,
        kind: path === "note" ? "图文" : "视频",
        description: description.slice(0, 1000),
        authorName: text(video.authorName),
        authorSecUid: text(video.authorSecUid),
        cover: httpsURL(video.cover),
        durationSeconds: Math.round(count(video.durationMs) / 1000),
        publishedAt: isoFromSeconds(video.createTime),
        likes: count(video.likes),
        comments: count(video.comments),
        collects: count(video.collects),
        shares: count(video.shares),
      },
    }
  }

  render(source: PlatformBehaviorSource, objects: BehaviorObject[]): RenderedBehaviorEntry[] {
    if (!objects.length) return []
    return source.scope === "follows"
      ? [this.renderFollows(objects)]
      : objects.map((object) => this.renderFavorite(object))
  }

  /** All follows found in one check become one entry that lists every account. */
  private renderFollows(objects: BehaviorObject[]): RenderedBehaviorEntry {
    const names = objects.map((object) => object.title)
    const only = objects.length === 1 ? objects[0]! : null
    const items = objects
      .map(({ snapshot, title, url }) => {
        const avatar = text(snapshot.avatar)
        const verification = text(snapshot.verification)
        const signature = text(snapshot.signature)
        return [
          "<li>",
          avatar ? `<img src="${escapeXML(avatar)}" alt="" width="48" height="48"> ` : "",
          `<a href="${escapeXML(url)}">${escapeXML(title)}</a>`,
          verification ? `（${escapeXML(verification)}）` : "",
          signature ? `<br>${escapeXML(signature).replaceAll("\n", "<br>")}` : "",
          `<br><small>${count(snapshot.followers)} 粉丝 · ${count(snapshot.works)} 作品</small>`,
          "</li>",
        ].join("")
      })
      .join("")
    return {
      objectKeys: objects.map((object) => object.key),
      title: titleWithin(
        only
          ? `新关注抖音用户：${only.title}`
          : `新关注 ${names.length} 位抖音用户：${names.join("、")}`,
      ),
      url: only ? only.url : "https://www.douyin.com/user/self",
      summary: `新关注：${names.join("、")}`,
      content: `<p><small>抖音不提供关注时间，这里的时间是发现时间。</small></p><ul>${items}</ul>`,
      imageURL: only ? text(only.snapshot.avatar) || null : null,
      occurredAt: null,
    }
  }

  private renderFavorite(object: BehaviorObject): RenderedBehaviorEntry {
    const { snapshot } = object
    const cover = text(snapshot.cover)
    const authorName = text(snapshot.authorName)
    const authorSecUid = text(snapshot.authorSecUid)
    const description = text(snapshot.description)
    const seconds = count(snapshot.durationSeconds)
    const facts = [
      authorName
        ? `作者：${authorSecUid ? `<a href="${escapeXML(userURL(authorSecUid))}">${escapeXML(authorName)}</a>` : escapeXML(authorName)}`
        : null,
      `类型：${text(snapshot.kind)}`,
      snapshot.publishedAt ? `发布时间：${beijingTime(text(snapshot.publishedAt))}` : null,
      seconds ? `时长：${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : null,
      `点赞 ${count(snapshot.likes)} · 评论 ${count(snapshot.comments)} · 收藏 ${count(snapshot.collects)} · 分享 ${count(snapshot.shares)}`,
    ].filter((fact): fact is string => fact !== null)
    return {
      objectKeys: [object.key],
      title: object.title,
      url: object.url,
      summary: [authorName && `作者：${authorName}`, description].filter(Boolean).join("｜"),
      content: [
        cover ? `<p><img src="${escapeXML(cover)}" alt=""></p>` : "",
        `<ul>${facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>`,
        description ? `<p>${escapeXML(description).replaceAll("\n", "<br>")}</p>` : "",
        "<p><small>抖音不提供收藏时间，这里的时间是发现时间。</small></p>",
      ].join(""),
      imageURL: cover || null,
      occurredAt: null,
    }
  }

  profileURL(source: PlatformBehaviorSource): string {
    return source.scope === "follows"
      ? "https://www.douyin.com/user/self?showTab=following"
      : "https://www.douyin.com/user/self?showTab=favorite_collection"
  }
}
