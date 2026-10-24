"use client";

const THEME_KEY = "moonshift-theme";

function applyTheme(next: "light" | "dark") {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode */
  }
  document.cookie = `${THEME_KEY}=${next};path=/;max-age=31536000;samesite=lax`;
}

export function ThemeToggle() {
  function toggle() {
    const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  }

  return (
    <button type="button" className="theme-toggle" onClick={toggle} aria-label="Toggle color theme">
      <svg className="moon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M10.4 1.2a6.6 6.6 0 1 0 4.4 10.2A5.6 5.6 0 0 1 10.4 1.2Z"
        />
      </svg>
      <svg className="sun" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="3" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.2 3.2l1.3 1.3M11.5 11.5l1.3 1.3M12.8 3.2l-1.3 1.3M4.5 11.5l-1.3 1.3" />
        </g>
      </svg>
    </button>
  );
}
