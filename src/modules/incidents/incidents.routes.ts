import { Router, type Request } from 'express';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { incidentReplySchema, newIncidentSchema } from './incidents.schemas.js';
import { getIncident, listMyIncidents, replyToIncident, reportIncident } from './incidents.service.js';

const actor = (req: Request) => ({ userId: req.auth!.userId, roles: req.auth!.roles });

/** Mounted at /api/v1/incidents: reporting and following a case (spec §15). */
export function incidentsRouter() {
  const router = Router();
  router.use(requireAuth);

  router.post('/', async (req, res) => {
    const input = validate(newIncidentSchema, req.body);
    res.status(201).json({ incident: await reportIncident(actor(req), input) });
  });

  router.get('/', async (req, res) => {
    res.json({ incidents: await listMyIncidents(req.auth!.userId) });
  });

  router.get('/:ref', async (req, res) => {
    res.json({ incident: await getIncident(actor(req), String(req.params.ref)) });
  });

  router.post('/:ref/events', async (req, res) => {
    const input = validate(incidentReplySchema, req.body);
    res.status(201).json({ incident: await replyToIncident(actor(req), String(req.params.ref), input) });
  });

  return router;
}
