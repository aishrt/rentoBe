import { z } from 'zod';
import { AUDIENCES } from './help-article.model.js';

/** Articles for Guests or Hosts, with the ones for everyone; all of them without an audience. */
export const helpArticlesQuerySchema = z.object({
  audience: z.enum(['GUEST', 'HOST']).optional().catch(undefined),
});

export const helpArticleSummarySchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    category: z.string(),
    audience: z.enum(AUDIENCES),
    summary: z.string().meta({ description: 'The opening sentence or two, as plain text' }),
  })
  .meta({ id: 'HelpArticleSummary' });
export type HelpArticleSummary = z.infer<typeof helpArticleSummarySchema>;

export const helpArticlesResponseSchema = z
  .object({ articles: z.array(helpArticleSummarySchema).meta({ description: 'In the order admins set' }) })
  .meta({ id: 'HelpArticles' });

export const helpArticleSchema = helpArticleSummarySchema
  .omit({ summary: true })
  .extend({ body: z.string().meta({ description: 'Markdown' }), updatedAt: z.iso.datetime() })
  .meta({ id: 'HelpArticle' });

export const helpArticleResponseSchema = z
  .object({ article: helpArticleSchema })
  .meta({ id: 'HelpArticleResponse' });
