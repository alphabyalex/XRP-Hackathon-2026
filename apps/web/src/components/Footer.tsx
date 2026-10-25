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
      </div>
    </footer>
  );
}
