"use client";
// Connect a testnet wallet to the borrower's credit profile: Crossmark sign-in
// (signed challenge, ownership verified) or a pasted address (read-only).
// The app only receives the address, public key and signature; Crossmark signs.
import { useState } from "react";
import { shortHash } from "@/lib/format";
import { walletChallenge, walletConnect, walletDisconnect, walletVerify, type ConnectedWallet } from "@/lib/lendingApi";
import { Button } from "./Button";

const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function WalletConnect({
  borrower,
  wallet,
  onChange,
}: {
  borrower: string;
  wallet: ConnectedWallet | null;
  onChange: (w: ConnectedWallet | null) => void;
}) {
  const [busy, setBusy] = useState<null | "crossmark" | "paste" | "disconnect">(null);
  const [err, setErr] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");

  async function connectCrossmark() {
    setBusy("crossmark");
    setErr(null);
    try {
      const sdk = (await import("@crossmarkio/sdk")).default;
      // The extension announces itself shortly after the page loads.
      for (let i = 0; i < 12 && !sdk.sync.isInstalled(); i++) await sleep(150);
      if (!sdk.sync.isInstalled()) throw new Error("Install the Crossmark browser extension to connect a wallet.");
      const known = sdk.sync.getNetwork();
      if (known && known.type !== "testnet") throw new Error("Switch Crossmark to Testnet");
      const ch = await walletChallenge(borrower);
      const { response } = await sdk.async.signInAndWait(ch.messageHex);
      const d = response?.data;
      if (!d?.address) throw new Error("Crossmark did not return an address.");
      if (d.network?.type !== "testnet") throw new Error("Switch Crossmark to Testnet");
      if (!d.publicKey || !d.signature) throw new Error("Crossmark did not sign the sign-in request.");
      onChange(await walletVerify(borrower, { challengeId: ch.challengeId, publicKey: d.publicKey, signature: d.signature, address: d.address }));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function connectPasted() {
    const address = pasted.trim();
    if (!ADDRESS.test(address)) return setErr("Enter a classic XRPL address (starts with r).");
    setBusy("paste");
    setErr(null);
    try {
      onChange(await walletConnect(borrower, address));
      setPasting(false);
      setPasted("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    setErr(null);
    try {
      await walletDisconnect(borrower);
      onChange(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (wallet) {
    return (
      <div className="wallet">
        <div>
          <b>Wallet {shortHash(wallet.address)}</b>
          <span className={wallet.verified ? "ok" : "muted"}>{wallet.verified ? "Ownership verified" : "Ownership not verified"}</span>
        </div>
        <button type="button" className="linkish" disabled={!!busy} onClick={disconnect}>
          {busy === "disconnect" ? "Disconnecting..." : "Disconnect"}
        </button>
        {err && <p className="note dn">{err}</p>}
      </div>
    );
  }

  return (
    <div className="wallet">
      <div className="wallet-actions">
        <Button size="sm" disabled={!!busy} onClick={connectCrossmark}>
          {busy === "crossmark" ? "Waiting for Crossmark..." : "Connect wallet"}
        </Button>
        {!pasting && (
          <button type="button" className="linkish" onClick={() => setPasting(true)}>
            or paste a testnet address
          </button>
        )}
      </div>
      {pasting && (
        <div className="wallet-paste">
          <div className="inp">
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="r..."
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connectPasted()}
            />
          </div>
          <Button size="sm" variant="ghost" disabled={!!busy || !pasted.trim()} onClick={connectPasted}>
            {busy === "paste" ? "Reading..." : "Use address"}
          </Button>
        </div>
      )}
      {err && <p className="note dn">{err}</p>}
    </div>
  );
}
