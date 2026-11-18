from resolver.darkcams import parse_darkcams_names


def test_parse_darkcams_names_page_with_dates():
    sample = """
Names history ZENN (@zenn_offical11):

📌 - other account with the same username.
usernames:
1. @ZENN_OFFICAL11 [10/27/2026]
2. @ZENN_offical11 [10/7/2026]
3. @flash_offical1 [9/26/2026]
↳ 📌 same username (@max_official3)
4. @Flash_Offical1 [3/6/2025]
5. @nanapro1500 [2/24/2025]

first name / last name:
├ 2026-09-26 ➜ Example Name
├ 2026-04-30 ➜ ZENN 🥁
└ 2025-02-24 ➜ Nan
"""
    result = parse_darkcams_names([sample])
    assert result["usernames"] == [
        {"value": "@ZENN_OFFICAL11", "date": "2026-10-27"},
        {"value": "@ZENN_offical11", "date": "2026-10-07"},
        {"value": "@flash_offical1", "date": "2026-09-26"},
        {"value": "@Flash_Offical1", "date": "2025-03-06"},
        {"value": "@nanapro1500", "date": "2025-02-24"},
    ]
    assert result["names"] == [
        {"value": "Example Name", "date": "2026-09-26"},
        {"value": "ZENN 🥁", "date": "2026-04-30"},
        {"value": "Nan", "date": "2025-02-24"},
    ]
    assert result["has_history"] is True


def test_parse_darkcams_empty_names_page():
    result = parse_darkcams_names(["No history found"])
    assert result["names"] == []
    assert result["usernames"] == []
    assert result["has_history"] is False


def test_stats_waiter_polls_for_separate_stats_message(monkeypatch):
    import asyncio
    from types import SimpleNamespace

    import resolver.app as app

    sent = SimpleNamespace(id=9)
    stats = SimpleNamespace(
        id=11,
        out=False,
        message="Stats for target",
        buttons=[[SimpleNamespace(text="🔗 Names")]],
    )

    class FakeClient:
        async def get_messages(self, entity, limit):
            assert entity == "DARKC4MSHOW_BOT"
            assert limit == 15
            return [stats]

    monkeypatch.setattr(app, "client", FakeClient())
    monkeypatch.setattr(app.asyncio, "sleep", lambda _: asyncio.sleep(0))
    result = asyncio.run(app._wait_for_stats_message(
        object(), sent, log_context="test"
    ))
    assert result.id == 11
    assert result.message == "Stats for target"


def test_names_waiter_accepts_edited_stats_message():
    import asyncio
    from types import SimpleNamespace

    from resolver.app import _wait_for_names_page

    stats = SimpleNamespace(
        id=20,
        message="Stats page",
        buttons=[[SimpleNamespace(text="🔗 Names")]],
    )
    names = SimpleNamespace(
        id=20,
        message="""
usernames:
1. @example_name [10/27/2026]
first name / last name:
└ 2026-10-27 ➜ Example Name
""",
    )

    class FakeConversation:
        async def get_edit(self, message=None, timeout=None):
            assert message.id == stats.id
            return names

    result = asyncio.run(_wait_for_names_page(FakeConversation(), stats))
    parsed = parse_darkcams_names(result)
    assert parsed["has_history"] is True
    assert parsed["usernames"][0]["value"] == "@example_name"
    assert parsed["names"][0]["value"] == "Example Name"
