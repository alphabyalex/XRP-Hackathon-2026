"use client";
import Link from "next/link";
import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div className="footer-grid">
          <div className="footer-brand">
            <Link className="logo" href="/" style={{ fontSize: 18, fontWeight: 600 }}>
              <MoonMark size={24} />
              Moonshift
            </Link>
            <p className="footer-tagline">
              Decentralized GPU compute and credit protocol built natively on the XRP Ledger.
            </p>
          </div>

          <div className="footer-col">
            <h4>Protocol</h4>
            <ul>
              <li>
                <Link href="/market">GPU Market</Link>
              </li>
              <li>
                <Link href="/lend">Lending Vaults (XLS-65)</Link>
              </li>
              <li>
                <Link href="/borrow">Borrowing &amp; Credit</Link>
              </li>
              <li>
                <Link href="/portfolio">Portfolio &amp; Yields</Link>
              </li>
              <li>
                <Link href="/admin/router">Inference Router</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Ecosystem</h4>
            <ul>
              <li>
                <a href="https://devnet.xrpl.org" target="_blank" rel="noreferrer">
                  XRP Ledger Devnet
                </a>
              </li>
              <li>
                <a href="https://akash.network" target="_blank" rel="noreferrer">
                  Akash Network
                </a>
              </li>
              <li>
                <a href="https://aws.amazon.com" target="_blank" rel="noreferrer">
                  Amazon Web Services
                </a>
              </li>
              <li>
                <a href="https://openocean.finance" target="_blank" rel="noreferrer">
                  OpenOcean Cloud
                </a>
              </li>
              <li>
                <a href="https://vast.ai" target="_blank" rel="noreferrer">
                  Vast.ai Fleet
                </a>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h4>Developers</h4>
            <ul>
              <li>
                <Link href="/playground">API Playground</Link>
              </li>
              <li>
                <a href="https://github.com/alphabyalex/XRP-Hackathon-2026" target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </li>
              <li>
                <a href="/admin/router">Preemption Telemetry</a>
              </li>
              <li>
                <a href="https://xrpl.org" target="_blank" rel="noreferrer">
                  XRPL Standards
                </a>
              </li>
              <li>
                <Link href="/#schedule">Nightly Batch Payouts</Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom-bar">
          <span className="footer-copy">&copy; 2026 Moonshift Protocol. All rights reserved.</span>
          <div className="footer-links">
            <a href="https://github.com/alphabyalex/XRP-Hackathon-2026" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <span>&middot;</span>
            <Link href="/market">Marketplace</Link>
            <span>&middot;</span>
            <Link href="/playground">Developers</Link>
            <span>&middot;</span>
            <span>Non-custodial &amp; Open Source</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
