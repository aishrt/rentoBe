import mongoose, { type ClientSession, type Types } from 'mongoose';
import { PaymentModel, type PaymentDocument, type PaymentStatus } from './payment.model.js';

/*
 * Which of a booking's payments is its own (plan §8.1). Usually there's one; a second can exist when the Guest
 * paid again before the first was applied, and is given back. Refunds, releases, receipts and the booking's
 * views all work from the one that made the booking.
 */

/** Paid or authorised first; then fully refunded; then ones that never took money. */
const RANK: Partial<Record<PaymentStatus, number>> = {
  SUCCEEDED: 0,
  PARTIALLY_REFUNDED: 0,
  AUTHORISED: 0,
  REFUNDED: 1,
};

/**
 * The booking's payment: the one that made it (recorded when it was authorised or confirmed), or, for a
 * booking from before that was recorded or one still at checkout, the best of its payments: one that went
 * through or is authorised before one pending, failed or cancelled, the newest within each.
 */
export async function bookingPayment(
  booking: { _id: Types.ObjectId; bookingPaymentId?: Types.ObjectId },
  session?: ClientSession,
): Promise<PaymentDocument | null> {
  if (booking.bookingPaymentId) {
    const made = await PaymentModel.findById(booking.bookingPaymentId).session(session ?? null);
    if (made) return made;
  }
  const payments = await PaymentModel.find({ bookingId: booking._id, type: 'BOOKING' })
    .sort({ createdAt: -1 })
    .session(session ?? null);
  // A stable sort keeps the newest first within each rank.
  return payments.sort((a, b) => (RANK[a.status] ?? 2) - (RANK[b.status] ?? 2))[0] ?? null;
}

/** The booking's other payments still live at Stripe (pending or authorised): released when it ends. */
export function otherLivePayments(
  booking: { _id: Types.ObjectId },
  payment: PaymentDocument | null,
  session?: ClientSession,
) {
  return PaymentModel.find({
    bookingId: booking._id,
    type: 'BOOKING',
    ...(payment && { _id: mongoose.trusted({ $ne: payment._id }) }),
    status: mongoose.trusted({ $in: ['PENDING', 'AUTHORISED'] }),
  }).session(session ?? null);
}
