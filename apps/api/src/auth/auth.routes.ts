import { Router } from 'express';
import type { Response } from 'express';
import { registerSchema, loginSchema } from '@finance/shared-types';
import { authConfig } from '../config.js';
import { ApiError } from '../http-error.js';
import { parseOrThrow } from '../validation.js';
import * as service from './auth.service.js';
import { requireAuth, requireTrustedOrigin } from './middleware.js';
import { authLimiter, refreshLimiter } from './rate-limit.js';

const router = Router();

// --- Cookies refresh (HttpOnly) ---
const { cookieName, cookiePath, cookieSecure, ttlDays } = authConfig.refresh;
function setRefreshCookie(res: Response, token: string): void {
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    path: cookiePath,
    maxAge: ttlDays * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    path: cookiePath,
  });
}

function readRefreshCookie(req: {
  cookies: Record<string, string | undefined>;
}): string | undefined {
  return req.cookies[cookieName];
}

router.post('/register', authLimiter, async (req, res) => {
  const input = parseOrThrow<{ email: string; password: string }>(
    registerSchema,
    req.body,
  );
  const result = await service.registerUser(input.email, input.password);
  setRefreshCookie(res, result.refreshToken);
  res.status(201).json({ accessToken: result.accessToken, user: result.user });
});

router.post('/login', authLimiter, async (req, res) => {
  const input = parseOrThrow<{ email: string; password: string }>(
    loginSchema,
    req.body,
  );
  const result = await service.loginUser(input.email, input.password);
  setRefreshCookie(res, result.refreshToken);
  res.json({ accessToken: result.accessToken, user: result.user });
});

router.post(
  '/refresh',
  refreshLimiter,
  requireTrustedOrigin,
  async (req, res) => {
    const token = readRefreshCookie(req);
    if (!token) {
      throw new ApiError(401, 'Refresh token missing.');
    }
    const result = await service.refreshSession(token);
    setRefreshCookie(res, result.refreshToken);
    res.json({ accessToken: result.accessToken, user: result.user });
  },
);

router.post('/logout', requireTrustedOrigin, async (req, res) => {
  const token = readRefreshCookie(req) ?? '';
  await service.revokeSession(token);
  clearRefreshCookie(res);
  res.status(204).end();
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await service.getUserById(req.userId as string);
  res.json({ user });
});

export const authRouter = router;
