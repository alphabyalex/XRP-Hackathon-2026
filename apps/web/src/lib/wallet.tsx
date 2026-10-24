"use client";
// One wallet connection for the whole site (header pill, /borrow, ...).
// Crossmark testnet sign-in: the api issues a challenge, Crossmark signs it,
// the credit service verifies the signature. The app only sees the address,
// public key and signature. The connection is remembered in localStorage for
// an instant header on the next page load; the api stays the source of truth.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { walletChallenge, walletConnect, walletDisconnect, walletGet, walletVerify, type ConnectedWallet } from "./lendingApi";
import { ACCOUNT } from "./session";

const STORE_KEY = "moonshift.wallet";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type WalletState = {
  wallet: ConnectedWallet | null;
  // false until the api has answered; readers can fall back to server-rendered data
  loaded: boolean;
  busy: boolean;
  // Crossmark is on another network than testnet
  wrongNetwork: boolean;
  error: string | null;
  connect: () => Promise<void>;
  connectAddress: (address: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<WalletState | null>(null);

function remember(w: ConnectedWallet | null) {
  try {
    if (w) localStorage.setItem(STORE_KEY, JSON.stringify(w));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // storage blocked (private mode): the api still knows the wallet
  }
}

function recalled(): ConnectedWallet | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ConnectedWallet) : null;
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
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wrongNetwork, setWrongNetwork] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setWallet = useCallback((w: ConnectedWallet | null) => {
    setWalletState(w);
    remember(w);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setWallet((await walletGet(ACCOUNT)).wallet);
    } catch {
      // api unreachable: keep what we have
    } finally {
      setLoaded(true);
    }
  }, [setWallet]);

  useEffect(() => {
    const w = recalled();
    if (w) setWalletState(w);
    void refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const sdk = await crossmark();
      const known = sdk.sync.getNetwork();
      if (known && known.type !== "testnet") {
        setWrongNetwork(true);
        throw new Error("Switch Crossmark to Testnet");
      }
      const ch = await walletChallenge(ACCOUNT);
      const { response } = await sdk.async.signInAndWait(ch.messageHex);
      const d = response?.data;
      if (!d?.address) throw new Error("Crossmark did not return an address.");
      if (d.network?.type !== "testnet") {
        setWrongNetwork(true);
        throw new Error("Switch Crossmark to Testnet");
      }
      if (!d.publicKey || !d.signature) throw new Error("Crossmark did not sign the sign-in request.");
      setWrongNetwork(false);
      setWallet(await walletVerify(ACCOUNT, { challengeId: ch.challengeId, publicKey: d.publicKey, signature: d.signature, address: d.address }));
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [setWallet]);

  const connectAddress = useCallback(
    async (address: string) => {
      setBusy(true);
      setError(null);
      try {
        setWallet(await walletConnect(ACCOUNT, address));
      } catch (e) {
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [setWallet]
  );

  const disconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await walletDisconnect(ACCOUNT);
      setWallet(null);
      setWrongNetwork(false);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [setWallet]);

  const value = useMemo(
    () => ({ wallet, loaded, busy, wrongNetwork, error, connect, connectAddress, disconnect, refresh }),
    [wallet, loaded, busy, wrongNetwork, error, connect, connectAddress, disconnect, refresh]
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
