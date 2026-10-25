"use client";
import Link from "next/link";
import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-bar">
          <div className="footer-left">
            <Link className="logo" href="/" style={{ fontSize: 16 }}>
              <MoonMark size={22} />
              Moonshift
            </Link>
            <span className="footer-desc">GPU compute and credit on the XRP Ledger.</span>
          </div>

          <nav className="footer-links" aria-label="Footer Navigation">
            <Link href="/market">Market</Link>
            <Link href="/portfolio">Portfolio</Link>
            <Link href="/borrow">Borrow</Link>
            <Link href="/lend">Lend</Link>
            <Link href="/playground">Developers</Link>
            <Link href="/admin/router">Router</Link>
          </nav>

          <div className="footer-pills">
            <span className="footer-pill">
              <span className="footer-dot" />
              XRPL Testnet
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
