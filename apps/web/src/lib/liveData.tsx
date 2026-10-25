"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiGpuDetail } from "@moonshift/shared";
import { apiFetch, getGpu, getGpus, eventsUrl, ApiUnreachableError } from "./api";

export type GpuMap = Record<string, ApiGpuDetail>;

interface LiveDataValue {
  gpus: GpuMap;
  unreachable: boolean;
  refresh: () => void;
  now: number;
  // Lets usePolled hooks refetch the moment a matching SSE event arrives.
  subscribe: (fn: (type: string) => void) => () => void;
}

// Every event type the api streams on /events.
const EVENT_TYPES = ["usage", "tx", "calendar", "dividend", "loan", "market", "stats", "aws", "task"];

const LiveDataContext = createContext<LiveDataValue>({ gpus: {}, unreachable: false, refresh: () => {}, now: 0, subscribe: () => () => {} });

// Subscribes to SSE /events and refetches GPU details on any event, so
// prices, the schedule and the hero proof row update in place. Debounced so
// a burst of usage events doesn't fire a refetch per event. No auto-scrolling
// ticker, no per-field patching, just a simple poll-on-event refresh.
export function LiveDataProvider({
  initial,
  initialNow,
  children,
}: {
  initial: GpuMap;
  // The server's clock at render time. Schedules are drawn from this on the
  // first render so server HTML and client hydration match exactly, then the
  // client switches to its own clock right after mount.
  initialNow?: number;
  children: ReactNode;
}) {
  const [gpus, setGpus] = useState<GpuMap>(initial);
  const [now, setNow] = useState<number>(initialNow ?? Date.now());

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [unreachable, setUnreachable] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const refreshRef = useRef<() => void>(() => {});
  const listeners = useRef(new Set<(type: string) => void>());
  const subscribe = useRef((fn: (type: string) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }).current;

  useEffect(() => {
    async function refresh() {
      try {
        const listed = await getGpus();
        const entries = await Promise.all(listed.map((g) => getGpu(g.id)));
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
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, () => {
          scheduleRefresh();
          listeners.current.forEach((fn) => fn(type));
        });
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

    // Safety net: refetch every 5 seconds so data never goes stale even if
    // the event stream drops quietly.
    const poll = setInterval(refresh, 5_000);

    return () => {
      clearTimeout(debounceRef.current);
      clearInterval(poll);
      es?.close();
    };
  }, []);

  return (
    <LiveDataContext.Provider value={{ gpus, unreachable, refresh: () => refreshRef.current(), now, subscribe }}>
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

export function useNow(): Date {
  return new Date(useContext(LiveDataContext).now || Date.now());
}

export function useRefreshLive(): () => void {
  return useContext(LiveDataContext).refresh;
}

export function useApiUnreachable(): boolean {
  return useContext(LiveDataContext).unreachable;
}

// Polls one api route every `ms` (2 to 5 seconds) and also refetches when one of the named SSE
// events arrives. Keeps the last good value through a failed read; `error` is set until a read
// works again. `data` is undefined until the first answer, so callers show a loading state.
export function usePolled<T>(path: string | null, { ms = 4000, on = [] as string[] } = {}): { data: T | undefined; error: string | null } {
  const { subscribe } = useContext(LiveDataContext);
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const onKey = on.join(",");
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      apiFetch<T>(path)
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Not available right now"));
    load();
    const t = setInterval(load, ms);
    const events = onKey ? onKey.split(",") : [];
    const off = subscribe((type) => {
      if (!events.includes(type)) return;
      clearTimeout(debounce);
      debounce = setTimeout(load, 250);
    });
    return () => {
      alive = false;
      clearInterval(t);
      clearTimeout(debounce);
      off();
    };
  }, [path, ms, onKey, subscribe]);
  return { data, error };
}
