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
  requestFailure,
  text,
  titleWithin,
} from "./shared"

const API_ORIGIN = "https://api.bilibili.com"
const FOLLOW_PAGE_SIZE = 50
const FAVORITE_PAGE_SIZE = 20
/** Pages read per list when many new objects appeared since the last check. */
const MAX_PAGES = 3
const MAX_FOLDERS = 50
const INVALID_VIDEO_TITLE = "已失效视频"

interface BilibiliResponse<T> {
  code: number
  data?: T | null
}
interface BilibiliFollowing {
  face?: string
  mid: number
  mtime?: number
  official_verify?: { desc?: string; type?: number }
  sign?: string
  uname?: string
}
interface BilibiliFolder {
  id: number
  media_count?: number
  title?: string
}
interface BilibiliMedia {
  bv_id?: string
  bvid?: string
  cnt_info?: { collect?: number; danmaku?: number; play?: number }
  cover?: string
  duration?: number
  fav_time?: number
  id?: number
  intro?: string
  pubtime?: number
  title?: string
  type?: number
  upper?: { face?: string; mid?: number; name?: string }
}

const spaceURL = (mid: number | string) => `https://space.bilibili.com/${mid}`

/** Bilibili error codes as owner-facing failures; messages never repeat the response body. */
export const bilibiliFailure = (code: number): PlatformBehaviorError => {
  if (code === -101)
    return new PlatformBehaviorError(
      "behavior_auth_invalid",
      "Bilibili login is missing or expired; update the bound credential",
      503,
    )
  if ([-403, 22115, 22118, 11010].includes(code))
    return new PlatformBehaviorError(
      "behavior_access_denied",
      "Bilibili privacy settings do not allow reading this list",
      503,
    )
  if ([-352, -412, -509, -799].includes(code))
    return new PlatformBehaviorError(
      "behavior_rate_limited",
      "Bilibili rejected the request as too frequent; it is retried later",
      429,
    )
  return new PlatformBehaviorError("behavior_platform_error", `Bilibili API returned code ${code}`)
}

/** A full cookie header is used as given; a bare value is taken to be SESSDATA. */
export const bilibiliCookieHeader = (credential: string): string =>
  cookieHeader(credential, "SESSDATA")

/** Uploaders often repeat the title or write "-" as the description; neither adds anything. */
const meaningfulIntro = (intro: string, title: string): string => {
  const trimmed = intro.trim()
  return trimmed === title.trim() || /^[-—\s.。]*$/.test(trimmed) ? "" : trimmed
}
const durationText = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}
/** Bilibili web API calls of one read. */
class BilibiliSession {
  constructor(
    private readonly requests: PacedRequests,
    private readonly cookie: string | null,
  ) {}
  get requestCount(): number {
    return this.requests.requestCount
  }
  hasTime(): boolean {
    return this.requests.hasTime()
  }
  async get<T>(path: string, parameters: Record<string, number | string>, referer: string) {
    const url = new URL(path, API_ORIGIN)
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value))
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
      referer,
      "user-agent": BROWSER_USER_AGENT,
    })
    if (this.cookie) headers.set("cookie", this.cookie)
    let body: string
    try {
      body = await this.requests.getText(url, headers)
    } catch (error) {
      const status = failedStatus(error)
      if (status === 412 || status === 429) throw bilibiliFailure(-412)
      throw requestFailure(error, "Bilibili")
    }
    let parsed: BilibiliResponse<T>
    try {
      parsed = parseJSON(body) as BilibiliResponse<T>
    } catch {
      throw new PlatformBehaviorError("behavior_response_invalid", "Bilibili returned invalid JSON")
    }
    if (typeof parsed.code !== "number")
      throw new PlatformBehaviorError("behavior_response_invalid", "Bilibili returned no code")
    if (parsed.code !== 0) throw bilibiliFailure(parsed.code)
    return parsed.data ?? null
  }
}

const reachedKnown = (objects: { occurredAt: string | null }[], knownUntil: string | null) =>
  knownUntil === null ||
  objects.some((object) => object.occurredAt === null || object.occurredAt <= knownUntil)

export class BilibiliBehaviorAdapter implements PlatformBehaviorAdapter {
  readonly platform = "bilibili" as const
  readonly scopes = ["favorites", "follows"] as const
  readonly accountIdPattern = /^[1-9]\d{0,19}$/
  constructor(private readonly options: PlatformAdapterOptions) {}

  async read(request: BehaviorReadRequest): Promise<BehaviorReadResult> {
    const session = new BilibiliSession(
      new PacedRequests(this.options, request.deadline),
      request.credential ? bilibiliCookieHeader(request.credential) : null,
    )
    const notes: string[] = []
    const objects =
      request.scope === "follows"
        ? await this.readFollows(session, request, notes)
        : await this.readFavorites(session, request, notes)
    // Bilibili gives follow and favorite times, so the newest page is a complete baseline.
    return { objects, requestCount: session.requestCount, notes, nextCursor: null }
  }

