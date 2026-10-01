import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { availabilityQuerySchema, quoteRequestSchema } from './vehicles.schemas.js';
import {
  featuredVehicles,
  getVehicleDetail,
  quoteVehicle,
  vehicleAvailability,
  vehicleReviews,
} from './vehicles.service.js';

/** Mounted at /api/v1/vehicles. Public: listings, their calendars, reviews and quotes (plan §11). */
export function vehiclesRouter() {
  const router = Router();

  router.get('/featured', async (_req, res) => {
    res.json(await featuredVehicles());
  });

  router.get('/:slug', async (req, res) => {
    res.json({ vehicle: await getVehicleDetail(String(req.params.slug)) });
  });

  router.get('/:id/availability', async (req, res) => {
    const { from, to } = validate(availabilityQuerySchema, req.query);
    res.json(await vehicleAvailability(String(req.params.id), from, to));
  });

  router.get('/:id/reviews', async (req, res) => {
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 100);
    res.json(await vehicleReviews(String(req.params.id), page));
  });

  // Checks and prices a trip without holding anything (plan §8.2: nothing is held before sign-in).
  router.post('/:id/quote', async (req, res) => {
    const request = validate(quoteRequestSchema, req.body);
    res.json({ quote: await quoteVehicle(String(req.params.id), request) });
  });

  return router;
}
