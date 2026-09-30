import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { isDbConnected } from './db.js';
import { env } from './env.js';
import { logger } from './integrations/logger.js';
import { isShuttingDown } from './lib/lifecycle.js';
import { errorHandler, notFound } from './middleware/error-handler.js';
import { requireTrustedOrigin } from './middleware/trusted-origin.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import {
  cmsRouter,
  destinationsRouter,
  faqsRouter,
  policiesRouter,
  reviewsRouter,
} from './modules/cms/content.routes.js';
import { currencyRouter } from './modules/currency/currency.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { stripeWebhookRouter } from './modules/payments/stripe-webhook.js';
import { placesRouter, searchRouter } from './modules/search/search.routes.js';
import { supportRouter } from './modules/support/support.routes.js';
import { filesRouter, uploadsRouter } from './modules/uploads/uploads.routes.js';
import { meRouter } from './modules/users/users.routes.js';
import { hostRouter } from './modules/vehicles/host-vehicles.routes.js';
import { vehiclesRouter } from './modules/vehicles/vehicles.routes.js';
import { pagesRouter } from './pages/pages.routes.js';

export interface AppOptions {
  /** Turned off in tests so repeated sign-ins don't hit the per-IP limit. */
  rateLimit?: boolean;
}

export function createApp({ rateLimit = true }: AppOptions = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
  // Website pages with their own security headers, ahead of the API's (plan §1.4).
  app.use('/pages', pagesRouter());
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_ORIGINS, credentials: true }));
  // Stripe calls this from its servers, not a browser, and signs the raw body (plan §8.1), so it
  // comes before the JSON parser and the website-origin check.
  app.use('/api/v1/payments/webhook', stripeWebhookRouter());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Used by the load balancer, ECS and uptime checks (plan §13.4).
  app.get('/healthz', (_req, res) => {
    const healthy = isDbConnected() && !isShuttingDown();
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable' });
  });

  const api = Router();
  api.use((_req, res, next) => {
    // Nothing under /api/v1 is cacheable yet; public cacheable routes will opt in (plan §13.4).
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  api.use(requireTrustedOrigin);
  api.use('/auth', authRouter({ rateLimit }));
  api.use('/me', meRouter({ rateLimit }));
  api.use('/admin', adminRouter());
  api.use('/exchange-rates', currencyRouter());
  api.use('/search', searchRouter());
  api.use('/places', placesRouter());
  api.use('/vehicles', vehiclesRouter());
  api.use('/destinations', destinationsRouter());
  api.use('/cms', cmsRouter());
  api.use('/faqs', faqsRouter());
  api.use('/policies', policiesRouter());
  api.use('/reviews', reviewsRouter());
  api.use('/support', supportRouter({ rateLimit }));
  api.use('/uploads', uploadsRouter());
  api.use('/files', filesRouter());
  api.use('/notifications', notificationsRouter());
  api.use('/host', hostRouter());

  app.use('/api/v1', api);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
