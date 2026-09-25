import { Router, type Request } from 'express';
import { validate } from '../../lib/validate.js';
import { readAccessToken } from '../../middleware/auth.js';
import { loginRateLimit } from '../../middleware/rate-limit.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies.js';
import { loginSchema } from './auth.schemas.js';
import { login, logout, refreshSession, resumeSession, type RequestContext } from './auth.service.js';

const requestContext = (req: Request): RequestContext => ({
  ip: req.ip,
  userAgent: req.get('user-agent'),
});

const readRefreshToken = (req: Request): string | undefined => {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
};

export function authRouter(options: { rateLimit: boolean }) {
  const router = Router();

  router.post('/login', ...(options.rateLimit ? [loginRateLimit()] : []), async (req, res) => {
    const input = validate(loginSchema, req.body);
    const { user, tokens } = await login(input, requestContext(req));
    setAuthCookies(res, tokens);
    res.json({ user });
  });

  // The website's session check on page load: always 200, with `user: null` when signed out.
  router.post('/session', async (req, res) => {
    const accessToken = readAccessToken(req);
    const refreshToken = readRefreshToken(req);
    const { user, tokens } = await resumeSession({ accessToken, refreshToken }, requestContext(req));
    if (tokens) setAuthCookies(res, tokens);
    else if (!user && (accessToken || refreshToken)) clearAuthCookies(res);
    res.json({ user });
  });

  router.post('/refresh', async (req, res) => {
    try {
      const { user, tokens } = await refreshSession(readRefreshToken(req), requestContext(req));
      setAuthCookies(res, tokens);
      res.json({ user });
    } catch (error) {
      // A refresh that fails leaves the browser signed out, with no stale cookies behind.
      clearAuthCookies(res);
      throw error;
    }
  });

  router.post('/logout', async (req, res) => {
    await logout(readRefreshToken(req));
    clearAuthCookies(res);
    res.status(204).end();
  });

  return router;
}
