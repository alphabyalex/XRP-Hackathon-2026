from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from xrpl.constants import CryptoAlgorithm
from xrpl.core import keypairs

from credit.db import Store
from credit.errors import CreditError
from credit.link import Linker
from credit.main import app
from credit.xrpl_client import XrplClient
from tests.fakes import FakeLedger

BORROWER = "rHu4dJcC3DALsgvprvekBt9dG3poU95Rzb"
NOW = datetime(2026, 10, 24, 17, 0, tzinfo=UTC)


def keypair(alg=CryptoAlgorithm.ED25519):
    pub, priv = keypairs.derive_keypair(keypairs.generate_seed(algorithm=alg))
    return pub, priv, keypairs.derive_classic_address(pub)


@pytest.fixture
def linker(tmp_path):
    return Linker(Store(tmp_path / "l.db"))


@pytest.mark.parametrize("alg", [CryptoAlgorithm.ED25519, CryptoAlgorithm.SECP256K1])
async def test_valid_signature_links_address(linker, alg):
    pub, priv, addr = keypair(alg)
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(ch["messageHex"], priv)
    out = await linker.verify(ch["challengeId"], pub, sig, NOW)
    assert out == {
        "verified": True,
        "borrower": BORROWER,
        "mainnetAddress": addr,
        "verifiedAt": "2026-10-24T17:00:00Z",
    }
    assert linker.ownership(addr)["borrower"] == BORROWER
    assert linker.links_for(BORROWER)[0]["mainnetAddress"] == addr


async def test_signature_over_other_message_rejected(linker):
    pub, priv, addr = keypair()
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(b"something else".hex(), priv)
    with pytest.raises(CreditError) as e:
        await linker.verify(ch["challengeId"], pub, sig, NOW)
    assert e.value.code == "BAD_SIGNATURE"
    assert linker.ownership(addr) is None


async def test_expired_challenge_rejected(linker):
    pub, priv, addr = keypair()
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(ch["messageHex"], priv)
    with pytest.raises(CreditError) as e:
        await linker.verify(ch["challengeId"], pub, sig, NOW + timedelta(minutes=11))
    assert e.value.code == "CHALLENGE_NOT_FOUND"


async def test_challenge_is_single_use(linker):
    pub, priv, addr = keypair()
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(ch["messageHex"], priv)
    await linker.verify(ch["challengeId"], pub, sig, NOW)
    with pytest.raises(CreditError):
        await linker.verify(ch["challengeId"], pub, sig, NOW)


async def test_someone_elses_key_rejected(linker, tmp_path):
    _, _, addr = keypair()
    pub2, priv2, _ = keypair()
    fake = FakeLedger()
    fake.accounts[addr] = {"Account": addr, "Balance": "1"}  # no RegularKey
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(ch["messageHex"], priv2)
    client = XrplClient("mainnet", fake.transport(), Store(tmp_path / "c.db"))
    with pytest.raises(CreditError) as e:
        await linker.verify(ch["challengeId"], pub2, sig, NOW, client)
    assert e.value.code == "KEY_ADDRESS_MISMATCH"


async def test_regular_key_accepted(linker, tmp_path):
    _, _, addr = keypair()
    pub2, priv2, addr2 = keypair()
    fake = FakeLedger()
    fake.accounts[addr] = {"Account": addr, "Balance": "1", "RegularKey": addr2}
    ch = linker.challenge(BORROWER, addr, NOW)
    sig = keypairs.sign(ch["messageHex"], priv2)
    client = XrplClient("mainnet", fake.transport(), Store(tmp_path / "c.db"))
    assert (await linker.verify(ch["challengeId"], pub2, sig, NOW, client))["verified"] is True


def test_http_flow_sets_ownership_on_mainnet_profile():
    client = TestClient(app)
    pub, priv, addr = keypair()
    ch = client.post("/link/challenge", json={"borrower": BORROWER, "mainnetAddress": addr}).json()
    assert ch["message"].startswith(f"Moonshift link: borrower {BORROWER} controls {addr}.")
    sig = keypairs.sign(ch["messageHex"], priv)
    r = client.post(
        "/link/verify", json={"challengeId": ch["challengeId"], "publicKey": pub, "signature": sig}
    )
    assert r.status_code == 200
    profile = client.get(f"/profile/mainnet/{addr}").json()
    assert profile["ownership"]["borrower"] == BORROWER
    assert profile["readOnly"] is True
    assert client.get(f"/links/{BORROWER}").json()["mainnet"][0]["mainnetAddress"] == addr


def test_http_malformed_signature_is_422():
    client = TestClient(app)
    pub, _, addr = keypair()
    ch = client.post("/link/challenge", json={"borrower": BORROWER, "mainnetAddress": addr}).json()
    r = client.post(
        "/link/verify", json={"challengeId": ch["challengeId"], "publicKey": pub, "signature": "zz"}
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "BAD_SIGNATURE"
