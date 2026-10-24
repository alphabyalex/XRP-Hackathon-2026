// Single place the UI reads brand colors/fonts from. Source of truth is
// XRP-Hackathon/BRAND.md, mirrored in packages/shared/src/brand.ts.
// Components never hardcode hex values, they use Tailwind tokens (bg-ink,
// text-ink2, ...) which map to the CSS variables set in app/globals.css.

import { brand } from "@moonshift/shared";

export const theme = {
  colors: brand.colors,
  accents: brand.accents,
  defaultAccent: brand.defaultAccent,
  fonts: brand.fonts,
  radius: brand.radius,
  name: brand.name,
  tagline: brand.tagline,
};
