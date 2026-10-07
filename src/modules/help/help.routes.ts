import { Router } from 'express';
import { HttpError } from '../../lib/http-error.js';
import { memo } from '../../lib/memo.js';
import { validate } from '../../lib/validate.js';
import { HelpArticleModel, type HelpArticle } from './help-article.model.js';
import { helpArticlesQuerySchema, type HelpArticleSummary } from './help.schemas.js';

/*
 * The help centre (spec §8, help and support): help articles for Guests and Hosts, written in
 * Markdown and published by admins. Public, and cached for 60 s per task (plan §4.1).
 */

const CACHE_MS = 60_000;
const SUMMARY_LENGTH = 180;

/** The article's first paragraph as plain text, shortened at a word, for the help centre's list. */
export function articleSummary(markdown: string): string {
  const paragraph =
    markdown
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith('#')) ?? '';
  const text = paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= SUMMARY_LENGTH) return text;
  const cut = text.slice(0, SUMMARY_LENGTH);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.]$/, '')}…`;
}

const toSummary = (article: HelpArticle): HelpArticleSummary => ({
  slug: article.slug,
  title: article.title,
  category: article.category,
  audience: article.audience,
  summary: articleSummary(article.body),
});

/** Mounted at /api/v1/help. */
export function helpRouter() {
  const router = Router();

  router.get('/articles', async (req, res) => {
    const { audience } = validate(helpArticlesQuerySchema, req.query);
    const articles = await memo('help:articles', CACHE_MS, () =>
      HelpArticleModel.find({ published: true }).sort({ order: 1, title: 1 }).lean(),
    );
    res.set('Cache-Control', 'public, max-age=60').json({
      articles: articles
        .filter((article) => !audience || article.audience === audience || article.audience === 'ALL')
        .map(toSummary),
    });
  });

  router.get('/articles/:slug', async (req, res) => {
    const article = await HelpArticleModel.findOne({
      slug: String(req.params.slug).toLowerCase(),
      published: true,
    }).lean();
    if (!article) throw new HttpError(404, 'NOT_FOUND', "We couldn't find that help article.");
    res.set('Cache-Control', 'public, max-age=60').json({
      article: {
        slug: article.slug,
        title: article.title,
        category: article.category,
        audience: article.audience,
        body: article.body,
        updatedAt: article.updatedAt.toISOString(),
      },
    });
  });

  return router;
}
