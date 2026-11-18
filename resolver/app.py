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

from resolver.sangmata import parse_sangmata_messages

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("bikaidchecker.resolver")

USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{4,31}$")
ID_RE = re.compile(r"^[1-9][0-9]{0,19}$")
client: TelegramClient | None = None
client_ready = False
client_lock = asyncio.Lock()


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


class SangMataHistoryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=20, pattern=r"^[1-9][0-9]{0,19}$")


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



@app.post("/v1/sangmata/history", dependencies=[Depends(require_api_key)])
async def sangmata_history(payload: SangMataHistoryRequest) -> dict[str, Any]:
    """Query SangMata from the configured user account and return its reply snapshot."""
    if not client_ready or client is None:
        raise HTTPException(status_code=503, detail="Resolver is not configured or Telegram session is unavailable.")

    try:
        async with client_lock:
            async with client.conversation(
                "SangMata_BOT",
                timeout=25,
                exclusive=True,
            ) as conversation:
                # SangMata's private-chat command supports global history lookup by ID.
                await conversation.send_message(f"allhistory {payload.user_id}")
                first = await conversation.get_response()
                messages = [first]

                # SangMata may split a long history over multiple Telegram messages.
                # Collect the remaining parts until the conversation is quiet.
                for _ in range(7):
                    try:
                        extra = await conversation.get_response(timeout=1.5)
                    except asyncio.TimeoutError:
                        break
                    messages.append(extra)

        parsed = parse_sangmata_messages(messages)
        if not parsed["raw_text"]:
            raise HTTPException(status_code=502, detail="SangMata returned an empty response.")

        return {
            "ok": True,
            "source": "SangMata_BOT",
            "user_id": payload.user_id,
            "fetched_at": int(time.time()),
            "has_history": bool(parsed["names"] or parsed["usernames"]),
            **parsed,
        }
    except HTTPException:
        raise
    except asyncio.TimeoutError as exc:
        raise HTTPException(
            status_code=504,
            detail="SangMata did not respond in time. Confirm the account can open @SangMata_BOT and retry.",
        ) from exc
    except FloodWaitError as exc:
        raise HTTPException(
            status_code=429,
            detail="Telegram rate limit reached. Retry later.",
            headers={"Retry-After": str(max(1, int(exc.seconds)))},
        ) from exc
    except RPCError as exc:
        logger.warning("SangMata Telegram RPC failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Could not message @SangMata_BOT. Confirm the user account has started the bot and is not blocked.",
        ) from exc
    except Exception as exc:
        logger.exception("SangMata lookup failed.")
        raise HTTPException(status_code=502, detail="SangMata lookup failed temporarily.") from exc
