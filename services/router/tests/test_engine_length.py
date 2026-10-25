"""The in-process worker follows a requested length, so a task can be real work."""

from __future__ import annotations

from router.engine import answer_for


def ask(content: str) -> list[dict[str, str]]:
    return [{"role": "user", "content": content}]


def test_about_n_words_writes_n_tokens():
    words = answer_for(ask("Write a detailed report of about 3000 words on batch item 1: GPU utilization and revenue."))
    assert len(words) == 3000
    assert "Section 1." in "".join(words)


def test_short_prompts_keep_their_short_answer():
    assert len(answer_for(ask("Explain VWAP in one line"))) < 60


def test_length_is_capped():
    assert len(answer_for(ask("about 1,000,000 words please"))) == 20_000
