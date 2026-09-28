import { Schema, model, type HydratedDocument } from 'mongoose';

/**
 * Admin-editable content by key (plan §3 `cmsBlocks`): homepage hero and sections, featured vehicles,
 * footer links and the legal pages. Legal pages use keys like `legal.terms` with Markdown content and the
 * document's version (plan §6.1: a new version is accepted again).
 */
export interface CmsBlock {
  key: string;
  content: unknown;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The content of a `legal.*` block. */
export interface LegalContent {
  title: string;
  markdown: string;
}

const cmsBlockSchema = new Schema<CmsBlock>(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      match: [/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, 'key uses lowercase words joined by dots or dashes'],
    },
    content: { type: Schema.Types.Mixed, required: true },
    version: { type: String, required: true },
  },
  { collection: 'cmsBlocks', timestamps: true, minimize: false },
);

cmsBlockSchema.index({ key: 1 }, { unique: true });

export const CmsBlockModel = model<CmsBlock>('CmsBlock', cmsBlockSchema);
export type CmsBlockDocument = HydratedDocument<CmsBlock>;
