import { Router } from 'express';
import { HttpError } from '../../lib/http-error.js';
import { addNzDays } from '../../lib/nz-time.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { maintenanceInputSchema } from '../hosts/host-reminders.schemas.js';
import { getMaintenance, hostTodo, saveMaintenance } from '../hosts/host-reminders.service.js';
import {
  blockInputSchema,
  documentAttachSchema,
  photoAttachSchema,
  recurringRulesInputSchema,
  vehiclePatchSchema,
} from './host-vehicles.schemas.js';
import {
  attachDocument,
  attachPhoto,
  blockDates,
  createDraft,
  deleteDraft,
  getHostVehicle,
  hostCalendar,
  listHostVehicles,
  ownVehicle,
  parseCalendarTime,
  patchVehicle,
  removeDocument,
  removePhoto,
  setRecurringRules,
  setVehicleActive,
  submitVehicle,
  unblockDates,
} from './host-vehicles.service.js';

const MAX_CALENDAR_DAYS = 400;

/**
 * Mounted at /api/v1/host: My Vehicles, onboarding and the calendar (plan §11). Each route checks the
 * car belongs to the signed-in Host; the Host application is checked in the service, from the
 * database rather than the access token, so a Host can start straight after applying.
 */
export function hostRouter() {
  const router = Router();
  router.use(requireAuth);
  const id = (params: Record<string, unknown>) => String(params.id);

  router.get('/vehicles', async (req, res) => {
    res.json({ vehicles: await listHostVehicles(req.auth!.userId) });
  });

  router.post('/vehicles', async (req, res) => {
    res.status(201).json({ vehicle: await createDraft(req.auth!.userId) });
  });

  router.get('/vehicles/:id', async (req, res) => {
    res.json({ vehicle: await getHostVehicle(req.auth!.userId, id(req.params)) });
  });

  router.patch('/vehicles/:id', async (req, res) => {
    const patch = validate(vehiclePatchSchema, req.body);
    res.json({ vehicle: await patchVehicle(req.auth!.userId, id(req.params), patch, req.ip) });
  });

  router.delete('/vehicles/:id', async (req, res) => {
    await deleteDraft(req.auth!.userId, id(req.params));
    res.status(204).end();
  });

  router.post('/vehicles/:id/photos', async (req, res) => {
    const input = validate(photoAttachSchema, req.body);
    res.status(201).json({ vehicle: await attachPhoto(req.auth!.userId, id(req.params), input) });
  });

  router.delete('/vehicles/:id/photos/:photoId', async (req, res) => {
    res.json({ vehicle: await removePhoto(req.auth!.userId, id(req.params), String(req.params.photoId)) });
  });

  router.post('/vehicles/:id/documents', async (req, res) => {
    const input = validate(documentAttachSchema, req.body);
    res.status(201).json({ vehicle: await attachDocument(req.auth!.userId, id(req.params), input) });
  });

  router.delete('/vehicles/:id/documents/:documentId', async (req, res) => {
    res.json({
      vehicle: await removeDocument(req.auth!.userId, id(req.params), String(req.params.documentId)),
    });
  });

  router.post('/vehicles/:id/submit', async (req, res) => {
    res.json({ vehicle: await submitVehicle(req.auth!.userId, id(req.params), req.ip) });
  });

  router.post('/vehicles/:id/activate', async (req, res) => {
    res.json({ vehicle: await setVehicleActive(req.auth!.userId, id(req.params), true) });
  });

  router.post('/vehicles/:id/deactivate', async (req, res) => {
    res.json({ vehicle: await setVehicleActive(req.auth!.userId, id(req.params), false) });
  });

  router.get('/vehicles/:id/calendar', async (req, res) => {
    const vehicle = await ownVehicle(req.auth!.userId, id(req.params));
    const from = (typeof req.query.from === 'string' && parseCalendarTime(req.query.from)) || new Date();
    const requestedTo = typeof req.query.to === 'string' ? parseCalendarTime(req.query.to) : null;
    const to =
      requestedTo && requestedTo > from && requestedTo <= addNzDays(from, MAX_CALENDAR_DAYS)
        ? requestedTo
        : addNzDays(from, 62);
    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      blocks: await hostCalendar(vehicle._id, from, to),
      rules: { minNoticeHours: vehicle.rules.minNoticeHours, bufferHours: vehicle.rules.bufferHours },
    });
  });

  router.post('/vehicles/:id/blocks', async (req, res) => {
    const vehicle = await ownVehicle(req.auth!.userId, id(req.params));
    if (vehicle.status === 'SUSPENDED') throw new HttpError(409, 'NOT_EDITABLE', 'This car is suspended.');
    const input = validate(blockInputSchema, req.body);
    res.status(201).json({ block: await blockDates(vehicle._id, input, req.auth!.userId, 'HOST_BLOCK') });
  });

  router.delete('/vehicles/:id/blocks/:blockId', async (req, res) => {
    const vehicle = await ownVehicle(req.auth!.userId, id(req.params));
    await unblockDates(vehicle._id, String(req.params.blockId), ['HOST_BLOCK']);
    res.status(204).end();
  });

  // The to-do list on the Host's dashboard (spec §9).
  router.get('/todo', async (req, res) => {
    res.json({ items: await hostTodo(req.auth!.userId) });
  });

  // Maintenance reminders the Host sets for a car (plan §3 vehicles.maintenanceReminders).
  router.get('/vehicles/:id/maintenance-reminders', async (req, res) => {
    const vehicle = await ownVehicle(req.auth!.userId, String(req.params.id));
    res.json(await getMaintenance(vehicle.toObject()));
  });

  router.put('/vehicles/:id/maintenance-reminders', async (req, res) => {
    const input = validate(maintenanceInputSchema, req.body);
    const vehicle = await ownVehicle(req.auth!.userId, String(req.params.id));
    res.json(await saveMaintenance(vehicle._id, input));
  });

  router.put('/vehicles/:id/recurring-rules', async (req, res) => {
    const { rules } = validate(recurringRulesInputSchema, req.body);
    res.json(await setRecurringRules(req.auth!.userId, id(req.params), rules));
  });

  return router;
}
