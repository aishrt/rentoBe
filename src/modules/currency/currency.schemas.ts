import { z } from 'zod';

const rate = z.number().positive();

/** The latest exchange rates, for approximate prices in other currencies (plan §12.7). */
export const exchangeRatesSchema = z
  .object({
    base: z.literal('NZD'),
    date: z.iso
      .date()
      .meta({ description: 'The day the rates are for; the ECB publishes on European working days' }),
    source: z.string().meta({ description: 'Who published the rates' }),
    rates: z
      .object({ AUD: rate, USD: rate, EUR: rate, CAD: rate })
      .meta({ description: 'How much of each currency NZ$1 buys' }),
  })
  .meta({ id: 'ExchangeRates' });

export type ExchangeRatesResponse = z.infer<typeof exchangeRatesSchema>;
