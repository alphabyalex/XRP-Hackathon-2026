"use client";
// Header wallet pill: "Connect wallet" (Crossmark testnet sign-in), then the
// wallet's short address with a small menu. "Switch to Testnet" when
// Crossmark is on another network.
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { explorerAccountUrl, shortAddress, useWallet } from "@/lib/wallet";
import { useToast } from "./Toast";

// Generic wallet glyph (Crossmark's SDK ships no wallet icon to reuse).
function WalletGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3" />
      <rect x="3" y="7.5" width="18" height="12" rx="2.5" />
      <path d="M16 13.5h2" />
    </svg>
  );
}

export function WalletButton() {
  const { wallet, busy, phase, wrongNetwork, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    addEventListener("keydown", close);
    return () => {
      removeEventListener("mousedown", close);
      removeEventListener("keydown", close);
    };
  }, [open]);

  async function signIn() {
    try {
      await connect();
    } catch (e) {
      toast("Wallet not connected", (e as Error).message);
    }
  }

  if (!wallet || wrongNetwork) {
    return (
      <button type="button" className="btn ink sm cta wallet-pill" disabled={busy} onClick={signIn}>
        {phase === "setup" ? "Setting up..." : busy ? "Connecting..." : wrongNetwork ? "Switch to Testnet" : "Connect wallet"}
      </button>
    );
  }

  return (
    <div className="wallet-menu" ref={box}>
      <button
        type="button"
        className="btn ink sm cta wallet-pill"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <WalletGlyph />
        <span className="mono">{shortAddress(wallet.address)}</span>
      </button>
      <div className={clsx("wallet-pop", open && "open")} role="menu">
        <button
          type="button"
          role="menuitem"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(wallet.address);
              toast("Address copied", wallet.address);
            } catch {
              toast("Copy failed", wallet.address);
            }
            setOpen(false);
          }}
        >
          Copy address
        </button>
        <a role="menuitem" href={explorerAccountUrl(wallet)} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
          View on explorer
        </a>
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={async () => {
            setOpen(false);
            try {
              await disconnect();
            } catch (e) {
              toast("Disconnect failed", (e as Error).message);
            }
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
