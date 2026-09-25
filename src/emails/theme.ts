/**
 * Brand colours and fonts for email templates. A deliberate copy of the frontend design tokens
 * (frontend/src/styles/tokens.ts, plan §2.3 and §12.2); update both together.
 * Email clients don't load the web fonts reliably, so each font has a safe fallback stack.
 */
export const emailTheme = {
  colors: {
    primary: '#0E3B32',
    gold: '#C8A96A',
    goldText: '#8A6A2E',
    ink: '#0B1210',
    muted: '#5E6662',
    canvas: '#FAF8F4',
    surface: '#FFFFFF',
    line: '#E7E2D9',
  },
  fonts: {
    display: "Fraunces, Georgia, 'Times New Roman', serif",
    body: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  radius: {
    control: '10px',
    card: '16px',
  },
} as const;
