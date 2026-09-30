import { Router } from 'express';
import { HttpError } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { placeDetails, suggestPlaces } from './places.service.js';
import { searchQuerySchema, suggestQuerySchema } from './search.schemas.js';
import { listMakes, searchVehicles } from './search.service.js';

/** Mounted at /api/v1/search. Public. Availability is never cached (plan §4.1). */
export function searchRouter() {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await searchVehicles(searchQuerySchema.parse(req.query)));
  });

  // The make and model filter's options.
  router.get('/makes', async (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await listMakes());
  });

  return router;
}

/** Mounted at /api/v1/places. Public: the "Where are you going?" field (plan §11). */
export function placesRouter() {
  const router = Router();

  router.get('/suggest', async (req, res) => {
    const { q, sessionToken } = validate(suggestQuerySchema, req.query);
    res.json({ suggestions: await suggestPlaces(q, sessionToken) });
  });

  router.get('/:id', async (req, res) => {
    const sessionToken = typeof req.query.sessionToken === 'string' ? req.query.sessionToken : undefined;
    const place = await placeDetails(String(req.params.id), sessionToken);
    if (!place) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that place.");
    res.json({ place });
  });

  return router;
}
