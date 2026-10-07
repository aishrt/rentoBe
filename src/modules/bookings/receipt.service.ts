import { resolve } from 'node:path';
import mongoose from 'mongoose';
import PDFDocument from 'pdfkit';
import { HttpError } from '../../lib/http-error.js';
import { formatNzDate, formatNzDateTime, formatNzdExact } from '../../lib/format.js';
import { nzTripDays } from '../../lib/nz-time.js';
import { emailTheme } from '../../emails/theme.js';
import { getPlatformSettings } from '../admin/platform-settings.service.js';
import { PaymentModel } from '../payments/payment.model.js';
import { UserModel } from '../users/user.model.js';
import type { BookingDocument } from './booking.model.js';
import type { Viewer } from './booking-view.js';
import type { Receipt } from './bookings.schemas.js';

/*
 * The GST receipt for a paid booking (plan §8.1, item 18; spec §17): a page on the website, and a PDF
 * to download. It shows the booking reference, every line, the GST included, how it was paid and any
 * refunds. GST details follow the client's accountant (plan §16, item 7): the GST number shows once
 * it's set in Platform settings.
 */

const RECEIPT_STATUSES = ['SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED'] as const;

/** GET /bookings/{id}/receipt: the Guest's receipt (staff can open it too; the Host has earnings instead). */
export async function bookingReceipt(booking: BookingDocument, viewer: Viewer): Promise<Receipt> {
  if (viewer === 'HOST') {
    throw new HttpError(
      403,
      'FORBIDDEN',
      "The receipt is the guest's. What you earn from this trip is on your booking page.",
    );
  }
  const payment = await PaymentModel.findOne({
    bookingId: booking._id,
    type: 'BOOKING',
    status: mongoose.trusted({ $in: RECEIPT_STATUSES }),
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!payment) {
    throw new HttpError(409, 'NO_RECEIPT', 'The receipt is ready once the booking is paid for.');
  }
  const [guest, settings] = await Promise.all([
    UserModel.findById(booking.guestId).select('firstName lastName email').lean(),
    getPlatformSettings(),
  ]);
  // Charged when the booking was confirmed: at checkout for Instant Book, or when the Host accepted.
  const paidAt =
    booking.statusHistory.find((change) => change.status === 'CONFIRMED')?.at ?? payment.updatedAt;
  const refunded = payment.refunds
    .filter((refund) => refund.status === 'SUCCEEDED')
    .reduce((sum, refund) => sum + refund.amountCents, 0);

  return {
    ref: booking.ref,
    paidAt: paidAt.toISOString(),
    supplier: {
      name: settings.business.legalName,
      ...(settings.business.gstNumber && { gstNumber: settings.business.gstNumber }),
      email: settings.business.supportEmail,
    },
    customer: {
      name: guest ? `${guest.firstName} ${guest.lastName}`.trim() : 'Former member',
      email: guest?.email ?? '',
    },
    vehicleTitle: booking.vehicleSnapshot.title,
    start: booking.startAt.toISOString(),
    end: booking.endAt.toISOString(),
    days: nzTripDays(booking.startAt, booking.endAt),
    lines: booking.lineItems.map(({ label, amountCents, gstCents }) => ({ label, amountCents, gstCents })),
    totalCents: booking.price.totalCents,
    gstCents: booking.price.gstCents,
    gstRatePct: settings.fees.gstRatePct,
    paidWith: payment.method ?? 'Card',
    refunds: payment.refunds.map((refund) => ({
      amountCents: refund.amountCents,
      status: refund.status,
      at: refund.createdAt.toISOString(),
    })),
    refundedCents: refunded,
    netPaidCents: payment.amountCents - refunded,
  };
}

/** The fonts are Inter, as on the website: unlike PDF's built-in fonts, they have macrons (Māori names). */
const FONT_DIR = resolve('assets/fonts');
const FONTS = {
  regular: resolve(FONT_DIR, 'Inter-Regular.woff'),
  bold: resolve(FONT_DIR, 'Inter-SemiBold.woff'),
};

const { primary, ink, muted, line } = emailTheme.colors;

/** Intl puts narrow no-break spaces in some dates; plain spaces print the same in any font. */
const plain = (text: string) => text.replace(/[\u00A0\u202F]/g, ' ');
const day = (iso: string) => plain(formatNzDate(new Date(iso)));
const moment = (iso: string) => plain(formatNzDateTime(new Date(iso)));

/** The receipt as an A4 PDF (plan §8.1, item 18), laid out like the receipt page. */
export function receiptPdf(receipt: Receipt): Promise<Buffer> {
  return new Promise((done, fail) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: { Title: `Receipt ${receipt.ref}`, Author: receipt.supplier.name, Subject: receipt.vehicleTitle },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => done(Buffer.concat(chunks)));
    doc.on('error', fail);
    doc.registerFont('regular', FONTS.regular);
    doc.registerFont('bold', FONTS.bold);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const amountWidth = 110;

    /** A row with a label on the left and a value, usually an amount, on the right. */
    const row = (
      label: string,
      value: string,
      options: { bold?: boolean; color?: string; valueWidth?: number } = {},
    ) => {
      const y = doc.y;
      const valueWidth = options.valueWidth ?? amountWidth;
      doc
        .font(options.bold ? 'bold' : 'regular')
        .fillColor(options.color ?? ink)
        .text(label, left, y, { width: width - valueWidth - 12 });
      const after = doc.y;
      doc.text(value, left + width - valueWidth, y, { width: valueWidth, align: 'right' });
      doc.y = Math.max(after, doc.y) + 6;
    };
    const rule = () => {
      doc
        .moveTo(left, doc.y)
        .lineTo(left + width, doc.y)
        .lineWidth(0.75)
        .strokeColor(line)
        .stroke();
      doc.y += 10;
    };
    const heading = (text: string) => {
      doc.moveDown(0.6).font('bold').fontSize(9).fillColor(muted).text(text.toUpperCase(), left, doc.y, {
        characterSpacing: 0.8,
      });
      doc.moveDown(0.3).fontSize(10.5).fillColor(ink);
    };

    // Header: the name, and what this is.
    doc.font('bold').fontSize(20).fillColor(primary).text(receipt.supplier.name, left, doc.y);
    doc.moveDown(0.2).font('regular').fontSize(10).fillColor(muted);
    if (receipt.supplier.gstNumber) doc.text(`GST number ${receipt.supplier.gstNumber}`);
    doc.text(receipt.supplier.email);
    doc.font('bold').fontSize(16).fillColor(ink).text('Receipt', left, 56, { width, align: 'right' });
    doc.font('regular').fontSize(10).fillColor(muted).text(receipt.ref, { width, align: 'right' });
    doc.y = Math.max(doc.y, 120);
    doc.moveDown(1);
    rule();

    doc.fontSize(10.5);
    heading('Billed to');
    doc.font('regular').text(receipt.customer.name);
    if (receipt.customer.email) doc.fillColor(muted).text(receipt.customer.email).fillColor(ink);

    heading('Details');
    const detail = { valueWidth: width / 2 };
    row('Receipt number', receipt.ref, detail);
    row('Date paid', day(receipt.paidAt), detail);
    row('Paid with', receipt.paidWith, detail);

    heading('Trip');
    doc.font('bold').text(receipt.vehicleTitle);
    doc
      .font('regular')
      .fillColor(muted)
      .text(
        `${moment(receipt.start)} to ${moment(receipt.end)} (NZ time), ${receipt.days} ${receipt.days === 1 ? 'day' : 'days'}`,
      )
      .fillColor(ink);

    heading('Charges');
    for (const item of receipt.lines) row(item.label, formatNzdExact(item.amountCents));
    rule();
    row('Total (NZD)', formatNzdExact(receipt.totalCents), { bold: true });
    row(`GST included (${receipt.gstRatePct}%)`, formatNzdExact(receipt.gstCents), { color: muted });

    if (receipt.refunds.length > 0) {
      heading('Refunds');
      for (const refund of receipt.refunds) {
        const state =
          refund.status === 'SUCCEEDED' ? '' : refund.status === 'PENDING' ? ' (on its way)' : ' (failed)';
        row(`Refund, ${day(refund.at)}${state}`, formatNzdExact(-refund.amountCents));
      }
      rule();
      row('Paid after refunds (NZD)', formatNzdExact(receipt.netPaidCents), { bold: true });
    }

    doc
      .moveDown(2)
      .font('regular')
      .fontSize(9)
      .fillColor(muted)
      .text(
        'All amounts are in New Zealand dollars and include GST. Times are in NZ time. Keep this receipt for your records.',
        left,
        doc.y,
        { width },
      );
    doc.end();
  });
}