  private async readFollows(
    session: BilibiliSession,
    request: BehaviorReadRequest,
    notes: string[],
  ): Promise<BehaviorObject[]> {
    const objects = new Map<string, BehaviorObject>()
    for (let page = 1; page <= MAX_PAGES; page++) {
      // Without an order type the list is sorted by follow time, newest first.
      const data = await session.get<{ list?: BilibiliFollowing[] }>(
        "/x/relation/followings",
        { vmid: request.accountId, pn: page, ps: FOLLOW_PAGE_SIZE, order: "desc" },
        `${spaceURL(request.accountId)}/relation/follow`,
      )
      const list = data?.list ?? []
      const pageObjects = list.map((item): BehaviorObject => {
        const followedAt = isoFromSeconds(item.mtime)
        return {
          key: String(item.mid),
          occurredAt: followedAt,
          title: text(item.uname) || String(item.mid),
          url: spaceURL(item.mid),
          snapshot: {
            mid: String(item.mid),
            name: text(item.uname),
            sign: text(item.sign).slice(0, 500),
            face: httpsURL(item.face),
            verify: text(item.official_verify?.desc),
            followedAt,
          },
        }
      })
      for (const object of pageObjects) objects.set(object.key, object)
      if (list.length < FOLLOW_PAGE_SIZE || reachedKnown(pageObjects, request.knownUntil)) break
      if (page === MAX_PAGES) notes.push(`Only the newest ${MAX_PAGES} follow pages were read`)
      else if (!session.hasTime()) {
        notes.push("Older follow pages were left for the next check")
        break
      }
    }
    return [...objects.values()]
  }

  private async readFavorites(
    session: BilibiliSession,
    request: BehaviorReadRequest,
    notes: string[],
  ): Promise<BehaviorObject[]> {
    const data = await session.get<{ list?: BilibiliFolder[] | null }>(
      "/x/v3/fav/folder/created/list-all",
      { up_mid: request.accountId },
      `${spaceURL(request.accountId)}/favlist`,
    )
    const folders = (data?.list ?? []).filter((folder) => folder.media_count !== 0)
    // Anonymous reads see no private folders; an empty baseline would hide them forever.
    if (!data?.list?.length && !request.credential)
      throw new PlatformBehaviorError(
        "behavior_access_denied",
        "No favorite folders are visible without a login; bind a credential",
        503,
      )
    if (folders.length > MAX_FOLDERS)
      notes.push(`Only the first ${MAX_FOLDERS} of ${folders.length} folders are read`)
    const videos = new Map<string, BehaviorObject & { folders: string[] }>()
    let unread = 0
    let skipped = 0
    for (const folder of folders.slice(0, MAX_FOLDERS)) {
      if (!session.hasTime()) {
        unread++
        continue
      }
      const folderTitle = text(folder.title) || String(folder.id)
      for (let page = 1; page <= MAX_PAGES; page++) {
        let medias: BilibiliMedia[]
        let hasMore: boolean
        try {
          const result = await session.get<{ has_more?: boolean; medias?: BilibiliMedia[] | null }>(
            "/x/v3/fav/resource/list",
            {
              media_id: folder.id,
              pn: page,
              ps: FAVORITE_PAGE_SIZE,
              keyword: "",
              order: "mtime",
              type: 0,
              tid: 0,
              platform: "web",
            },
            `${spaceURL(request.accountId)}/favlist?fid=${folder.id}`,
          )
          medias = result?.medias ?? []
          hasMore = Boolean(result?.has_more)
        } catch (error) {
          // One unreadable folder must not hide the others; other failures stop the check.
          if (error instanceof PlatformBehaviorError && error.code === "behavior_access_denied") {
            notes.push(`Folder ${folderTitle} could not be read`)
            break
          }
          throw error
        }
        const pageObjects: BehaviorObject[] = []
        for (const media of medias) {
          const object = this.favoriteObject(media, folderTitle)
          if (!object) {
            skipped++
            continue
          }
          pageObjects.push(object)
          const existing = videos.get(object.key)
          if (!existing) {
            videos.set(object.key, { ...object, folders: [folderTitle] })
            continue
          }
          // A video kept in several folders is one favorite, at its latest favorite time.
          if (!existing.folders.includes(folderTitle)) existing.folders.push(folderTitle)
          if ((object.occurredAt ?? "") > (existing.occurredAt ?? "")) {
            existing.occurredAt = object.occurredAt
            existing.snapshot.favoritedAt = object.occurredAt
          }
        }
        if (!hasMore || !medias.length || reachedKnown(pageObjects, request.knownUntil)) break
        if (page === MAX_PAGES || !session.hasTime()) {
          notes.push(`Older items of folder ${folderTitle} were not read`)
          break
        }
      }
    }
    if (unread) notes.push(`${unread} folders were left for the next check`)
    if (skipped) notes.push(`${skipped} unavailable or non-video items were skipped`)
    return [...videos.values()].map(({ folders: inFolders, ...object }) => ({
      ...object,
      snapshot: { ...object.snapshot, folders: inFolders.join("、") },
    }))
  }

