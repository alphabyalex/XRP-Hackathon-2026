"use client";
// The signed-in wallet on the credit card: its address and that it signed in.
// Signing in lives in the header pill (and the connect prompt).
import { shortHash } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

export function WalletConnect() {
  const { wallet } = useWallet();
  if (!wallet) return null;
  return (
    <div className="wallet">
      <div>
        <b>Wallet {shortHash(wallet.address)}</b>
        <span className="ok">Ownership verified</span>
      </div>
    </div>
  );
}
