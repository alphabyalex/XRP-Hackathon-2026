"use client";
import Link from "next/link";
import { MoonMark } from "./MoonMark";
import "./Footer.css";

const REPO = "https://github.com/alphabyalex/XRP-Hackathon-2026";

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/market", label: "Market" },
      { href: "/borrow", label: "Borrow" },
      { href: "/lend", label: "Lend" },
      { href: "/portfolio", label: "Portfolio" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/models", label: "Models" },
      { href: "/docs#api", label: "API reference" },
      { href: REPO, label: "GitHub", external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/docs#overview", label: "About" },
      { href: "/borrow#apply", label: "Request capital" },
      { href: "/borrow#apply", label: "List a market" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="site-footer ft">
      <div className="wrap">
        <div className="ft-top">
          <div className="ft-brand">
            <Link className="logo" href="/" style={{ fontSize: 16 }}>
              <MoonMark size={22} />
              Moonshift
            </Link>
            <p>GPU compute, GPU shares and credit, settled on the XRP Ledger.</p>
          </div>
          <nav className="ft-cols" aria-label="Footer">
            {COLUMNS.map((c) => (
              <div key={c.title}>
                <span>{c.title}</span>
                <ul>
                  {c.links.map((l) => (
                    <li key={l.label}>
                      {l.external ? (
                        <a href={l.href} target="_blank" rel="noreferrer">
                          {l.label}
                        </a>
                      ) : (
                        <Link href={l.href}>{l.label}</Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <div className="ft-base">&copy; 2026 Moonshift. All rights reserved.</div>
      </div>
    </footer>
  );
}
