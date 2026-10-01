import { Router, type RequestHandler } from 'express';
import { HttpError } from '../../lib/http-error.js';
import { validate } from '../../lib/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { bookingCreateRateLimit } from '../../middleware/rate-limit.js';
import { preparePayment, syncBookingPayment } from './booking-payments.js';
import {
  acceptBooking,
  bookingView,
  cancelBooking,
  cancellationPreview,
  createBooking,
  declineBooking,
  findBookingFor,
  listBookings,
} from './booking.service.js';
import {
  bookingsQuerySchema,
  cancelBookingSchema,
  createBookingSchema,
  declineBookingSchema,
  preparePaymentSchema,
} from './bookings.schemas.js';

/** Mounted at /api/v1/bookings (plan §11): the booking flow, trips and the Host's answers. */
export function bookingsRouter(options: { rateLimit: boolean } = { rateLimit: true }) {
  const router = Router();
  const limit = (make: () => RequestHandler) => (options.rateLimit ? [make()] : []);
  router.use(requireAuth);
  const actor = (req: Parameters<RequestHandler>[0]) => ({
    userId: req.auth!.userId,
    roles: req.auth!.roles,
  });

  // Creates the booking and holds its dates for 30 minutes while the Guest pays (plan §8.2).
  router.post('/', ...limit(bookingCreateRateLimit), async (req, res) => {
    const input = validate(createBookingSchema, req.body);
    const booking = await createBooking(req.auth!.userId, input);
    res.status(201).json({ booking: await bookingView(booking, 'GUEST') });
  });

  router.get('/', async (req, res) => {
    const { role, group } = validate(bookingsQuerySchema, req.query);
    res.json({ bookings: await listBookings(req.auth!.userId, role, group) });
  });

  router.get('/:id', async (req, res) => {
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    res.json({ booking: await bookingView(booking, viewer) });
  });

  // The payment step: the Guest Agreement, then Stripe's PaymentIntent and saved cards (plan §8.1).
  router.post('/:id/payment', async (req, res) => {
    validate(preparePaymentSchema, req.body);
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    if (viewer !== 'GUEST') throw new HttpError(403, 'FORBIDDEN', 'Only the guest can pay for a booking.');
    res.json(await preparePayment(req.auth!.userId, booking, req.ip));
  });

  // After Stripe.js confirms: apply the result now rather than wait for the webhook.
  router.post('/:id/payment/sync', async (req, res) => {
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    if (viewer !== 'GUEST') throw new HttpError(403, 'FORBIDDEN', 'Only the guest can pay for a booking.');
    await syncBookingPayment(booking);
    const { booking: fresh } = await findBookingFor(actor(req), booking.id);
    res.json({ booking: await bookingView(fresh, 'GUEST') });
  });

  router.get('/:id/cancellation-preview', async (req, res) => {
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    res.json(await cancellationPreview(booking, viewer));
  });

  // Cancels, or withdraws a request that's waiting for the Host (plan §8.2).
  router.post('/:id/cancel', async (req, res) => {
    const { reason } = validate(cancelBookingSchema, req.body ?? {});
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    if (viewer === 'STAFF')
      throw new HttpError(403, 'FORBIDDEN', 'Staff cancel bookings from the staff portal.');
    const cancelled = await cancelBooking(booking, viewer, req.auth!.userId, reason);
    res.json({ booking: await bookingView(cancelled, viewer) });
  });

  router.post('/:id/accept', async (req, res) => {
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    if (viewer !== 'HOST') throw new HttpError(403, 'FORBIDDEN', 'Only the host can accept a request.');
    const accepted = await acceptBooking(booking, req.auth!.userId);
    res.json({ booking: await bookingView(accepted, 'HOST') });
  });

  router.post('/:id/decline', async (req, res) => {
    const { reason } = validate(declineBookingSchema, req.body ?? {});
    const { booking, viewer } = await findBookingFor(actor(req), String(req.params.id));
    if (viewer !== 'HOST') throw new HttpError(403, 'FORBIDDEN', 'Only the host can decline a request.');
    const declined = await declineBooking(booking, req.auth!.userId, reason);
    res.json({ booking: await bookingView(declined, 'HOST') });
  });

  return router;
}
