import type { AuthContext } from '../modules/auth/auth.tokens.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      auth?: AuthContext;
    }
  }
}

export {};
