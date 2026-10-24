import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_book_stats_are_seeded_and_labeled_simulated(tmp_path) -> None:
    with TestClient(create_app(Settings(state_dir=tmp_path))) as client:
        first = client.get("/book/stats?grade=C").json()
        second = client.get("/book/stats?grade=C").json()

    assert first == second
    assert first["simulated"] is True
    assert first["grades"][0]["simulated"] is True
    assert first["borrowers"] == first["grades"][0]["loans"]


def test_book_stats_match_contract_example(tmp_path) -> None:
    contract = Path(__file__).resolve().parents[3] / "contracts" / "risk" / "book_stats.json"
    example = json.loads(contract.read_text())
    with TestClient(create_app(Settings(state_dir=tmp_path))) as client:
        response = client.get("/book/stats?grade=C")

    assert response.status_code == 200
    assert response.json() == example["response"]


def test_book_stats_support_all_grades_and_reject_bad_grade(tmp_path) -> None:
    with TestClient(create_app(Settings(state_dir=tmp_path))) as client:
        all_grades = client.get("/book/stats").json()
        bad_grade = client.get("/book/stats?grade=F")

    assert len(all_grades["grades"]) == 5
    assert all_grades["borrowers"] == 500
    assert bad_grade.status_code == 422
