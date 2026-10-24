import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Schibsted_Grotesk, Spline_Sans_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { theme } from "@/theme";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { ToastHost } from "@/components/Toast";

const schibstedGrotesk = Schibsted_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const splineSansMono = Spline_Sans_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-code",
  display: "swap",
});

export const metadata: Metadata = {
  title: theme.name,
  description: theme.tagline,
};

// Sets the .js class before first paint, same as the reference's inline
// <script>document.documentElement.classList.add('js')</script>. The
// ?accent= query param overrides the server-rendered default (theme.defaultAccent,
// set below) for quick comparison, still before paint so there's no flash.
const beforePaint = `
document.documentElement.classList.add('js');
try {
  var storedTheme = localStorage.getItem('moonshift-theme');
  if (storedTheme === 'dark' || storedTheme === 'light') {
    document.documentElement.dataset.theme = storedTheme;
  }
  var accent = new URLSearchParams(location.search).get('accent');
  if (accent === 'moon') document.documentElement.dataset.accent = 'moon';
  else if (accent === 'orange') delete document.documentElement.dataset.accent;
} catch (e) {}
`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const stored = (await cookies()).get("moonshift-theme")?.value;
  const dataTheme = stored === "dark" || stored === "light" ? stored : undefined;

  return (
    <html
      lang="en"
      data-theme={dataTheme}
      data-accent={theme.defaultAccent === "moon" ? "moon" : undefined}
      className={`${schibstedGrotesk.variable} ${splineSansMono.variable}`}
      // beforePaint intentionally adds "js" and may change data-accent before hydration
      suppressHydrationWarning
    >
      <head>
        <Script id="before-paint" strategy="beforeInteractive">
          {beforePaint}
        </Script>
      </head>
      <body>
        <Nav />
        {children}
        <Footer />
        <ToastHost />
      </body>
    </html>
  );
}
