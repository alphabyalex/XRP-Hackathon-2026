"use client";
// The connected wallet on the credit card. Connecting lives in the header
// pill; here: the wallet and its ownership, or a small "Connect" link plus
// a pasted testnet address (read-only, ownership not verified).
import { useState } from "react";
import { shortHash } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";

const ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export function WalletConnect() {
  const { wallet, busy, connect, connectAddress } = useWallet();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();

  if (wallet) {
    return (
      <div className="wallet">
        <div>
          <b>Wallet {shortHash(wallet.address)}</b>
          <span className={wallet.verified ? "ok" : "muted"}>{wallet.verified ? "Ownership verified" : "Ownership not verified"}</span>
        </div>
      </div>
    );
  }

  async function submitPasted() {
    const address = pasted.trim();
    if (!ADDRESS.test(address)) return setErr("Enter a classic XRPL address (starts with r).");
    setErr(null);
    try {
      await connectAddress(address);
      setPasting(false);
      setPasted("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="wallet">
      <div className="wallet-actions">
        <button
          type="button"
          className="linkish strong"
          disabled={busy}
          onClick={() => connect().catch((e) => toast("Wallet not connected", (e as Error).message))}
        >
          {busy ? "Connecting..." : "Connect"}
        </button>
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
              onKeyDown={(e) => e.key === "Enter" && submitPasted()}
            />
          </div>
          <button type="button" className="linkish strong" disabled={busy || !pasted.trim()} onClick={submitPasted}>
            {busy ? "Reading..." : "Use address"}
          </button>
        </div>
      )}
      {err && <p className="note dn">{err}</p>}
    </div>
  );
}
