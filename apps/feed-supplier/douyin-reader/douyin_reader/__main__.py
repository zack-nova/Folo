"""Reads the logged-in Douyin account's follows and favorites for feed-supplier (ADR-0037).

Runs next to feed-supplier on the internal Docker network only. Each request carries the login
cookie, which is used for that request and never stored or logged; F2 signs the web API calls.
Requests are refused unless the cookie belongs to the account the source names, so the reader can
only read its owner's own lists.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import httpx
from f2.apps.bark.utils import ClientConfManager as BarkClientConfManager
from f2.apps.douyin.crawler import DouyinCrawler
from f2.apps.douyin.model import UserCollection, UserFollowing
from f2.apps.douyin.utils import TokenManager

from .projection import (
    ReaderError,
    check_status,
    collection_page,
    following_page,
    self_identity,
)

TOKEN = os.environ.get("DOUYIN_READER_TOKEN", "")
PORT = int(os.environ.get("PORT", "3011"))
TIMEOUT_SECONDS = 15
MAX_BODY_BYTES = 16 * 1024
# The agent the PersonalOS collector exported the owner's lists with in 2026-06.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/148.0.0.0 Safari/537.36"
)
MS_TOKEN_TTL_SECONDS = 30 * 60
PROFILE_TTL_SECONDS = 10 * 60

BarkClientConfManager.client_conf["enable_bark"] = False
# F2 logs signed request URLs, including at error level; the reader reports outcomes itself.
logging.getLogger("f2").setLevel(logging.CRITICAL + 1)
log = logging.getLogger("douyin-reader")

_lock = threading.Lock()
_ms_token: tuple[float, str] | None = None
# Keyed by a hash of the cookie so the cookie itself is never kept.
_profiles: dict[str, tuple[float, str, str]] = {}


def ms_token() -> str:
    """F2 fetches msToken once at import; a long-running reader refreshes it."""
    global _ms_token
    with _lock:
        if _ms_token and time.monotonic() - _ms_token[0] < MS_TOKEN_TTL_SECONDS:
            return _ms_token[1]
    try:
        token = TokenManager.gen_real_msToken()
    except Exception:  # noqa: BLE001 - Douyin accepts a well-formed placeholder as well
        token = TokenManager.gen_false_msToken()
    with _lock:
        _ms_token = (time.monotonic(), token)
    return token


def crawler_options(cookie: str) -> dict[str, Any]:
    return {
        "headers": {"User-Agent": USER_AGENT, "Referer": "https://www.douyin.com/"},
        "proxies": {"http://": None, "https://": None},
        "timeout": TIMEOUT_SECONDS,
        # feed-supplier paces and retries; F2's own retries would only add requests.
        "max_retries": 1,
        "cookie": cookie,
    }


async def identity(cookie: str) -> tuple[str, str]:
    key = hashlib.sha256(cookie.encode()).hexdigest()
    with _lock:
        cached = _profiles.get(key)
        if cached and time.monotonic() - cached[0] < PROFILE_TTL_SECONDS:
            return cached[1], cached[2]
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
        response = await client.get(
            "https://www.douyin.com/aweme/v1/web/user/profile/self/",
            params={"aid": "6383"},
            headers={"User-Agent": USER_AGENT, "Referer": "https://www.douyin.com/", "Cookie": cookie},
        )
    if response.status_code != 200:
        raise ReaderError(502, "douyin_platform_error", f"Douyin returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except ValueError:
        raise ReaderError(429, "douyin_rejected", "Douyin returned no data for the request") from None
    uid, sec_uid = self_identity(payload)
    with _lock:
        if len(_profiles) > 8:
            _profiles.clear()
        _profiles[key] = (time.monotonic(), uid, sec_uid)
    return uid, sec_uid


async def read(scope: str, cookie: str, account_id: str, cursor: str | None, count: int) -> dict[str, Any]:
    uid, sec_uid = await identity(cookie)
    if sec_uid != account_id:
        raise ReaderError(403, "douyin_account_mismatch", "The login belongs to a different account")
    async with DouyinCrawler(crawler_options(cookie)) as crawler:
        if scope == "follows":
            # source_type 1 is 最近关注: newest follows first, paged by the previous page's min_time.
            params = UserFollowing(
                user_id=uid,
                sec_user_id=sec_uid,
                max_time=int(cursor or 0),
                count=count,
                source_type=1,
                msToken=ms_token(),
            )
            return following_page(check_status(await crawler.fetch_user_following(params), "follows"))
        params = UserCollection(cursor=int(cursor or 0), count=count, msToken=ms_token())
        return collection_page(check_status(await crawler.fetch_user_collection(params), "favorites"))


class Handler(BaseHTTPRequestHandler):
    server_version = "douyin-reader"
    sys_version = ""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - BaseHTTPRequestHandler API
        # Only method, path and status; request bodies carry the login cookie.
        log.info("%s %s %s", self.command, self.path.split("?")[0], args[1] if len(args) > 1 else "")

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"code": "not_found", "message": "Not found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        scope = {"/v1/follows": "follows", "/v1/favorites": "favorites"}.get(self.path)
        if scope is None:
            self.send_json(404, {"code": "not_found", "message": "Not found"})
            return
        authorization = self.headers.get("authorization", "")
        if not TOKEN or not hmac.compare_digest(authorization.encode(), f"Bearer {TOKEN}".encode()):
            self.send_json(401, {"code": "unauthorized", "message": "Reader authentication required"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(400, {"code": "invalid_request", "message": "Request body is missing or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
            cookie, account_id = body["cookie"], body["accountId"]
            cursor, count = body.get("cursor"), int(body.get("count") or 20)
            if not isinstance(cookie, str) or not cookie or "\n" in cookie or "\r" in cookie:
                raise ValueError("cookie")
            if not isinstance(account_id, str) or not account_id:
                raise ValueError("accountId")
            if cursor is not None and not (isinstance(cursor, str) and cursor.isdigit()):
                raise ValueError("cursor")
            if not 1 <= count <= 50:
                raise ValueError("count")
        except (KeyError, TypeError, ValueError):
            self.send_json(400, {"code": "invalid_request", "message": "Request body is invalid"})
            return
        try:
            self.send_json(200, asyncio.run(read(scope, cookie, account_id, cursor, count)))
        except ReaderError as error:
            self.send_json(error.status, {"code": error.code, "message": error.message})
        except httpx.HTTPError:
            self.send_json(502, {"code": "douyin_request_failed", "message": "Douyin request failed"})
        except Exception:  # noqa: BLE001 - F2 raises its own exception types for transport failures
            log.warning("%s read failed", scope)
            self.send_json(502, {"code": "douyin_request_failed", "message": "Douyin request failed"})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    if len(TOKEN) < 32:
        raise SystemExit("DOUYIN_READER_TOKEN must hold at least 32 characters")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("listening on %s", PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
