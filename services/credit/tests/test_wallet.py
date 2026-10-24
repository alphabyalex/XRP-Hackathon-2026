"""Connected testnet wallet: sign-in challenge, pasted address, and live factor diffs."""

from datetime import UTC, datetime

import pytest
from xrpl.constants import CryptoAlgorithm
from xrpl.core import keypairs

from credit.db import Store
from credit.errors import CreditError
from credit.link import Linker
from credit.live import changes

BORROWER = "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb"
NOW = datetime(2026, 10, 24, 17, 0, tzinfo=UTC)


def keypair(alg=CryptoAlgorithm.ED25519):
    pub, priv = keypairs.derive_keypair(keypairs.generate_seed(algorithm=alg))
    return pub, priv, keypairs.derive_classic_address(pub)


@pytest.fixture
def linker(tmp_path):
    return Linker(Store(tmp_path / "w.db"))


@pytest.mark.parametrize("alg", [CryptoAlgorithm.ED25519, CryptoAlgorithm.SECP256K1])
async def test_sign_in_without_address_connects_signing_wallet(linker, alg):
    pub, priv, addr = keypair(alg)
    ch = linker.challenge(BORROWER, "", NOW, "testnet")
    assert "testnet wallet" in ch["message"]
    out = await linker.verify(ch["challengeId"], pub, keypairs.sign(ch["messageHex"], priv), NOW, address=addr)
    assert out["address"] == addr and out["network"] == "testnet" and out["verified"] is True
    assert linker.wallet_for(BORROWER)["status"] == "verified"
    assert linker.borrowers_for_wallet("testnet", addr) == [BORROWER]


async def test_sign_in_rejects_a_signature_over_another_message(linker):
    pub, priv, addr = keypair()
    ch = linker.challenge(BORROWER, "", NOW, "testnet")
    other = "Moonshift sign-in: something else".encode().hex().upper()
    with pytest.raises(CreditError) as e:
        await linker.verify(ch["challengeId"], pub, keypairs.sign(other, priv), NOW, address=addr)
    assert e.value.code == "BAD_SIGNATURE"
    assert linker.wallet_for(BORROWER) is None


def test_pasted_address_is_not_verified_and_replaces_previous(linker):
    _, _, a1 = keypair()
    _, _, a2 = keypair()
    linker.connect_wallet(BORROWER, "testnet", a1, NOW)
    w = linker.connect_wallet(BORROWER, "testnet", a2, NOW)
    assert w["address"] == a2 and w["verified"] is False and w["status"] == "not verified"
    assert linker.disconnect_wallet(BORROWER)["address"] == a2
    assert linker.wallet_for(BORROWER) is None


def test_changes_report_value_moves_even_when_points_hold():
    def prof(cp, ratio, ratio_pts):
        return {
            "features": {
                "distinctCounterparties": {"value": cp, "points": 0},
                "largestOutflowRatio": {"value": ratio, "points": ratio_pts},
                "trustlines": {"value": 0, "points": 0},
            }
        }

    diff = changes(prof(1, 0.05, 4), prof(2, 0.6, -4))
    assert [c["feature"] for c in diff] == ["largestOutflowRatio", "distinctCounterparties"]
    assert diff[0]["delta"] == -8
    assert diff[1] == {"feature": "distinctCounterparties", "before": 1, "after": 2, "pointsBefore": 0, "pointsAfter": 0, "delta": 0}
    assert changes(None, prof(1, 0.05, 4)) == []


def test_blend_thin_wallet_nudges_and_live_changes_show():
    from credit.combine import blend

    base = {"score": 75, "confidence": "high"}

    def wallet(score, conf="low"):
        return {"score": score, "confidence": conf, "grade": "E", "features": {}, "components": [{"part": "Connected wallet"}]}

    at_connect = blend(base, wallet(28), 28)
    assert at_connect["score"] == 66 and at_connect["grade"] == "B"
    assert at_connect["components"][0]["weight"] == 0.2
    assert blend(base, wallet(32), 28)["score"] == 68  # a payment moves it up
    assert blend(base, wallet(27), 28)["score"] == 65  # an outflow moves it down (65.1)
    # A long history moves it visibly: high confidence, score 90.
    assert blend(base, wallet(90, "high"), 90)["score"] == 87
