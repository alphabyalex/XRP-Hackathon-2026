"use client";
// The signed-in wallet is the user, site-wide (header pill, /borrow, /lend,
// /portfolio, ...). Crossmark testnet sign-in: the api issues a challenge,
// Crossmark signs it, the api verifies the signature, looks up or creates the
// wallet's Moonshift account and sets an httpOnly session cookie. The app only
// sees the address, public key and signature. The last wallet is remembered in
// localStorage for an instant header on the next page load; the api's session
// stays the source of truth.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { walletChallenge, walletDisconnect, walletGet, walletVerify, type ConnectedWallet } from "./lendingApi";

const STORE_KEY = "moonshift.wallet";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Account = { address: string };
// signing: waiting for Crossmark; setup: the api is preparing the account.
export type WalletPhase = "idle" | "signing" | "setup" | "disconnecting";

export type WalletState = {
  wallet: ConnectedWallet | null;
  account: Account | null;
  // false until the api has answered
  loaded: boolean;
  phase: WalletPhase;
  busy: boolean;
  // Crossmark is on another network than testnet
  wrongNetwork: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<WalletState | null>(null);

type Stored = { wallet: ConnectedWallet; account: Account | null };

function remember(v: Stored | null) {
  try {
    if (v) localStorage.setItem(STORE_KEY, JSON.stringify(v));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // storage blocked (private mode): the session cookie still works
  }
}

function recalled(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v?.wallet?.address ? (v as Stored) : null;
  } catch {
    return null;
  }
}

async function crossmark() {
  const sdk = (await import("@crossmarkio/sdk")).default;
  // The extension announces itself shortly after the page loads.
  for (let i = 0; i < 12 && !sdk.sync.isInstalled(); i++) await sleep(150);
  if (!sdk.sync.isInstalled()) throw new Error("Install the Crossmark browser extension to connect a wallet.");
  return sdk;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWalletState] = useState<ConnectedWallet | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<WalletPhase>("idle");
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((w: ConnectedWallet | null, a: Account | null) => {
    setWalletState(w);
    setAccount(w ? a : null);
    remember(w ? { wallet: w, account: a } : null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await walletGet();
      set(me.wallet, me.account);
    } catch {
      // api unreachable: keep what we have
    } finally {
      setLoaded(true);
    }
  }, [set]);

  useEffect(() => {
    const r = recalled();
    if (r) {
      setWalletState(r.wallet);
      setAccount(r.account);
    }
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setPhase("signing");
    setError(null);
    try {
      const sdk = await crossmark();
      const known = sdk.sync.getNetwork();
      if (known && known.type !== "testnet") {
        setWrongNetwork(true);
        throw new Error("Switch Crossmark to Testnet");
      }
      const ch = await walletChallenge();
      const { response } = await sdk.async.signInAndWait(ch.messageHex);
      const d = response?.data;
      if (!d?.address) throw new Error("Crossmark did not return an address.");
      if (d.network?.type !== "testnet") {
        setWrongNetwork(true);
        throw new Error("Switch Crossmark to Testnet");
      }
      if (!d.publicKey || !d.signature) throw new Error("Crossmark did not sign the sign-in request.");
      setWrongNetwork(false);
      setPhase("setup");
      const out = await walletVerify({ challengeId: ch.challengeId, publicKey: d.publicKey, signature: d.signature, address: d.address });
      set(out.wallet, out.account);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setPhase("idle");
    }
  }, [set]);

  const disconnect = useCallback(async () => {
    setPhase("disconnecting");
    setError(null);
    try {
      await walletDisconnect();
      set(null, null);
      setWrongNetwork(false);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setPhase("idle");
    }
  }, [set]);

  const value = useMemo(
    () => ({ wallet, account, loaded, phase, busy: phase !== "idle", wrongNetwork, error, connect, disconnect, refresh }),
    [wallet, account, loaded, phase, wrongNetwork, error, connect, disconnect, refresh]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet needs <WalletProvider> (app/layout.tsx)");
  return v;
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const explorerAccountUrl = (w: ConnectedWallet) =>
  `https://${w.network === "mainnet" ? "livenet" : w.network}.xrpl.org/accounts/${w.address}`;
