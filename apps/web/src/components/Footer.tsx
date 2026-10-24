import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="logo" style={{ fontSize: 16 }}>
          <MoonMark size={22} />
          Moonshift
        </div>
      </div>
    </footer>
  );
}
