"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { MoonMark } from "./MoonMark";
import { WalletButton } from "./WalletButton";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/borrow", label: "Borrow" },
  { href: "/lend", label: "Lend" },
  { href: "/market", label: "Market" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/playground", label: "Developers" },
  { href: "/#schedule", label: "How it earns" },
];

export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [onNight, setOnNight] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setScrolled(scrollY > 8);
      const enter = document.getElementById("enter");
      setOnNight(!!enter && enter.getBoundingClientRect().top < 72);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={clsx("nav", scrolled && "scrolled", onNight && "on-night")}>
      <div className="wrap nav-in">
        <Link className="logo" href="/">
          <MoonMark size={28} />
          Moonshift
        </Link>
        <nav className="links" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="nav-end">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
