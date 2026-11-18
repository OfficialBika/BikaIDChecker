from __future__ import annotations

import asyncio
import hmac
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from telethon import TelegramClient
from telethon.errors import FloodWaitError, RPCError
from telethon.sessions import SQLiteSession, StringSession
from telethon.tl.types import Channel, Chat, User

from resolver.darkcams import parse_darkcams_names

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("bikaidchecker.resolver")

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{4,31}$")
ID_RE = re.compile(r"^[1-9][0-9]{0,19}$")
client: TelegramClient | None = None
client_ready = False
client_lock = asyncio.Lock()
darkcams_stats_cache: dict[str, tuple[int, int]] = {}


def normalize_username(value: str) -> str:
    candidate = value.strip()
    if candidate.startswith(("https://", "http://", "t.me/", "telegram.me/")):
        if not candidate.startswith(("https://", "http://")):
            candidate = "https://" + candidate
        parsed = urlparse(candidate)
        if parsed.hostname not in {"t.me", "www.t.me", "telegram.me", "www.telegram.me"}:
            raise ValueError("Only public t.me usernames are supported.")
        candidate = parsed.path.strip("/").split("/", 1)[0]
    candidate = candidate.removeprefix("@")
    if not USERNAME_RE.fullmatch(candidate):
        raise ValueError("Send a valid public Telegram username.")
    return candidate


def entity_profile(entity: Any) -> dict[str, Any]:
    if isinstance(entity, User):
        kind = "Bot" if entity.bot else "User"
        name = " ".join(part for part in (entity.first_name, entity.last_name) if part).strip()
        return {
            "id": str(entity.id),
            "kind": kind,
            "name": name or None,
            "username": entity.username,
            "is_bot": bool(entity.bot),
            "is_verified": bool(entity.verified),
            "is_premium": bool(getattr(entity, "premium", False)),
            "is_scam": bool(getattr(entity, "scam", False)),
            "is_fake": bool(getattr(entity, "fake", False)),
        }
    if isinstance(entity, Channel):
        return {
            "id": str(entity.id),
            "kind": "Channel" if entity.broadcast else "Supergroup",
            "name": entity.title,
            "username": entity.username,
            "is_verified": bool(entity.verified),
            "is_scam": bool(getattr(entity, "scam", False)),
            "is_fake": bool(getattr(entity, "fake", False)),
        }
    if isinstance(entity, Chat):
        return {
            "id": str(entity.id),
            "kind": "Group",
            "name": entity.title,
            "username": None,
        }
    raise ValueError("Telegram returned an unsupported peer type.")


