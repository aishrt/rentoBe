import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { errorResponses, jsonResponse } from '../../openapi/shared.js';
import { exchangeRatesSchema } from './currency.schemas.js';

/** The contract for currency.routes.ts (plan §2.3). */
export function registerCurrencyPaths(registry: OpenAPIRegistry) {
  registry.registerPath({
    method: 'get',
    path: '/exchange-rates',
    tags: ['Currency'],
    summary: 'Exchange rates for approximate prices in AUD, USD, EUR and CAD',
    description:
      'Public. Updated daily from the European Central Bank. For display only: every charge, refund and payout is in NZD, and the card issuer converts.',
    responses: {
      200: jsonResponse('The latest rates, per NZ$1', exchangeRatesSchema),
      ...errorResponses(503),
    },
  });
}
