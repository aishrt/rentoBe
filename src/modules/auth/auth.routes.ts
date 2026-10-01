import { Router, type Request, type RequestHandler } from 'express';
import { validate } from '../../lib/validate.js';
import { readAccessToken, requireAuth } from '../../middleware/auth.js';
import {
  codeCheckRateLimit,
  emailLinkRateLimit,
  forgotPasswordRateLimit,
  loginRateLimit,
  mfaLoginRateLimit,
  phoneCodeRateLimit,
  resendEmailRateLimit,
  signupRateLimit,
} from '../../middleware/rate-limit.js';
import { acceptStaffInviteSchema, staffInviteTokenSchema } from '../staff/staff.schemas.js';
import { acceptStaffInvite, checkStaffInvite } from '../staff/staff.service.js';
import { confirmEmailChange } from '../users/account.service.js';
import { REFRESH_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies.js';
import {
  codeSchema,
  emailLinkSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaLoginSchema,
  phoneSchema,
  resetPasswordSchema,
  signupSchema,
} from './auth.schemas.js';
import {
  completeMfaLogin,
  forgotPassword,
  login,
  logout,
  refreshSession,
  resendVerification,
  resetPassword,
  resumeSession,
  signup,
  verifyEmail,
  type RequestContext,
} from './auth.service.js';
import { sendPhoneCode, verifyPhoneCode } from './phone.service.js';

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
    const result = await login(input, requestContext(req));
    // Staff with an authenticator app aren't signed in yet: the code comes next.
    if ('mfaChallenge' in result) {
      res.json({ mfaRequired: true, challenge: result.mfaChallenge });
      return;
    }
    setAuthCookies(res, result.tokens);
    res.json({ user: result.user });
  });

  router.post('/login/mfa', ...limit(mfaLoginRateLimit), async (req, res) => {
    const { challenge, code } = validate(mfaLoginSchema, req.body);
    const { user, tokens } = await completeMfaLogin(challenge, code, requestContext(req));
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

  // Always the same answer, so it can't be used to find out which emails have accounts.
  router.post('/forgot-password', ...limit(forgotPasswordRateLimit), async (req, res) => {
    const { email } = validate(forgotPasswordSchema, req.body);
    await forgotPassword(email);
    res.status(204).end();
  });

  router.post('/reset-password', ...limit(emailLinkRateLimit), async (req, res) => {
    const { token, password } = validate(resetPasswordSchema, req.body);
    res.json(await resetPassword(token, password, requestContext(req)));
  });

  // The link sent to a new email address (POST /me/email).
  router.post('/confirm-email-change', ...limit(emailLinkRateLimit), async (req, res) => {
    const { token } = validate(emailLinkSchema, req.body);
    res.json(await confirmEmailChange(token, req.ip));
  });

  // The link in a support team invitation (plan §6.2): who it's for, then accepting it with a password.
  // Staff can't sign up any other way.
  router.post('/staff-invite', ...limit(emailLinkRateLimit), async (req, res) => {
    const { token } = validate(staffInviteTokenSchema, req.body);
    res.json(await checkStaffInvite(token));
  });

  router.post('/staff-invite/accept', ...limit(emailLinkRateLimit), async (req, res) => {
    const { token, password } = validate(acceptStaffInviteSchema, req.body);
    res.json(await acceptStaffInvite(token, password, req.ip));
  });

  router.post('/phone/otp', requireAuth, ...limit(phoneCodeRateLimit), async (req, res) => {
    const { phone } = validate(phoneSchema, req.body);
    res.json(await sendPhoneCode(req.auth!.userId, phone));
  });

  router.post('/phone/verify', requireAuth, ...limit(codeCheckRateLimit), async (req, res) => {
    const { code } = validate(codeSchema, req.body);
    res.json({ user: await verifyPhoneCode(req.auth!.userId, code, req.ip) });
  });

  return router;
}
