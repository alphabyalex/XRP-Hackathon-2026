// Source of truth: XRP-Hackathon/BRAND.md section 2. Keep this file and that
// file in sync. apps/web/src/theme.ts and app/globals.css read these values,
// nothing else should hardcode brand hex values.

export const brand = {
  name: "Moonshift",
  tagline: "Own the night shift of a GPU.",
  colors: {
    bg: "#FFFFFF", // the page
    tint: "#F5F5F3", // alternate sections, inputs, segmented controls ("Mist")
    tint2: "#ECECEA",
    ink: "#0D0D0E", // text, primary buttons, booked time
    ink2: "#55565B", // secondary text
    ink3: "#8E8F94", // tertiary text, labels
    rule: "#E6E6E3", // hairlines
    rule2: "#D4D4D0", // input borders, stronger hairlines
    up: "#0B8A4F", // price up (semantic only)
    down: "#D6342A", // price down, liquidation risk (semantic only)
    idle: "#E7E7E4", // idle time in schedules
    open: "#C3C3BF", // dashed outline for open-to-book slots
  },
  accents: {
    orange: { accent: "#FF5A1F", accentInk: "#D6430C", accentWash: "#FFF1EA" }, // default
    moon: { accent: "#FFC21A", accentInk: "#946800", accentWash: "#FFF7DC" },
  },
  defaultAccent: "moon" as "orange" | "moon", // trying this, flip back to "orange" to revert
  fonts: {
    sans: "'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif",
    code: "'Spline Sans Mono', ui-monospace, Menlo, Consolas, monospace",
  },
  radius: { input: 12, card: 18, plate: 20, pill: 999 },
} as const;

export type AccentName = keyof typeof brand.accents;
