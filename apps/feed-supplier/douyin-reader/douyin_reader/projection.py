"""Turns Douyin web API responses into the few fields feed-supplier needs.

Kept free of F2 and network access so it can be tested on its own.
"""

from __future__ import annotations

from typing import Any


class ReaderError(Exception):
    """A failure the reader reports to feed-supplier with an HTTP status and a stable code."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _first_url(value: Any) -> str:
    if isinstance(value, dict):
        urls = value.get("url_list")
        if isinstance(urls, list) and urls and isinstance(urls[0], str):
            return urls[0]
    return ""


def check_status(payload: Any, scope: str) -> dict[str, Any]:
    """Returns the payload when Douyin accepted the request, or raises a ReaderError."""
    if not isinstance(payload, dict) or not payload:
        # F2 returns an empty body when Douyin rejects the signature or throttles the account.
        raise ReaderError(429, "douyin_rejected", "Douyin returned no data for the request")
    status = payload.get("status_code")
    if status == 0:
        return payload
    if status == 8:
        raise ReaderError(401, "douyin_auth_invalid", "Douyin login is missing or expired")
    if status == 2096:
        raise ReaderError(
            403, "douyin_access_denied", f"Douyin privacy settings do not allow reading {scope}"
        )
    raise ReaderError(502, "douyin_platform_error", f"Douyin returned status {status}")


def self_identity(payload: Any) -> tuple[str, str]:
    """The (uid, sec_uid) of the logged-in account from the self profile response."""
    user = payload.get("user") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or payload.get("status_code") != 0 or not isinstance(user, dict):
        raise ReaderError(401, "douyin_auth_invalid", "Douyin login is missing or expired")
    uid, sec_uid = str(user.get("uid") or ""), _text(user.get("sec_uid"))
    if not uid or not sec_uid:
        raise ReaderError(401, "douyin_auth_invalid", "Douyin login is missing or expired")
    return uid, sec_uid


def following_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    sec_uid = _text(raw.get("sec_uid"))
    if not sec_uid:
        return None
    return {
        "secUid": sec_uid,
        "uid": str(raw.get("uid") or ""),
        "nickname": _text(raw.get("nickname")),
        "signature": _text(raw.get("signature"))[:500],
        "avatar": _first_url(raw.get("avatar_larger") or raw.get("avatar_thumb")),
        "uniqueId": _text(raw.get("unique_id")) or _text(raw.get("short_id")),
        "followerCount": _number(raw.get("follower_count")),
        "awemeCount": _number(raw.get("aweme_count")),
        "verification": _text(raw.get("custom_verify")) or _text(raw.get("enterprise_verify_reason")),
    }


def following_page(payload: dict[str, Any]) -> dict[str, Any]:
    """One page of the newest-first follow list (source_type 1, paged by min_time)."""
    raw = payload.get("followings")
    items = [item for item in (following_item(user) for user in raw or [] if isinstance(user, dict)) if item]
    has_more = bool(payload.get("has_more"))
    min_time = _number(payload.get("min_time"))
    return {
        "items": items,
        "hasMore": has_more and min_time > 0,
        "cursor": str(min_time) if has_more and min_time > 0 else None,
    }


def collection_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    aweme_id = str(raw.get("aweme_id") or "")
    if not aweme_id:
        return None
    author = raw.get("author") if isinstance(raw.get("author"), dict) else {}
    video = raw.get("video") if isinstance(raw.get("video"), dict) else {}
    statistics = raw.get("statistics") if isinstance(raw.get("statistics"), dict) else {}
    return {
        "awemeId": aweme_id,
        "awemeType": _number(raw.get("aweme_type")),
        "description": _text(raw.get("desc"))[:1000],
        "createTime": _number(raw.get("create_time")),
        "authorName": _text(author.get("nickname")),
        "authorSecUid": _text(author.get("sec_uid")),
        "cover": _first_url(video.get("cover") or video.get("origin_cover")),
        "durationMs": _number(video.get("duration")),
        "likes": _number(statistics.get("digg_count")),
        "comments": _number(statistics.get("comment_count")),
        "collects": _number(statistics.get("collect_count")),
        "shares": _number(statistics.get("share_count")),
    }


def collection_page(payload: dict[str, Any]) -> dict[str, Any]:
    """One page of the favorites tab (收藏 → 作品), newest favorites first."""
    raw = payload.get("aweme_list")
    items = [item for item in (collection_item(aweme) for aweme in raw or [] if isinstance(aweme, dict)) if item]
    has_more = bool(payload.get("has_more"))
    cursor = _number(payload.get("cursor"))
    return {
        "items": items,
        "hasMore": has_more and cursor > 0,
        "cursor": str(cursor) if has_more and cursor > 0 else None,
    }
