import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../lib/validate.js';
import { readAccessToken, requireAuth } from '../../middleware/auth.js';
import {
  emailLinkRateLimit,
  loginRateLimit,
  resendEmailRateLimit,
  signupRateLimit,
} from '../../middleware/rate-limit.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies.js';
import { emailLinkSchema, loginSchema, signupSchema } from './auth.schemas.js';
import {
  login,
  logout,
  refreshSession,
  resendVerification,
  resumeSession,
  signup,
  verifyEmail,
  type RequestContext,
} from './auth.service.js';

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
  // Rate limits are left out in tests, which make many requests from one address.
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);

  router.post('/signup', ...limit(signupRateLimit), async (req, res) => {
    const input = validate(signupSchema, req.body);
    const { user, tokens } = await signup(input, requestContext(req));
    setAuthCookies(res, tokens);
    res.status(201).json({ user });
  });

  router.post('/login', ...limit(loginRateLimit), async (req, res) => {
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

  // The link in the confirmation email. Works signed out, e.g. opened on another device.
  router.post('/verify-email', ...limit(emailLinkRateLimit), async (req, res) => {
    const { token } = validate(emailLinkSchema, req.body);
    res.json(await verifyEmail(token));
  });

  router.post('/verify-email/resend', requireAuth, ...limit(resendEmailRateLimit), async (req, res) => {
    res.json(await resendVerification(req.auth!.userId));
  });

  return router;
}
