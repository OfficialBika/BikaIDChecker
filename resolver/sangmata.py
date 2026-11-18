from __future__ import annotations

import re
from typing import Any, Iterable

USERNAME_RE = re.compile(r"(?<![A-Za-z0-9_])@([A-Za-z][A-Za-z0-9_]{4,31})")
NAME_HEADING_RE = re.compile(r"^(?:📛|📝)?\\s*(?:old\\s+)?names?(?:\\s+history)?\\s*:?$", re.I)
USERNAME_HEADING_RE = re.compile(r"^(?:🔗|👤)?\\s*(?:old\\s+)?usernames?(?:\\s+history)?\\s*:?$", re.I)
DATE_SUFFIX_RE = re.compile(
    r"\\s*(?:[-–—|,()]\\s*)?(?:\\d{4}[-/.年]\\d{1,2}[-/.月]\\d{1,2}日?|"
    r"\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|"
    r"\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{4})\\)?\\s*$"
)
BULLET_RE = re.compile(r"^\\s*(?:[•●▪▫*-]|\\d+[.)])\\s*")


def _clean_entry(line: str) -> str:
    value = BULLET_RE.sub("", line.strip())
    value = re.sub(r"^\\s*(?:name|username)\\s*:\\s*", "", value, flags=re.I)
    value = DATE_SUFFIX_RE.sub("", value).strip(" \\t:;|—–-")
    return value


def _unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = value.strip()
        key = item.casefold()
        if item and key not in seen:
            seen.add(key)
            result.append(item)
    return result


def parse_sangmata_messages(messages: Iterable[Any]) -> dict[str, Any]:
    """Best-effort extraction; raw_text remains authoritative when formats change."""
    chunks = []
    for item in messages:
        value = getattr(item, "message", item)
        text = str(value or "").strip()
        if text:
            chunks.append(text)

    raw_text = "\\n\\n".join(chunks).strip()
    names: list[str] = []
    usernames: list[str] = []
    section: str | None = None

    for raw_line in raw_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if NAME_HEADING_RE.fullmatch(line):
            section = "name"
            continue
        if USERNAME_HEADING_RE.fullmatch(line):
            section = "username"
            continue

        name_match = re.match(r"^name\\s*:\\s*(.+)$", line, re.I)
        username_match = re.match(r"^username\\s*:\\s*(.+)$", line, re.I)
        if name_match:
            value = _clean_entry(name_match.group(1))
            if value:
                names.append(value)
            section = "name"
            continue
        if username_match:
            value = _clean_entry(username_match.group(1))
            handles = USERNAME_RE.findall(value if value.startswith("@") else "@" + value)
            if handles:
                usernames.extend("@" + handle for handle in handles)
            elif value:
                usernames.append(value.removeprefix("@"))
            section = "username"
            continue

        handles = USERNAME_RE.findall(line)
        if handles:
            usernames.extend("@" + handle for handle in handles)

        value = _clean_entry(line)
        if not value or value.startswith(("/", "http://", "https://")):
            continue
        if section == "name":
            names.append(value)
        elif section == "username":
            if not handles:
                usernames.append(value.removeprefix("@"))

    return {
        "raw_text": raw_text,
        "names": _unique(names),
        "usernames": _unique(usernames),
        "message_count": len(chunks),
    }
