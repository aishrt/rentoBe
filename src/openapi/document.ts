import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registerAdminListingPaths } from '../modules/admin/admin-listings.openapi.js';
import { registerAdminPaths } from '../modules/admin/admin.openapi.js';
import { registerAuthPaths } from '../modules/auth/auth.openapi.js';
import { registerBookingPaths } from '../modules/bookings/bookings.openapi.js';
import { registerContentPaths } from '../modules/cms/content.openapi.js';
import { registerCurrencyPaths } from '../modules/currency/currency.openapi.js';
import { registerNotificationPaths } from '../modules/notifications/notifications.openapi.js';
import { registerSearchPaths } from '../modules/search/search.openapi.js';
import { registerStaffPaths } from '../modules/staff/staff.openapi.js';
import { registerUserPaths } from '../modules/users/users.openapi.js';
import { registerHostPaths } from '../modules/vehicles/host-vehicles.openapi.js';
import { registerVehiclePaths } from '../modules/vehicles/vehicles.openapi.js';

/**
 * The API contract (plan §2.3), built from the same Zod schemas the routes use. `npm run openapi`
 * writes it to openapi.json; the website and future mobile apps generate their types from that file.
 */
export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    // Written out rather than imported: auth.cookies.ts loads env.ts, which the build script
    // must not need. test/openapi.test.ts checks it matches ACCESS_COOKIE.
    name: 'rv_access',
    description: 'The 15-minute access token, set by the sign-in routes (the website)',
  });
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'The same access token in an Authorization header (mobile apps)',
  });

  registerAuthPaths(registry);
  registerUserPaths(registry);
  registerAdminPaths(registry);
  registerStaffPaths(registry);
  registerCurrencyPaths(registry);
  registerSearchPaths(registry);
  registerVehiclePaths(registry);
  registerContentPaths(registry);
  registerHostPaths(registry);
  registerNotificationPaths(registry);
  registerAdminListingPaths(registry);
  registerBookingPaths(registry);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Rento Vroom API',
      version: '1.0.0',
      description:
        "REST API for the Rento Vroom website and future apps. Every error response is `{ error: { code, message, fields? } }`. Requests that change data from a browser must come from the website's own origin.",
    },
    servers: [
      { url: 'https://api.rentovroom.com/api/v1', description: 'Production' },
      { url: 'http://localhost:4000/api/v1', description: 'Local development' },
    ],
  });
}
