from __future__ import annotations

import re
from datetime import datetime
from typing import Any

USERNAME_ROW_RE = re.compile(
    r"^\s*\d+[.)]\s+(@[A-Za-z0-9_]{5,32})\s+\[(\d{1,2}/\d{1,2}/\d{4})\]\s*$"
)
NAME_ROW_RE = re.compile(
    r"^\s*[├└│|\\-]*\s*(\d{4}-\d{2}-\d{2})\s*(?:➡️|➜|→)\s*(.+?)\s*$"
)
USERNAME_SECTION_RE = re.compile(r"^\s*usernames\s*:\s*$", re.I)
NAME_SECTION_RE = re.compile(r"^\s*first\s+name\s*/\s*last\s+name\s*:\s*$", re.I)


def _date_us(value: str) -> str:
    try:
        return datetime.strptime(value, "%m/%d/%Y").date().isoformat()
    except ValueError:
        return value


def parse_darkcams_names(messages: list[Any]) -> dict[str, Any]:
    chunks: list[str] = []
    for item in messages:
        value = getattr(item, "message", item)
        text = str(value or "").strip()
        if text:
            chunks.append(text)
    raw_text = "\n\n".join(chunks).strip()

    usernames: list[dict[str, str]] = []
    names: list[dict[str, str]] = []
    section: str | None = None

    for line in raw_text.splitlines():
        if USERNAME_SECTION_RE.fullmatch(line):
            section = "username"
            continue
        if NAME_SECTION_RE.fullmatch(line):
            section = "name"
            continue

        if section == "username":
            match = USERNAME_ROW_RE.fullmatch(line)
            if match:
                usernames.append({
                    "value": match.group(1),
                    "date": _date_us(match.group(2)),
                })
            continue

        if section == "name":
            match = NAME_ROW_RE.fullmatch(line)
            if match:
                value = match.group(2).strip()
                if value:
                    names.append({"value": value, "date": match.group(1)})
            continue

    def unique(items: list[dict[str, str]]) -> list[dict[str, str]]:
        seen: set[tuple[str, str]] = set()
        result: list[dict[str, str]] = []
        for item in items:
            key = (item["value"].casefold(), item["date"])
            if key not in seen:
                seen.add(key)
                result.append(item)
        return result

    usernames = unique(usernames)
    names = unique(names)
    return {
        "raw_text": raw_text,
        "names": names,
        "usernames": usernames,
        "has_history": bool(names or usernames),
        "message_count": len(chunks),
    }
