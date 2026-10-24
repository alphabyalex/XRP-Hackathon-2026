"use client";
// Anything personal when nobody is signed in: one line and the button.
import { useWallet } from "@/lib/wallet";
import { Button } from "./Button";
import { useToast } from "./Toast";

export function ConnectPrompt({ line = "Connect your wallet to see your account" }: { line?: string }) {
  const { connect, phase } = useWallet();
  const toast = useToast();
  if (phase === "setup") {
    return (
      <div className="connect-prompt">
        <p>Setting up your account...</p>
      </div>
    );
  }
  return (
    <div className="connect-prompt">
      <p>{line}</p>
      <Button size="sm" disabled={phase !== "idle"} onClick={() => connect().catch((e) => toast("Wallet not connected", (e as Error).message))}>
        {phase === "signing" ? "Waiting for Crossmark..." : "Connect wallet"}
      </Button>
    </div>
  );
}
