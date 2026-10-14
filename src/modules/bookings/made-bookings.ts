import mongoose from 'mongoose';

/*
 * Bookings that were really made (plan §8.2). A checkout left unpaid, replaced by a new one or timed out ends
 * EXPIRED straight from PAYMENT_PENDING, never requested or confirmed; it isn't a booking. The staff booking
 * lists, the reports and the booking-velocity risk check leave those out.
 */

/** Leaves out checkouts that ended without being paid. Works in find() and in aggregation stages. */
export const notAbandonedCheckout = () => ({
  $nor: [
    {
      status: mongoose.trusted({ $in: ['EXPIRED', 'CANCELLED'] }),
      'statusHistory.status': mongoose.trusted({ $nin: ['PENDING', 'CONFIRMED'] }),
    },
  ],
});

/** Bookings made: neither a checkout still open nor one that ended unpaid. */
export const madeBookingFilter = () => ({
  status: mongoose.trusted({ $ne: 'PAYMENT_PENDING' }),
  ...notAbandonedCheckout(),
});