  private favoriteObject(media: BilibiliMedia, folderTitle: string): BehaviorObject | null {
    const bvid = media.bvid || media.bv_id
    const title = text(media.title)
    // Type 2 is a video; audio, courses and removed videos have no stable video page.
    if (!bvid || (media.type !== undefined && media.type !== 2) || !title) return null
    if (title === INVALID_VIDEO_TITLE) return null
    const favoritedAt = isoFromSeconds(media.fav_time)
    return {
      key: bvid,
      occurredAt: favoritedAt,
      title,
      url: `https://www.bilibili.com/video/${bvid}`,
      snapshot: {
        bvid,
        title,
        intro: meaningfulIntro(text(media.intro), title).slice(0, 1000),
        upperMid: media.upper?.mid ? String(media.upper.mid) : null,
        upperName: text(media.upper?.name),
        cover: httpsURL(media.cover),
        duration: count(media.duration),
        publishedAt: isoFromSeconds(media.pubtime),
        play: count(media.cnt_info?.play),
        collect: count(media.cnt_info?.collect),
        danmaku: count(media.cnt_info?.danmaku),
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
        const face = text(snapshot.face)
        const verify = text(snapshot.verify)
        const sign = text(snapshot.sign)
        return [
          "<li>",
          face ? `<img src="${escapeXML(face)}" alt="" width="48" height="48"> ` : "",
          `<a href="${escapeXML(url)}">${escapeXML(title)}</a>`,
          verify ? `（${escapeXML(verify)}）` : "",
          sign ? `<br>${escapeXML(sign)}` : "",
          `<br><small>关注时间：${beijingTime(text(snapshot.followedAt) || null)}</small>`,
          "</li>",
        ].join("")
      })
      .join("")
    return {
      objectKeys: objects.map((object) => object.key),
      title: titleWithin(
        only
          ? `新关注 UP 主：${only.title}`
          : `新关注 ${names.length} 位 UP 主：${names.join("、")}`,
      ),
      url: only ? only.url : `${spaceURL(source.accountId)}/relation/follow`,
      summary: `新关注：${names.join("、")}`,
      content: `<ul>${items}</ul>`,
      imageURL: only ? text(only.snapshot.face) || null : null,
      occurredAt: objects[0]!.occurredAt,
    }
  }

  private renderFavorite(object: BehaviorObject): RenderedBehaviorEntry {
    const { snapshot } = object
    const cover = text(snapshot.cover)
    const upperName = text(snapshot.upperName)
    const upperMid = text(snapshot.upperMid)
    const intro = text(snapshot.intro)
    const folders = text(snapshot.folders)
    const facts = [
      upperName
        ? `UP 主：${upperMid ? `<a href="${escapeXML(spaceURL(upperMid))}">${escapeXML(upperName)}</a>` : escapeXML(upperName)}`
        : null,
      folders ? `收藏夹：${escapeXML(folders)}` : null,
      `收藏时间：${beijingTime(object.occurredAt)}`,
      snapshot.publishedAt ? `发布时间：${beijingTime(text(snapshot.publishedAt))}` : null,
      count(snapshot.duration) ? `时长：${durationText(count(snapshot.duration))}` : null,
      `播放 ${count(snapshot.play)} · 收藏 ${count(snapshot.collect)} · 弹幕 ${count(snapshot.danmaku)}`,
    ].filter((fact): fact is string => fact !== null)
    return {
      objectKeys: [object.key],
      title: titleWithin(object.title),
      url: object.url,
      summary: [upperName && `UP 主：${upperName}`, folders && `收藏夹：${folders}`, intro]
        .filter(Boolean)
        .join("｜"),
      content: [
        cover ? `<p><img src="${escapeXML(cover)}" alt=""></p>` : "",
        `<ul>${facts.map((fact) => `<li>${fact}</li>`).join("")}</ul>`,
        intro ? `<p>${escapeXML(intro).replaceAll("\n", "<br>")}</p>` : "",
      ].join(""),
      imageURL: cover || null,
      occurredAt: object.occurredAt,
    }
  }

  profileURL(source: PlatformBehaviorSource): string {
    return source.scope === "follows"
      ? `${spaceURL(source.accountId)}/relation/follow`
      : `${spaceURL(source.accountId)}/favlist`
  }
}
