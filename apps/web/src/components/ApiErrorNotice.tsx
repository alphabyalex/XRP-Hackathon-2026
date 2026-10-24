// Plain, styled-like-the-rest-of-the-page notice, no red error box.
// Per CLAUDE_NOTES_3_FRONTEND.md section 4 "Errors".
export function ApiErrorNotice() {
  return (
    <p style={{ color: "var(--ink2)", fontSize: 15 }}>
      Can&apos;t reach the Moonshift API on port 4000. Start it with <code style={{ fontFamily: "var(--code)" }}>npm run dev</code>.
    </p>
  );
}
