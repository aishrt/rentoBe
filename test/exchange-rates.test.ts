import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshExchangeRatesJob } from '../src/jobs/handlers/exchange-rates.js';
import { JobModel } from '../src/jobs/job.model.js';
import { logger } from '../src/integrations/logger.js';
import { nextNzHour, nzDate } from '../src/lib/nz-time.js';
import { exchangeRatesSchema } from '../src/modules/currency/currency.schemas.js';
import { ExchangeRateModel } from '../src/modules/currency/exchange-rate.model.js';
import {
  ECB_DAILY_RATES_URL,
  ensureExchangeRateRefresh,
  parseEcbRates,
  refreshExchangeRates,
} from '../src/modules/currency/exchange-rates.service.js';
import { testApp } from './helpers.js';

/** The shape of the ECB's daily file, trimmed. NZ$1 = €0.50 makes the expected rates easy to check. */
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-09-28'>
      <Cube currency='USD' rate='1.1700'/>
      <Cube currency='JPY' rate='171.30'/>
      <Cube currency='GBP' rate='0.8712'/>
      <Cube currency='AUD' rate='1.7800'/>
      <Cube currency='CAD' rate='1.6200'/>
      <Cube currency='NZD' rate='2.0000'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const RATES = { AUD: 0.89, USD: 0.585, EUR: 0.5, CAD: 0.81 };

function stubEcb(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NZ time for daily jobs', () => {
  it('finds the next 6 am on NZ clocks, across daylight saving changes', () => {
    // 1 pm NZDT on 29 Sept 2026 → 6 am the next morning.
    expect(nextNzHour(new Date('2026-09-29T00:00:00Z'), 6).toISOString()).toBe('2026-09-29T17:00:00.000Z');
    // 5:59 am NZST in June → a minute later.
    expect(nextNzHour(new Date('2026-06-15T17:59:00Z'), 6).toISOString()).toBe('2026-06-15T18:00:00.000Z');
    // Exactly 6 am → tomorrow's.
    expect(nextNzHour(new Date('2026-06-15T18:00:00Z'), 6).toISOString()).toBe('2026-06-16T18:00:00.000Z');
    // Midnight before daylight saving starts (27 Sept 2026, 2 am → 3 am): 6 am NZDT.
    expect(nextNzHour(new Date('2026-09-26T12:00:00Z'), 6).toISOString()).toBe('2026-09-26T17:00:00.000Z');
    // 1 am before it ends (4 April 2027, 3 am → 2 am): 6 am NZST.
    expect(nextNzHour(new Date('2027-04-03T12:00:00Z'), 6).toISOString()).toBe('2027-04-03T18:00:00.000Z');
  });

  it('gives the NZ calendar date', () => {
    expect(nzDate(new Date('2026-09-29T11:30:00Z'))).toBe('2026-09-30');
    expect(nzDate(new Date('2026-06-15T11:30:00Z'))).toBe('2026-06-15');
  });
});

describe('Exchange rates', () => {
  it('turns the ECB euro rates into rates per NZ dollar', () => {
    expect(parseEcbRates(ECB_XML)).toEqual({ date: '2026-09-28', rates: RATES });
    expect(() => parseEcbRates(ECB_XML.replace(/<Cube currency='NZD'[^>]+>/, ''))).toThrow(/NZD/);
    expect(() => parseEcbRates(ECB_XML.replace(/<Cube currency='CAD'[^>]+>/, ''))).toThrow(/CAD/);
  });

  it('serves the latest rates once they have been fetched', async () => {
    const empty = await request(testApp()).get('/api/v1/exchange-rates');
    expect(empty.status).toBe(503);
    expect(empty.body.error.code).toBe('RATES_UNAVAILABLE');

    const fetchMock = stubEcb(() => new Response(ECB_XML));
    await refreshExchangeRates();
    // The same day again updates rather than adds.
    await refreshExchangeRates();
    expect(fetchMock).toHaveBeenCalledWith(ECB_DAILY_RATES_URL, expect.anything());
    expect(await ExchangeRateModel.countDocuments()).toBe(1);

    const response = await request(testApp()).get('/api/v1/exchange-rates');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
    expect(exchangeRatesSchema.parse(response.body)).toEqual({
      base: 'NZD',
      date: '2026-09-28',
      source: 'European Central Bank',
      rates: RATES,
    });
  });

  it('queues the daily refresh once, and a catch-up when there are no recent rates', async () => {
    const now = new Date('2026-09-29T00:00:00Z');
    await ensureExchangeRateRefresh(now);
    await ensureExchangeRateRefresh(now);

    const jobs = await JobModel.find().sort({ runAt: 1 }).lean();
    expect(jobs.map(({ uniqueKey, runAt }) => ({ uniqueKey, runAt: runAt.toISOString() }))).toEqual([
      { uniqueKey: 'daily.exchangeRates:catch-up:2026-09-29', runAt: '2026-09-29T00:00:00.000Z' },
      { uniqueKey: 'daily.exchangeRates:2026-09-30', runAt: '2026-09-29T17:00:00.000Z' },
    ]);

    await JobModel.deleteMany({});
    await ExchangeRateModel.create({ date: '2026-09-28', rates: RATES, source: 'ECB', fetchedAt: now });
    await ensureExchangeRateRefresh(now);
    expect(await JobModel.countDocuments()).toBe(1);
  });

  it("queues tomorrow's run even when today's download fails", async () => {
    stubEcb(() => new Response('Service unavailable', { status: 503 }));
    const context = { job: {} as never, log: logger };

    await expect(refreshExchangeRatesJob({}, context)).rejects.toThrow(/HTTP 503/);
    const next = await JobModel.findOne({ type: 'daily.exchangeRates' }).lean();
    expect(next?.uniqueKey).toMatch(/^daily\.exchangeRates:\d{4}-\d{2}-\d{2}$/);
    expect(next!.runAt.getTime()).toBeGreaterThan(Date.now());
  });
});
