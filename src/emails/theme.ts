/**
 * Brand colours and fonts for email templates. A deliberate copy of the frontend design tokens
 * (frontend/src/styles/tokens.ts, plan §2.3 and §12.2); update both together.
 * Email clients don't load the web fonts reliably, so each font has a safe fallback stack.
 */
export const emailTheme = {
  colors: {
    primary: '#0254C2',
    accent: '#C1D9FE',
    ink: '#08101D',
    muted: '#5D6470',
    canvas: '#EEEEEE',
    surface: '#FFFFFF',
    line: '#D8DBE0',
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
