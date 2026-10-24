import Link from "next/link";
import clsx from "clsx";
import type { ReactNode, MouseEventHandler } from "react";

interface ButtonProps {
  variant?: "ink" | "ghost";
  size?: "md" | "sm";
  arrow?: boolean;
  children: ReactNode;
  className?: string;
  href?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: MouseEventHandler;
}

export function Button({
  variant = "ink",
  size = "md",
  arrow,
  children,
  className,
  href,
  type = "button",
  disabled,
  onClick,
}: ButtonProps) {
  const cls = clsx("btn", variant, size === "sm" && "sm", className);
  const content = (
    <>
      {children}
      {arrow && (
        <span className="arrow" aria-hidden="true">
          &rarr;
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cls} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type={type} className={cls} disabled={disabled} onClick={onClick}>
      {content}
    </button>
  );
}
