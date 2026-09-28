import { Schema, model, type HydratedDocument } from 'mongoose';
import { AUDIENCES, type Audience } from './help-article.model.js';

/** A question on the FAQs page (plan §3 `faqs`). `showOnHome` puts it in the homepage FAQ section. */
export interface Faq {
  question: string;
  answer: string;
  category: string;
  audience: Audience;
  showOnHome: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const faqSchema = new Schema<Faq>(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true },
    category: { type: String, required: true, trim: true },
    audience: { type: String, enum: AUDIENCES, default: 'ALL' },
    showOnHome: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const FaqModel = model<Faq>('Faq', faqSchema);
export type FaqDocument = HydratedDocument<Faq>;
