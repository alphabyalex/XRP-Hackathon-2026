import type { ReactNode } from "react";

// The app view on Home and Market. It used to be a browser-style box with its own tab row (Rent,
// Market, Portfolio...), which repeated the site nav; now it is part of the page: no chrome, no
// tilt. The tab props stay for callers; only the active view renders.
export function AppWindow({
  children,
}: {
  tabs?: string[];
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  acct?: ReactNode;
  children: ReactNode;
}) {
  return <div className="app-view">{children}</div>;
}
