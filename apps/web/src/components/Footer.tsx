import Link from "next/link";
import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="logo" style={{ fontSize: 16 }}>
          <MoonMark size={22} />
          Moonshift
        </div>
        <div>Moonshift. GPU-backed lending on the XRP Ledger.</div>
        <nav className="foot-links" aria-label="Footer">
          <Link href="/market">Market</Link>
          <Link href="/borrow">Borrow</Link>
          <Link href="/lend">Lend</Link>
          <Link href="/playground">Developers</Link>
        </nav>
      </div>
    </footer>
  );
}
