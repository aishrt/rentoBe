import { Router } from 'express';
import { HttpError } from '../../lib/http-error.js';
import type { ExchangeRatesResponse } from './currency.schemas.js';
import { latestExchangeRates } from './exchange-rates.service.js';

/** Mounted at /api/v1/exchange-rates. Public: the website shows approximate prices to every visitor. */
export function currencyRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    const latest = await latestExchangeRates();
    if (!latest) {
      throw new HttpError(503, 'RATES_UNAVAILABLE', "Prices in other currencies aren't available right now.");
    }
    const body: ExchangeRatesResponse = {
      base: 'NZD',
      date: latest.date,
      source: 'European Central Bank',
      rates: latest.rates,
    };
    // The rates change once a day, so browsers can reuse them for an hour.
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(body);
  });

  return router;
}
