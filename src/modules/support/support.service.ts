import mongoose from 'mongoose';
import { enqueue } from '../../jobs/queue.js';
import { randomRef } from '../../lib/refs.js';
import { BookingModel } from '../bookings/booking.model.js';
import { UserModel } from '../users/user.model.js';
import type { ContactRequest } from './support.schemas.js';
import { SupportTicketModel } from './support-ticket.model.js';

/**
 * A message from the Contact Us form becomes a support ticket (plan §9, Days 12–14), and the sender
 * gets an email with its reference. Signed-in users' tickets are linked to their account, and to one
 * of their bookings when they give its reference.
 */
export async function createContactTicket(input: ContactRequest, userId?: string): Promise<{ ref: string }> {
  const user = userId ? await UserModel.findById(userId).select('email firstName').lean() : null;
  const booking =
    user && input.bookingRef
      ? await BookingModel.findOne({
          ref: input.bookingRef,
          $or: [{ guestId: user._id }, { hostId: user._id }],
        })
          .select('_id')
          .lean()
      : null;

  for (let attempt = 0; ; attempt += 1) {
    const ref = randomRef('ST');
    try {
      await SupportTicketModel.create({
        ref,
        ...(user ? { userId: user._id } : {}),
        name: input.name,
        email: input.email,
        ...(booking && { bookingId: booking._id }),
        subject: input.subject,
        category: input.category,
        messages: [
          {
            ...(user && { authorId: user._id }),
            body:
              input.bookingRef && !booking
                ? `${input.message}\n\nBooking reference: ${input.bookingRef}`
                : input.message,
            createdAt: new Date(),
          },
        ],
      });
      await enqueue('email.send', {
        to: input.email,
        template: 'supportTicketReceived',
        props: { name: input.name.split(' ')[0] ?? input.name, ref, subject: input.subject },
      });
      return { ref };
    } catch (error) {
      // Two tickets drew the same reference; draw again.
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000 && attempt < 3) continue;
      throw error;
    }
  }
}
