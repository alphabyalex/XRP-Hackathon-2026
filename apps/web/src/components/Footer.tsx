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
          <div className="footer-right">
            <span className="footer-desc">&copy; 2026 Moonshift</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
