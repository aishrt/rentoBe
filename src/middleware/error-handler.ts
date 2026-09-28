import type { ErrorRequestHandler, RequestHandler } from 'express';
import { reportError } from '../integrations/sentry.js';
import { HttpError } from '../lib/http-error.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) },
    });
    return;
  }

  // Malformed JSON bodies and oversized payloads from express.json().
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: { code: 'BAD_REQUEST', message: 'The request could not be read.' } });
    return;
  }

  req.log?.error({ err }, 'Unhandled error');
  reportError(err, {
    tags: { route: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}` },
    ...(req.auth && { extra: { userId: req.auth.userId } }),
  });
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' },
  });
};
