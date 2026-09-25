import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../../env.js';
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_MS } from './auth.tokens.js';

export const ACCESS_COOKIE = 'rv_access';
export const REFRESH_COOKIE = 'rv_refresh';

// The refresh token is only ever sent to the auth routes.
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    ...(env.COOKIE_DOMAIN && { domain: env.COOKIE_DOMAIN }),
  };
}

export function setAuthCookies(res: Response, tokens: { accessToken: string; refreshToken: string }): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...baseCookie(),
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseCookie(),
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: REFRESH_COOKIE_PATH });
}