def _configured() -> bool:
    return bool(
        os.getenv("TELEGRAM_API_ID", "").strip()
        and os.getenv("TELEGRAM_API_HASH", "").strip()
        and os.getenv("TELEGRAM_SESSION", "").strip()
        and os.getenv("RESOLVER_API_KEY", "").strip()
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global client, client_ready
    if _configured():
        try:
            api_id = int(os.environ["TELEGRAM_API_ID"])
            api_hash = os.environ["TELEGRAM_API_HASH"].strip()
            string_session = StringSession(os.environ["TELEGRAM_SESSION"].strip())
            session_path = os.getenv("TELEGRAM_SESSION_PATH", "/tmp/bikaidchecker")
            sqlite_session = SQLiteSession(session_path)
            if sqlite_session.auth_key is None:
                sqlite_session.set_dc(
                    string_session.dc_id,
                    string_session.server_address,
                    string_session.port,
                )
                sqlite_session.auth_key = string_session.auth_key
                sqlite_session.save()
            client = TelegramClient(
                sqlite_session,
                api_id,
                api_hash,
                request_retries=2,
                connection_retries=2,
                retry_delay=1,
                auto_reconnect=True,
                flood_sleep_threshold=0,
            )
            await client.connect()
            if not await client.is_user_authorized():
                logger.error("Configured Telegram session is not authorized.")
                await client.disconnect()
                client = None
            else:
                client_ready = True
                logger.info("MTProto resolver connected.")
        except Exception:
            logger.exception("MTProto resolver startup failed.")
            if client:
                await client.disconnect()
            client = None
            client_ready = False
    else:
        logger.warning("Resolver secrets are not configured; API is disabled.")

    yield

    if client:
        await client.disconnect()
    client_ready = False


app = FastAPI(
    title="BikaIDChecker MTProto Resolver",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


class ResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str | None = Field(default=None, max_length=256)
    user_id: str | None = Field(default=None, max_length=20)


class DarkcamsNamesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str | None = Field(default=None, max_length=256)
    user_id: str | None = Field(default=None, max_length=20, pattern=r"^[1-9][0-9]{0,19}$")


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    expected = os.getenv("RESOLVER_API_KEY", "")
    if not expected or not x_api_key or not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


@app.get("/healthz")
async def health() -> dict[str, Any]:
    return {
        "service": "bikaidchecker-mtproto-resolver",
        "status": "ready" if client_ready else "unconfigured",
    }


@app.post("/v1/resolve", dependencies=[Depends(require_api_key)])
async def resolve(payload: ResolveRequest, request: Request) -> dict[str, Any]:
    del request  # Request metadata is intentionally not logged.
    if (payload.username is None) == (payload.user_id is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of username or user_id.")
    if not client_ready or client is None:
        raise HTTPException(status_code=503, detail="Resolver is not configured or Telegram session is unavailable.")

    try:
        async with client_lock:
            if payload.username is not None:
                username = normalize_username(payload.username)
                entity = await client.get_entity(username)
            else:
                raw_id = payload.user_id or ""
                if not ID_RE.fullmatch(raw_id):
                    raise HTTPException(status_code=400, detail="user_id must be a positive numeric Telegram ID.")
                # Numeric IDs require a peer/access-hash already known to this MTProto session.
                entity = await client.get_entity(int(raw_id))
            return {"ok": True, "result": entity_profile(entity)}
    except HTTPException:
        raise
    except FloodWaitError as exc:
        raise HTTPException(
            status_code=429,
            detail="Telegram rate limit reached. Retry later.",
            headers={"Retry-After": str(max(1, int(exc.seconds)))},
        ) from exc
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=404,
            detail="Peer not found. A numeric ID can only be resolved when this session already knows that peer.",
        ) from exc
    except RPCError as exc:
        logger.warning("Telegram RPC lookup failed: %s", type(exc).__name__)
        raise HTTPException(status_code=404, detail="Telegram could not resolve this peer.") from exc
    except Exception as exc:
        logger.exception("Unexpected resolver error.")
        raise HTTPException(status_code=502, detail="Telegram lookup failed temporarily.") from exc



def _names_button_position(message: Any) -> tuple[int, int] | None:
    buttons = getattr(message, "buttons", None) or []
    for row_index, row in enumerate(buttons):
        for column_index, button in enumerate(row):
            label = str(getattr(button, "text", "") or "").strip().casefold()
            if "names" in label:
                return row_index, column_index
    return None


async def _wait_for_stats_message(conversation: Any, sent_message: Any, *, log_context: str) -> Any:
    """Accept either a new Stats reply or a bot-edited loading message."""
    candidate = await conversation.get_response(message=sent_message, timeout=10)
    position = _names_button_position(candidate)
    logger.info(
        "%s received first reply message_id=%s chars=%s names_button=%s",
        log_context,
        getattr(candidate, "id", None),
        len(str(getattr(candidate, "message", "") or "")),
        bool(position),
    )
    if position is not None:
        return candidate

    # DARKC4MSHOW can send a placeholder first and edit that same message
    # into the Stats page. get_response() alone cannot observe that edit.
    try:
        edited = await conversation.get_edit(message=candidate, timeout=9)
        position = _names_button_position(edited)
        logger.info(
            "%s received edited reply message_id=%s chars=%s names_button=%s",
            log_context,
            getattr(edited, "id", None),
            len(str(getattr(edited, "message", "") or "")),
            bool(position),
        )
        if position is not None:
            return edited
        candidate = edited
    except asyncio.TimeoutError:
        logger.info("%s first reply was not edited before timeout", log_context)

    # Some bot versions send a separate Stats message after their placeholder.
    try:
        followup = await conversation.get_response(message=sent_message, timeout=5)
        position = _names_button_position(followup)
        logger.info(
            "%s received follow-up message_id=%s chars=%s names_button=%s",
            log_context,
            getattr(followup, "id", None),
            len(str(getattr(followup, "message", "") or "")),
            bool(position),
        )
        if position is not None:
            return followup
        try:
            edited_followup = await conversation.get_edit(message=followup, timeout=3)
            position = _names_button_position(edited_followup)
            logger.info("%s follow-up edit names_button=%s", log_context, bool(position))
            if position is not None:
                return edited_followup
        except asyncio.TimeoutError:
            pass
    except asyncio.TimeoutError:
        logger.warning("%s no Stats page with Names button arrived", log_context)

    raise asyncio.TimeoutError("No DARKC4MSHOW Stats page with a Names button was received.")


async def _wait_for_names_page(conversation: Any, stats_message: Any) -> list[Any]:
    """The Names button may edit the Stats message or send a separate reply."""
    messages: list[Any] = []
    try:
        edited = await conversation.get_edit(message=stats_message, timeout=10)
        messages.append(edited)
        parsed = parse_darkcams_names(messages)
        logger.info(
            "DARKC4MSHOW Names edit received message_id=%s chars=%s parsed=%s",
            getattr(edited, "id", None),
            len(str(getattr(edited, "message", "") or "")),
            parsed["has_history"],
        )
        if parsed["has_history"]:
            return messages
    except asyncio.TimeoutError:
        logger.info("DARKC4MSHOW Names click did not edit the Stats message")

    try:
        response = await conversation.get_response(timeout=10)
        messages.append(response)
        parsed = parse_darkcams_names(messages)
        logger.info(
            "DARKC4MSHOW Names response received message_id=%s chars=%s parsed=%s",
            getattr(response, "id", None),
            len(str(getattr(response, "message", "") or "")),
            parsed["has_history"],
        )
        if parsed["has_history"]:
            return messages
    except asyncio.TimeoutError:
        logger.info("DARKC4MSHOW Names click produced no separate response")

    # If the bot used a placeholder, the Names page may be a later edit.
    if messages:
        try:
            edited = await conversation.get_edit(message=messages[-1], timeout=5)
            messages.append(edited)
        except asyncio.TimeoutError:
            pass
    return messages


async def _cached_stats_message(user_id: str) -> Any | None:
    cached = darkcams_stats_cache.get(user_id)
    if not cached:
        return None
    message_id, expires_at = cached
    if expires_at <= int(time.time()):
        darkcams_stats_cache.pop(user_id, None)
        return None
    try:
        message = await client.get_messages("DARKC4MSHOW_BOT", ids=message_id)  # type: ignore[union-attr]
    except Exception:
        logger.warning("DARKC4MSHOW cached Stats message could not be loaded")
        return None
    if message is None or _names_button_position(message) is None:
        darkcams_stats_cache.pop(user_id, None)
        return None
    return message


@app.post("/v1/darkcams/stats", dependencies=[Depends(require_api_key)])
async def darkcams_stats(payload: DarkcamsNamesRequest) -> dict[str, Any]:
    """Send the target to DARKC4MSHOW and return its Stats page."""
    if (payload.username is None) == (payload.user_id is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of username or user_id.")
    if not client_ready or client is None:
        raise HTTPException(status_code=503, detail="Resolver is not configured or Telegram session is unavailable.")

    try:
        target = "@" + normalize_username(payload.username) if payload.username is not None else str(payload.user_id)
        cache_key = str(payload.user_id) if payload.user_id is not None else target.casefold()
        async with client_lock:
            logger.info("DARKC4MSHOW Stats request started (target_type=%s)", "id" if payload.user_id else "username")
            async with client.conversation("DARKC4MSHOW_BOT", timeout=35, exclusive=True) as conversation:
                sent_message = await conversation.send_message(target)
                logger.info("DARKC4MSHOW target message sent (outgoing_message_id=%s)", getattr(sent_message, "id", None))
                stats_message = await _wait_for_stats_message(
                    conversation, sent_message, log_context="DARKC4MSHOW Stats"
                )

            stats_text = str(getattr(stats_message, "message", "") or "").strip()
            if not stats_text:
                raise HTTPException(status_code=502, detail="DARKC4MSHOW Stats page was empty.")
            darkcams_stats_cache[cache_key] = (
                int(stats_message.id),
                int(time.time()) + 600,
            )
            logger.info(
                "DARKC4MSHOW Stats page captured (message_id=%s chars=%s)",
                stats_message.id,
                len(stats_text),
            )

        return {
            "ok": True,
            "source": "DARKC4MSHOW_BOT",
            "user_id": str(payload.user_id or ""),
            "stats_text": stats_text[:3500],
            "fetched_at": int(time.time()),
        }
    except HTTPException:
        raise
    except asyncio.TimeoutError as exc:
        logger.warning("DARKC4MSHOW Stats timed out while waiting for its reply or edit")
        raise HTTPException(
            status_code=504,
            detail="DARKC4MSHOW did not finish its Stats page in time. The request was sent; the bot reply/edit was not captured.",
        ) from exc
    except FloodWaitError as exc:
        raise HTTPException(status_code=429, detail="Telegram rate limit reached. Retry later.", headers={"Retry-After": str(max(1, int(exc.seconds)))}) from exc
    except RPCError as exc:
        logger.warning("DARKC4MSHOW Stats RPC failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="Could not access @DARKC4MSHOW_BOT from this Telegram session.") from exc
    except Exception as exc:
        logger.exception("DARKC4MSHOW Stats lookup failed.")
        raise HTTPException(status_code=502, detail="DARKC4MSHOW Stats lookup failed temporarily.") from exc


@app.post("/v1/darkcams/names", dependencies=[Depends(require_api_key)])
async def darkcams_names(payload: DarkcamsNamesRequest) -> dict[str, Any]:
    """Open the target's cached Stats page, click Names, and parse dated history."""
    if (payload.username is None) == (payload.user_id is None):
        raise HTTPException(status_code=400, detail="Provide exactly one of username or user_id.")
    if not client_ready or client is None:
        raise HTTPException(status_code=503, detail="Resolver is not configured or Telegram session is unavailable.")

    try:
        target = "@" + normalize_username(payload.username) if payload.username is not None else str(payload.user_id)
        cache_key = str(payload.user_id) if payload.user_id is not None else target.casefold()
        async with client_lock:
            stats_message = await _cached_stats_message(cache_key)
            if stats_message is None:
                logger.info("DARKC4MSHOW Names request has no cached Stats page; requesting a fresh one")
                async with client.conversation("DARKC4MSHOW_BOT", timeout=35, exclusive=True) as conversation:
                    sent_message = await conversation.send_message(target)
                    logger.info("DARKC4MSHOW target message sent for Names (outgoing_message_id=%s)", getattr(sent_message, "id", None))
                    stats_message = await _wait_for_stats_message(
                        conversation, sent_message, log_context="DARKC4MSHOW Names Stats"
                    )
                    darkcams_stats_cache[cache_key] = (
                        int(stats_message.id),
                        int(time.time()) + 600,
                    )
                    position = _names_button_position(stats_message)
                    if position is None:
                        raise HTTPException(status_code=502, detail="DARKC4MSHOW Stats page did not include a Names button.")
                    await stats_message.click(*position)
                    messages = await _wait_for_names_page(conversation, stats_message)
            else:
                position = _names_button_position(stats_message)
                if position is None:
                    raise HTTPException(status_code=502, detail="The cached DARKC4MSHOW Stats page no longer has its Names button.")
                logger.info("DARKC4MSHOW pressing cached Names button (stats_message_id=%s)", stats_message.id)
                async with client.conversation("DARKC4MSHOW_BOT", timeout=30, exclusive=True) as conversation:
                    await stats_message.click(*position)
                    messages = await _wait_for_names_page(conversation, stats_message)

        parsed = parse_darkcams_names(messages)
        if not parsed["raw_text"]:
            raise HTTPException(status_code=502, detail="DARKC4MSHOW returned an empty Names page.")
        if not parsed["has_history"]:
            raise HTTPException(
                status_code=502,
                detail="DARKC4MSHOW Names page was received, but no dated name or username entries were found.",
            )

        logger.info(
            "DARKC4MSHOW Names history parsed (names=%s usernames=%s messages=%s)",
            len(parsed["names"]),
            len(parsed["usernames"]),
            parsed["message_count"],
        )
        return {
            "ok": True,
            "source": "DARKC4MSHOW_BOT",
            "user_id": str(payload.user_id or ""),
            "fetched_at": int(time.time()),
            **parsed,
        }
    except HTTPException:
        raise
    except asyncio.TimeoutError as exc:
        logger.warning("DARKC4MSHOW Names request timed out")
        raise HTTPException(
            status_code=504,
            detail="Timed out while waiting for @DARKC4MSHOW_BOT. The Stats reply or Names-button edit was not captured.",
        ) from exc
    except FloodWaitError as exc:
        raise HTTPException(
            status_code=429,
            detail="Telegram rate limit reached. Retry later.",
            headers={"Retry-After": str(max(1, int(exc.seconds)))},
        ) from exc
    except RPCError as exc:
        logger.warning("DARKC4MSHOW Telegram RPC failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Could not use @DARKC4MSHOW_BOT from the configured Telegram session.",
        ) from exc
    except Exception:
        logger.exception("DARKC4MSHOW Names lookup failed.")
        raise HTTPException(status_code=502, detail="DARKC4MSHOW Names lookup failed temporarily.") from None

