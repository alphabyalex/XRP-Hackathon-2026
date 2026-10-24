"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { GPUS } from "@moonshift/shared";
import type { ApiGpuDetail } from "@moonshift/shared";
import { getGpu, eventsUrl, ApiUnreachableError } from "./api";

export type GpuMap = Record<string, ApiGpuDetail>;

interface LiveDataValue {
  gpus: GpuMap;
  unreachable: boolean;
  refresh: () => void;
}

const LiveDataContext = createContext<LiveDataValue>({ gpus: {}, unreachable: false, refresh: () => {} });

// Subscribes to SSE /events and refetches GPU details on any event, so
// prices, the schedule and the hero proof row update in place. Debounced so
// a burst of usage events doesn't fire a refetch per event. No auto-scrolling
// ticker, no per-field patching, just a simple poll-on-event refresh.
export function LiveDataProvider({ initial, children }: { initial: GpuMap; children: ReactNode }) {
  const [gpus, setGpus] = useState<GpuMap>(initial);
  const [unreachable, setUnreachable] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    async function refresh() {
      try {
        const entries = await Promise.all(GPUS.map((g) => getGpu(g.id)));
        setGpus(Object.fromEntries(entries.map((e) => [e.id, e])));
        setUnreachable(false);
      } catch (err) {
        if (err instanceof ApiUnreachableError) setUnreachable(true);
      }
    }

    function scheduleRefresh() {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(refresh, 600);
    }

    refreshRef.current = scheduleRefresh;

    let es: EventSource | null = null;
    try {
      es = new EventSource(eventsUrl());
      for (const type of ["usage", "tx", "calendar", "dividend", "loan"]) {
        es.addEventListener(type, scheduleRefresh);
      }
      // EventSource reconnects by itself. When it does (for example after the
      // api restarts), clear the error and pull fresh data without a reload.
      es.onopen = () => {
        setUnreachable(false);
        scheduleRefresh();
      };
      es.onerror = () => setUnreachable(true);
    } catch {
      setUnreachable(true);
    }

    // Safety net: refetch every 30 seconds so data never goes stale even if
    // the event stream drops quietly.
    const poll = setInterval(refresh, 30_000);

    return () => {
      clearTimeout(debounceRef.current);
      clearInterval(poll);
      es?.close();
    };
  }, []);

  return (
    <LiveDataContext.Provider value={{ gpus, unreachable, refresh: () => refreshRef.current() }}>
      {children}
    </LiveDataContext.Provider>
  );
}

export function useLiveGpus(): GpuMap {
  return useContext(LiveDataContext).gpus;
}

export function useLiveGpu(id: string): ApiGpuDetail | undefined {
  return useContext(LiveDataContext).gpus[id];
}

export function useRefreshLive(): () => void {
  return useContext(LiveDataContext).refresh;
}

export function useApiUnreachable(): boolean {
  return useContext(LiveDataContext).unreachable;
}
