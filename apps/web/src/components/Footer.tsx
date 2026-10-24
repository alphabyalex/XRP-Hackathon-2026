import Link from "next/link";
import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <Link className="logo" href="/" style={{ fontSize: 16 }}>
          <MoonMark size={22} />
          Moonshift
        </Link>
      </div>
    </footer>
  );
}
