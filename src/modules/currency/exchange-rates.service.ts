import { enqueue } from '../../jobs/queue.js';
import { nextNzHour, nzDate } from '../../lib/nz-time.js';
import { DISPLAY_CURRENCIES, ExchangeRateModel, type DisplayCurrency } from './exchange-rate.model.js';

/**
 * The European Central Bank's daily reference rates (plan §12.7): free, no key, and they cover NZD
 * and every display currency. Published around 16:00 CET on European working days.
 */
export const ECB_DAILY_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** 6 am in NZ, after the ECB's afternoon publication in Europe. */
const REFRESH_HOUR_NZ = 6;
/** On start-up, rates last fetched longer ago than this are refreshed straight away. */
const STALE_AFTER_MS = 30 * 60 * 60_000;

export interface ParsedRates {
  date: string;
  rates: Record<DisplayCurrency, number>;
}

/** Turns the ECB's euro-based rates file into rates per NZ dollar. */
export function parseEcbRates(xml: string): ParsedRates {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const perEuro = new Map<string, number>([['EUR', 1]]);
  for (const [, currency, rate] of xml.matchAll(
    /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
  )) {
    perEuro.set(currency!, Number(rate));
  }

  const nzdPerEuro = perEuro.get('NZD');
  if (!date || !nzdPerEuro) throw new Error('The ECB rates file has no date or no NZD rate');

  const rates = {} as Record<DisplayCurrency, number>;
  for (const currency of DISPLAY_CURRENCIES) {
    const perEuroRate = perEuro.get(currency);
    if (!perEuroRate) throw new Error(`The ECB rates file has no ${currency} rate`);
    rates[currency] = Number((perEuroRate / nzdPerEuro).toPrecision(6));
  }
  return { date, rates };
}

/** Downloads today's rates and saves them. Safe to repeat: one document per reference date. */
export async function refreshExchangeRates(): Promise<ParsedRates> {
  const response = await fetch(ECB_DAILY_RATES_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`The ECB rates request failed with HTTP ${response.status}`);
  const parsed = parseEcbRates(await response.text());
  await ExchangeRateModel.updateOne(
    { date: parsed.date },
    { $set: { rates: parsed.rates, source: 'ECB', fetchedAt: new Date() } },
    { upsert: true },
  );
  return parsed;
}

/** The most recent rates, or null before the first refresh. */
export function latestExchangeRates() {
  return ExchangeRateModel.findOne().sort({ date: -1 }).lean();
}

/** Queues the next 6 am refresh. The dated key means every instance queues it only once. */
export async function scheduleExchangeRateRefresh(now = new Date()) {
  const runAt = nextNzHour(now, REFRESH_HOUR_NZ);
  await enqueue('daily.exchangeRates', {}, { runAt, uniqueKey: `daily.exchangeRates:${nzDate(runAt)}` });
}

/**
 * Called when the API starts: makes sure the next daily refresh is queued, and refreshes straight
 * away when there are no rates yet or the last ones are old (for example after an outage).
 */
export async function ensureExchangeRateRefresh(now = new Date()) {
  await scheduleExchangeRateRefresh(now);
  const latest = await ExchangeRateModel.findOne().sort({ fetchedAt: -1 }).select('fetchedAt').lean();
  if (!latest || now.getTime() - latest.fetchedAt.getTime() > STALE_AFTER_MS) {
    await enqueue(
      'daily.exchangeRates',
      {},
      { runAt: now, uniqueKey: `daily.exchangeRates:catch-up:${nzDate(now)}` },
    );
  }
}
