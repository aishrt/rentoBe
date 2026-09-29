import {
  refreshExchangeRates,
  scheduleExchangeRateRefresh,
} from '../../modules/currency/exchange-rates.service.js';
import type { JobContext } from './index.js';

/**
 * `daily.exchangeRates` (plan §4.3, §12.7): stores the ECB's rates for the approximate prices in
 * AUD, USD, EUR and CAD. Tomorrow's run is queued first, so a day that fails doesn't stop the next.
 */
export async function refreshExchangeRatesJob(_payload: Record<string, never>, { log }: JobContext) {
  await scheduleExchangeRateRefresh();
  const { date } = await refreshExchangeRates();
  log.info({ date }, 'Exchange rates updated');
}
