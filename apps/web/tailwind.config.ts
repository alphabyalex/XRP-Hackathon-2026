import type { Config } from "tailwindcss";

// Colors and fonts read the CSS variables set in app/globals.css (which in
// turn come from packages/shared/src/brand.ts). Components use bg-ink,
// text-ink2, bg-accent etc, never hardcoded hex values.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        tint: "var(--tint)",
        tint2: "var(--tint2)",
        ink: "var(--ink)",
        ink2: "var(--ink2)",
        ink3: "var(--ink3)",
        rule: "var(--rule)",
        rule2: "var(--rule2)",
        accent: "var(--accent)",
        "accent-ink": "var(--accent-ink)",
        "accent-wash": "var(--accent-wash)",
        up: "var(--up)",
        down: "var(--down)",
        idle: "var(--idle)",
        open: "var(--open)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Helvetica Neue", "Arial", "sans-serif"],
        code: ["var(--font-code)", "ui-monospace", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        input: "12px",
        card: "18px",
        plate: "20px",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(.2,.7,.15,1)",
      },
    },
  },
  plugins: [],
};

export default config;
