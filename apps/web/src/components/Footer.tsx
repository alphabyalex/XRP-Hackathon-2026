import { MoonMark } from "./MoonMark";

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="logo" style={{ fontSize: 16 }}>
          <MoonMark size={22} />
          Moonshift
        </div>
        <div>XRPL Commons AI &amp; Fintech Hackathon, New York, October 2026. Testnet only. All figures are simulated.</div>
      </div>
    </footer>
  );
}
