import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { briefingSchema, itemSchema } from './lib/schemas.ts';

const items = defineCollection({
  loader: glob({ pattern: 'generated/**/*.md', base: './src/content/items' }),
  schema: itemSchema,
});

const briefings = defineCollection({
  loader: glob({ pattern: 'generated/**/*.md', base: './src/content/briefings' }),
  schema: briefingSchema,
});

/**
 * English translations of daily briefings, produced locally by the bot
 * (scripts/dailyinfo-bot.mjs) into runtime/bot-cache/en — gitignored, so the
 * collection is empty on fresh clones and production deploys. The /en/ pages
 * are a local reading aid, NOT part of the publication contract: canonical
 * items/briefings are untouched and no identity rules apply here.
 */
const enBriefings = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './runtime/bot-cache/en' }),
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    category: z.string(),
    title: z.string(),
    generated_at: z.string(),
  }),
});

export const collections = { items, briefings, enBriefings };
