"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { MoonMark } from "./MoonMark";
import { Button } from "./Button";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/market", label: "Market" },
  { href: "/#schedule", label: "How it earns" },
  { href: "/borrow", label: "Borrow" },
  { href: "/lend", label: "Lend" },
  { href: "/playground", label: "Developers" },
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
          <Button href="/market" size="sm" className="cta">
            Open app
          </Button>
        </div>
      </div>
    </header>
  );
}
