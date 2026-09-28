import { Schema, model, type HydratedDocument } from 'mongoose';

export const AUDIENCES = ['GUEST', 'HOST', 'ALL'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** A help centre article (plan §3 `helpArticles`), written in Markdown and managed by admins. */
export interface HelpArticle {
  slug: string;
  title: string;
  body: string;
  category: string;
  audience: Audience;
  published: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const helpArticleSchema = new Schema<HelpArticle>(
  {
    slug: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug uses lowercase letters, numbers and dashes'],
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    category: { type: String, required: true, trim: true },
    audience: { type: String, enum: AUDIENCES, default: 'ALL' },
    published: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { collection: 'helpArticles', timestamps: true },
);

helpArticleSchema.index({ slug: 1 }, { unique: true });

export const HelpArticleModel = model<HelpArticle>('HelpArticle', helpArticleSchema);
export type HelpArticleDocument = HydratedDocument<HelpArticle>;
