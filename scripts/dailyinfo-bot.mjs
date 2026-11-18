#!/usr/bin/env node
/**
 * DailyInfo Bot â€” English translation + Q&A over the publication corpus.
 *
 *   npm run bot                          interactive session
 *   npm run bot -- translate [date]      English rendering of a day's briefings
 *   npm run bot -- ask "question"        search the corpus, answer in English
 *   npm run bot -- search "keywords"     raw search (no LLM, works offline)
 *   npm run bot -- dates                 list dates that have briefings
 *
 * Requires an LLM key for translate/ask:
 *   OPENROUTER_API_KEY  â€” https://openrouter.ai (free tier models supported)
 *   GLM_API_KEY         â€” https://open.bigmodel.cn (glm-4-flash is free)
 * OPENROUTER_API_KEY wins when both are set.
 * Optional: BOT_MODEL (default: a free OpenRouter model, or glm-4-flash for
 * Zhipu), BOT_FALLBACK_MODELS (comma-separated chain tried in order when the
 * primary model fails â€” default includes Ling 3.2 Flash free), BOT_BASE_URL
 * (endpoint override, e.g. for testing).
 *
 * Translations are cached under runtime/bot-cache/ (gitignored) as markdown
 * files with a small frontmatter header (date/category/title/generated_at).
 * The Astro build picks them up as the `en_briefings` collection and renders
 * them at /en/ â€” locally. On deploys the cache is absent, so /en/ is simply
 * empty and the canonical publication contract stays untouched.
 */
import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const itemsDir = join(repo, 'src/content/items/generated');
const briefingsDir = join(repo, 'src/content/briefings/generated');
const cacheDir = join(repo, 'runtime/bot-cache/en');

/** Minimal .env loader (repo root); real environment variables always win. */
function loadDotEnv() {
  const path = join(repo, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GLM_API_KEY = process.env.GLM_API_KEY || '';
// Precedence: Gemini (largest free tier) > OpenRouter > Zhipu. All three use
// OpenAI-compatible chat completions; only defaults differ.
const PROVIDER = GEMINI_API_KEY ? 'gemini' : OPENROUTER_API_KEY ? 'openrouter' : GLM_API_KEY ? 'glm' : '';
const PROVIDER_KEY = { gemini: GEMINI_API_KEY, openrouter: OPENROUTER_API_KEY, glm: GLM_API_KEY };
const PROVIDER_BASE = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
};
const PROVIDER_MODEL = {
  // flash-latest aliases sometimes sit at 503 under load; concrete lite/flash
  // models respond faster and translate Chinese well.
  gemini: 'gemini-3.1-flash-lite',
  openrouter: 'baidu/ernie-5.5-flash-preview:free',
  glm: 'glm-4-flash',
};
const PROVIDER_FALLBACK = {
  gemini: 'gemini-3.5-flash,gemini-flash-latest',
  openrouter: 'inclusionai/ling-3.2-flash:free',
  glm: '',
};
const API_KEY = PROVIDER_KEY[PROVIDER] ?? '';
const BASE_URL = (process.env.BOT_BASE_URL || PROVIDER_BASE[PROVIDER] || '').replace(/\/+$/, '');
const PRIMARY_MODEL = process.env.BOT_MODEL || PROVIDER_MODEL[PROVIDER] || '';
// Failover chain: tried in order when the primary model fails (model gone,
// upstream errors, reasoning models that return nothing, or a Gemini region
// block). After the primary provider's models, the OTHER configured providers
// are appended as last-resort â€” one provider going down never kills a job.
const FALLBACK_MODELS = (
  process.env.BOT_FALLBACK_MODELS ?? (PROVIDER_FALLBACK[PROVIDER] || '')
).split(',').map((model) => model.trim()).filter(Boolean);

function providerEntry(provider, model) {
  return {
    provider,
    model,
    baseUrl: PROVIDER_BASE[provider],
    apiKey: PROVIDER_KEY[provider] || '',
    headers: provider === 'openrouter'
      ? { 'HTTP-Referer': 'https://github.com/Adnandut/dailyinfo-web', 'X-Title': 'DailyInfo Bot' }
      : {},
  };
}

function buildModelChain() {
  const chain = [PRIMARY_MODEL, ...FALLBACK_MODELS]
    .filter(Boolean)
    .map((model) => providerEntry(PROVIDER, model));
  for (const provider of ['gemini', 'openrouter', 'glm']) {
    if (provider !== PROVIDER && PROVIDER_KEY[provider]) {
      chain.push(providerEntry(provider, PROVIDER_MODEL[provider]));
    }
  }
  return chain;
}
const MODEL_CHAIN = buildModelChain();

const missingKeyMessage =
  'No LLM API key is set. Set one of (in .env or environment):\n' +
  '  GEMINI_API_KEY      â€” https://aistudio.google.com/apikey  (largest free tier, recommended)\n' +
  '  OPENROUTER_API_KEY  â€” https://openrouter.ai/keys          (free models, 50 req/day)\n' +
  '  GLM_API_KEY         â€” https://open.bigmodel.cn            (glm-4-flash is free)';

const ASK_CONTEXT_ITEMS = 8;
const ASK_SUMMARY_CHARS = 700;
const TRANSLATE_CHUNK_CHARS = 1600;

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function parseDocument(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: text };
  let data = {};
  try {
    data = parseYaml(match[1]) ?? {};
  } catch {
    data = {};
  }
  return { data, body: match[2] };
}

function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function loadItems() {
  return walkMarkdown(itemsDir).map((file) => {
    const { data, body } = parseDocument(readFileSync(file, 'utf8'));
    return {
      kind: 'item',
      id: String(data.id ?? ''),
      category: String(data.category ?? ''),
      title: String(data.title ?? ''),
      summary: String(data.summary ?? body.slice(0, 2000)),
      why: data.why_it_matters == null ? '' : String(data.why_it_matters),
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      source: data.source?.display_name || data.source?.name || '',
      sourceUrl: data.source?.url || '',
      publishedAt: String(data.source_published_at ?? data.published_at ?? ''),
      path: relative(repo, file).replaceAll('\\', '/'),
    };
  }).filter((item) => item.id);
}

function loadBriefings() {
  return walkMarkdown(briefingsDir).map((file) => {
    const { data, body } = parseDocument(readFileSync(file, 'utf8'));
    return {
      kind: 'briefing',
      id: String(data.id ?? ''),
      category: String(data.category ?? ''),
      date: String(data.date ?? ''),
      title: String(data.title ?? ''),
      body,
      itemIds: Array.isArray(data.item_ids) ? data.item_ids.map(String) : [],
      path: relative(repo, file).replaceAll('\\', '/'),
    };
  }).filter((b) => b.id && b.date);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function tokenize(query) {
  const tokens = [];
  for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9._+-]{1,}/g) ?? []) tokens.push(word);
  for (const run of query.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (run.length <= 3) tokens.push(run);
    else for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}

function scoreEntry(entry, tokens, { title, body, extra }) {
  let score = 0;
  for (const token of tokens) {
    const isCjk = /[\u4e00-\u9fff]/.test(token);
    const hit = (text, weight) => {
      if (!text) return;
      const lower = text.toLowerCase();
      if (isCjk ? lower.includes(token) : lower.includes(token)) score += weight;
    };
    hit(title, 4);
    hit(extra, 3);
    hit(body, 2);
  }
  return score;
}

function parseFilters(query) {
  const date = query.match(/@(\d{4}-\d{2}-\d{2})|@latest/i)?.[1] ?? '';
  const category = query.match(/#([a-z_-]+)/i)?.[1]?.toLowerCase() ?? '';
  const rest = query
    .replace(/@(\d{4}-\d{2}-\d{2}|latest)/gi, '')
    .replace(/#[a-z_-]+/gi, '')
    .trim();
  return { date, category: category.replaceAll('-', '_'), keywords: rest };
}

function search(corpus, query) {
  const { date, category, keywords } = parseFilters(query);
  let pool = corpus.items;
  if (category) pool = pool.filter((item) => item.category === category);
  if (date === 'latest' || (date && !keywords)) {
    const newest = latestDate(corpus.briefings);
    pool = pool.filter((item) => corpus.briefings.some((b) => b.date === (date === 'latest' ? newest : date) && b.itemIds.includes(item.id)));
  } else if (date) {
    pool = pool.filter((item) => item.publishedAt.startsWith(date));
  }
  const tokens = tokenize(keywords);
  if (!tokens.length) return [];
  return pool
    .map((item) => ({ item, score: scoreEntry(item, tokens, { title: item.title, body: item.summary, extra: `${item.tags.join(' ')} ${item.source}` }) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.item.publishedAt.localeCompare(a.item.publishedAt))
    .slice(0, 20)
    .map((entry) => entry.item);
}

function latestDate(briefings) {
  return briefings.reduce((max, b) => (b.date > max ? b.date : max), '');
}

function listDates(briefings) {
  return [...new Set(briefings.map((b) => b.date))].sort().reverse();
}

// ---------------------------------------------------------------------------
// GLM
// ---------------------------------------------------------------------------

// Free-tier routing is load-balanced across upstreams: 429/5xx and
// reasoning-swallowed completions (finish=length, empty content) are both
// transient. Retry with backoff before giving up.
const CHAT_ATTEMPTS = 3;

const chatDelay = (attempt) => new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 4000));
/** Connection-level failures ("fetch failed", no HTTP status) are cooldowns,
 * not blips: the local proxy or the shared endpoint needs a real pause. */
const CONNECTION_COOLDOWN_MS = 15_000;
/** Gentle pacing between sequential calls: a long translation burst through a
 * local proxy or a shared free-tier endpoint otherwise trips connection
 * limits ("fetch failed" with no HTTP status at all). */
const INTER_CALL_DELAY_MS = 2000;
const pace = () => new Promise((resolveDelay) => setTimeout(resolveDelay, INTER_CALL_DELAY_MS));

/** One model, up to CHAT_ATTEMPTS tries for transient failures. */
async function chatWithModel(entry, messages, { maxTokens = 4096, temperature = 0.3 } = {}) {
    // OpenRouter attributes apps via its optional headers; Gemini/Zhipu ignore them.
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${entry.apiKey}`,
      ...entry.headers,
    };
    for (let attempt = 1; attempt <= CHAT_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(`${entry.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: entry.model, messages, temperature, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(Number(process.env.BOT_TIMEOUT_MS) || 180_000),
        });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 400);
        if (/location is not supported/i.test(detail)) {
          throw Object.assign(new Error(
            `LLM API rejected the request: the proxy EXIT IP is in a region Gemini does not serve. ` +
            `Switch your Clash node to an international one and retry.`,
          ), { failover: true });
        }
        const error = new Error(`LLM API (${entry.provider}:${entry.model}) ${response.status}: ${detail}`);
        // 429 (daily/rate cap) and auth/config errors never improve by
        // retrying the same model â€” fail over (or stop) immediately.
        if ([401, 403, 429].includes(response.status)) {
          throw Object.assign(error, { failover: true, noFallback: response.status !== 429 });
        }
        if ([408, 500, 502, 503, 504].includes(response.status) && attempt < CHAT_ATTEMPTS) {
          await chatDelay(attempt);
          continue;
        }
        throw Object.assign(error, { failover: true });
      }
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content === 'string' && content.trim()) return content.trim();
      if (attempt < CHAT_ATTEMPTS) {
        await chatDelay(attempt);
        continue;
      }
      throw Object.assign(
        new Error(
          `${entry.provider}:${entry.model} returned no content after ${CHAT_ATTEMPTS} attempts (finish_reason: ${choice?.finish_reason ?? 'unknown'}).` +
          (choice?.message?.reasoning ? ' The model spent the budget on reasoning.' : ''),
        ),
        { failover: true },
      );
    } catch (error) {
      if (error.failover || attempt >= CHAT_ATTEMPTS) throw error;
      // No response object at all = connection-level (proxy/endpoint storm).
      if (!error.status) await new Promise((resolveDelay) => setTimeout(resolveDelay, CONNECTION_COOLDOWN_MS * attempt));
      else await chatDelay(attempt);
    }
  }
}

/** Try the model chain in order; auth errors stop the chain. */
async function chat(messages, options = {}) {
  if (!API_KEY) throw new Error(missingKeyMessage);
  const errors = [];
  for (const model of MODEL_CHAIN) {
    try {
      return await chatWithModel(model, messages, options);
    } catch (error) {
      errors.push(error);
      if (error.noFallback) break;
    }
  }
  throw new Error(
    `All ${errors.length} model(s) failed (${MODEL_CHAIN.map((entry) => `${entry.provider}:${entry.model}`).join(' -> ')}):\n${errors.map((error) => `â€” ${error.message}`).join('\n')}`,
  );
}

// ---------------------------------------------------------------------------
// translate â€” English rendering of a day's briefings, cached on disk
// ---------------------------------------------------------------------------

const TRANSLATE_SYSTEM =
  'You translate Chinese daily-intelligence digests into English. ' +
  'Translate faithfully and completely. Keep the markdown structure exactly: ' +
  'headings, bold, dates in brackets, links, and any identifiers stay as-is. ' +
  'Keep university/company/product proper nouns natural in English ' +
  '(transliterate Chinese names, e.g. å¤§è¿žç†å·¥å¤§å­¦ -> Dalian University of Technology). ' +
  'Output ONLY the translated markdown, no commentary.';

function splitChunks(text, limit = TRANSLATE_CHUNK_CHARS) {
  const paragraphs = text.split(/\n(?=\S)/);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
    while (current.length > limit * 2) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function cachePath(date, category) {
  return join(cacheDir, date, `${category}.md`);
}

async function translateBriefing(corpus, briefing, { refresh }) {
  const target = cachePath(briefing.date, briefing.category);
  if (!refresh && existsSync(target)) {
    return { text: parseDocument(readFileSync(target, 'utf8')).body, cached: true };
  }
  const chunks = splitChunks(briefing.body.trim());
  const parts = [];
  for (const chunk of chunks) {
    if (parts.length) await pace();
    parts.push(await chat(
      [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: chunk },
      ],
      { maxTokens: 4096 },
    ));
  }
  const header = `# ${briefing.category} â€” ${briefing.date} (English edition)\n\n`;
  const frontmatter = [
    '---',
    `date: "${briefing.date}"`,
    `category: "${briefing.category}"`,
    `title: "${briefing.category} briefing ${briefing.date} â€” English"`,
    `generated_at: "${new Date().toISOString()}"`,
    '---',
    '',
  ].join('\n');
  mkdirSync(join(cacheDir, briefing.date), { recursive: true });
  writeFileSync(target, `${frontmatter}${header}${parts.join('\n\n')}\n`, 'utf8');
  return { text: `${header}${parts.join('\n\n')}\n`, cached: false };
}

async function translateCommand(corpus, argString, { refresh }) {
  if (!API_KEY) throw new Error(missingKeyMessage);
  const categorySlugs = new Map([['ai_news', 'ai_news'], ['ai-news', 'ai_news']]);
  let category = '';
  let dateArg = '';
  for (const token of argString.split(/\s+/).filter(Boolean)) {
    if (token === '--refresh') continue;
    if (/^#/.test(token)) {
      const raw = token.slice(1).toLowerCase();
      category = categorySlugs.get(raw) ?? raw.replaceAll('-', '_');
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) || token === 'latest') {
      dateArg = token;
      continue;
    }
    const raw = token.toLowerCase();
    const asCategory = categorySlugs.get(raw) ?? raw.replaceAll('-', '_');
    if (!category && corpus.briefings.some((b) => b.category === asCategory)) category = asCategory;
  }
  const date = !dateArg || dateArg === 'latest' ? latestDate(corpus.briefings) : dateArg;
  const briefings = corpus.briefings
    .filter((b) => b.date === date && (!category || b.category === category))
    .sort((a, b) => a.category.localeCompare(b.category));
  if (!briefings.length) {
    console.log(`No briefings for ${date}${category ? ` #${category}` : ''}. Available: ${listDates(corpus.briefings).join(', ')}`);
    return;
  }
  console.log(`\n=== DailyInfo ${date} â€” English edition${refresh ? ' (fresh)' : ''} ===\n`);
  for (const briefing of briefings) {
    const { text, cached } = await translateBriefing(corpus, briefing, { refresh });
    console.log(text.trimEnd());
    console.log(cached ? '\n(cached â€” use: bot translate --refresh)\n' : '');
  }
}

// ---------------------------------------------------------------------------
// ask â€” search the corpus, then have GLM answer in English
// ---------------------------------------------------------------------------

function buildContext(items) {
  return items.map((item) => {
    const summary = item.summary.length > ASK_SUMMARY_CHARS ? `${item.summary.slice(0, ASK_SUMMARY_CHARS)}â€¦` : item.summary;
    const lines = [
      `- id: ${item.category}/${item.id}`,
      `  date: ${item.publishedAt.slice(0, 10) || 'unknown'} | source: ${item.source || 'unknown'}`,
      `  title: ${item.title}`,
      `  summary: ${summary.replaceAll('\n', ' ')}`,
    ];
    if (item.why) lines.push(`  why it matters: ${item.why.replaceAll('\n', ' ').slice(0, 300)}`);
    return lines.join('\n');
  }).join('\n');
}

const ASK_SYSTEM =
  'You are the DailyInfo research assistant. You answer questions in ENGLISH using ONLY the ' +
  'numbered material below (originally Chinese/English intelligence items: papers, AI news, code, resources). ' +
  'Rules:\n' +
  '1. Summarize and synthesize; never invent facts not present in the material.\n' +
  '2. Cite the items you use inline as [category/id].\n' +
  '3. If the material does not cover the question, say so plainly and suggest closer keywords.\n' +
  '4. Be concise: short intro, then grouped bullet points.';

async function askCommand(corpus, question) {
  if (!API_KEY) throw new Error(missingKeyMessage);
  const filters = parseFilters(question);
  const matches = search(corpus, question);
  if (!matches.length) {
    console.log(`\nNo corpus material matches "${filters.keywords || question}". Try: search <keywords>, or add @date / #category filters.`);
    return;
  }
  const top = matches.slice(0, ASK_CONTEXT_ITEMS);
  let context = `Material (${top.length} of ${matches.length} matches):\n${buildContext(top)}`;
  const { date } = filters;
  const effectiveDate = date === 'latest' ? latestDate(corpus.briefings) : date;
  if (effectiveDate) {
    const dayBriefings = corpus.briefings.filter((b) => b.date === effectiveDate);
    if (dayBriefings.length) {
      context += `\n\nDaily digests for ${effectiveDate}:\n${dayBriefings
        .map((b) => `- ${b.category}: ${b.title} (${b.itemIds.length} items)`)
        .join('\n')}`;
    }
  }
  const answer = await chat(
    [
      { role: 'system', content: ASK_SYSTEM },
      { role: 'user', content: `Question: ${question}\n\n${context}` },
    ],
    { maxTokens: 2048, temperature: 0.4 },
  );
  console.log(`\n${answer}\n`);
  console.log(`Sources searched: ${top.length} item(s)${filters.date || filters.category ? ` (filters: ${[filters.date && `@${filters.date}`, filters.category && `#${filters.category}`].filter(Boolean).join(' ')})` : ''}`);
}

// ---------------------------------------------------------------------------
// search â€” raw corpus search, no LLM
// ---------------------------------------------------------------------------

function searchCommand(corpus, query) {
  const matches = search(corpus, query);
  if (!matches.length) {
    console.log(`\nNo matches for "${query}".`);
    return;
  }
  console.log(`\n${matches.length} match(es) for "${query}":\n`);
  for (const item of matches) {
    console.log(`  [${item.category}] ${item.id}`);
    console.log(`    ${item.title}`);
    if (item.source) console.log(`    source: ${item.source} | ${item.publishedAt.slice(0, 10)}`);
  }
}

// ---------------------------------------------------------------------------
// Paper agent â€” search the web, fetch the paper, summarize it
//
// Flow: query/URL/DOI â†’ free scholarly APIs (arXiv, Semantic Scholar, Crossref)
// â†’ best match â†’ open-access PDF (arXiv / Semantic Scholar / Unpaywall) â†’
// text extraction â†’ map-reduce LLM summary. Paywalled papers fall back to a
// one-click institutional link (UNI_EZPROXY_URL) and a drop folder:
// save the PDF to runtime/papers/ and run `summarize <name>`.
// ---------------------------------------------------------------------------

const papersDir = join(repo, 'runtime/papers');
const FETCH_TARGETS = 5;
const FETCH_TIMEOUT_MS = 45_000;
const SUMMARY_CHUNK_CHARS = 3200;
const SUMMARY_MAX_CHUNKS = 14;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DailyInfoBot/1.0';

/** In the REPL this is wired to readline; one-shot mode auto-picks. */
let candidatePicker = null;
/** University links are never automatic: the REPL asks before showing one, and
 * one-shot mode requires --uni. No credentials exist anywhere in this script. */
let uniLinkConfirmer = null;

async function httpGetText(url, { retries = 1 } = {}) {
    // Scholarly APIs rate-limit in bursts (S2 especially); a short retry
    // absorbs transient 429/5xx without failing the whole search.
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
      }
    }
    throw lastError;
  }

function cleanWhitespace(text) {
  return String(text ?? '').replaceAll(/\s+/g, ' ').trim();
}

function stripJats(xml) {
  return cleanWhitespace(String(xml ?? '')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&lt;/g, '<').replaceAll(/&gt;/g, '>').replaceAll(/&amp;/g, '&'));
}

function slugifyFile(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
}

function normalizeSearchQuery(query) {
  // Colons etc. are arXiv field-query syntax â€” a pasted title like
  // "SWIFT: Sample-Wise ..." breaks the API unless stripped first.
  return String(query).replaceAll(/["']/g, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function splitName(name) {
  // "Jane Alice Doe" -> { family: 'Doe', given: 'Jane Alice' } â€” heuristic;
  // bibliography-grade name parsing is out of scope, this matches what
  // Crossref/Semantic Scholar supply well enough for citation records.
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { family: 'Unknown', given: '' };
  if (parts.length === 1) return { family: parts[0], given: '' };
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
}

function parseArxivEntry(block) {
    const id = block.match(/<id>([^<]+)<\/id>/)?.[1] ?? '';
    const arxivId = id.match(/abs\/([^?/]+)/)?.[1] ?? '';
    const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
      .map((match) => splitName(stripJats(match[1])));
    return {
      title: stripJats(block.match(/<title>([\s\S]*?)<\/title>/)?.[1]),
      authors,
      abstract: stripJats(block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]),
      year: block.match(/<published>(\d{4})/)?.[1] ?? '',
      venue: 'arXiv',
      arxivId,
      doi: block.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1] ?? '',
      pdf: arxivId ? `https://arxiv.org/pdf/${arxivId}` : '',
      citations: null,
      provider: 'arXiv',
      url: id,
    };
  }

async function searchArxiv(query) {
  const cleaned = normalizeSearchQuery(query);
  // Exact phrase first, then plain keywords â€” brand-new papers need the
  // loose form when the phrase index lags.
  for (const attempt of [`"${cleaned}"`, cleaned]) {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${attempt}`)}&max_results=${FETCH_TARGETS}&sortBy=relevance`;
    try {
      const xml = await httpGetText(url);
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
        .map((match) => parseArxivEntry(match[1]))
        .filter((paper) => paper.title);
      if (entries.length) return entries;
    } catch {
      /* next attempt */
    }
  }
  return [];
}

/** Deterministic metadata lookup by arXiv id (abs/pdf/html URLs, bare ids). */
async function fetchArxivById(arxivId) {
  const clean = arxivId.replace(/v\d+$/i, '');
  try {
    const xml = await httpGetText(`https://export.arxiv.org/api/query?id_list=${clean}&max_results=1`);
    const entry = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)][0];
    if (entry) return parseArxivEntry(entry[1]);
  } catch {
    /* fall through to the synthetic record */
  }
  return {
    title: `arXiv:${clean}`,
    authors: [],
    abstract: '',
    year: '',
    venue: 'arXiv',
    arxivId: clean,
    doi: '',
    pdf: `https://arxiv.org/pdf/${clean}`,
    citations: null,
    provider: 'arXiv',
    url: `https://arxiv.org/abs/${clean}`,
  };
}

async function searchSemanticScholar(query) {
    const fields = ['title', 'abstract', 'year', 'venue', 'authors', 'externalIds', 'openAccessPdf', 'citationCount'].join(',');
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${FETCH_TARGETS}&fields=${fields}`;
    const json = JSON.parse(await httpGetText(url));
    return (json.data ?? []).map((paper) => ({
      title: cleanWhitespace(paper.title),
      authors: (paper.authors ?? []).map((author) => splitName(author.name)),
      abstract: cleanWhitespace(paper.abstract ?? ''),
      year: paper.year ?? '',
      venue: paper.venue || (paper.externalIds?.ArXiv ? 'arXiv' : ''),
      arxivId: paper.externalIds?.ArXiv ?? '',
      doi: paper.externalIds?.DOI ?? '',
      pdf: paper.openAccessPdf?.url ?? '',
      citations: paper.citationCount ?? null,
      provider: 'Semantic Scholar',
      url: paper.externalIds?.DOI ? `https://doi.org/${paper.externalIds.DOI}` : (paper.externalIds?.ArXiv ? `https://arxiv.org/abs/${paper.externalIds.ArXiv}` : ''),
    })).filter((paper) => paper.title);
  }

/** Crossref bibliographic search â€” the index that covers JOURNAL papers
 * (Journal of Hydrology, Nature, ...) that never touch arXiv. */
async function searchCrossref(query) {
    const cleaned = normalizeSearchQuery(query);
    const select = ['DOI', 'title', 'author', 'issued', 'container-title', 'abstract'].join(',');
    // mailto joins Crossref's "polite pool" â€” far better rate limits than the
    // anonymous shared pool that bursts into 429s.
    const mailto = process.env.UNPAYWALL_EMAIL ? `&mailto=${encodeURIComponent(process.env.UNPAYWALL_EMAIL)}` : '';
    const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(cleaned)}&rows=${FETCH_TARGETS}&select=${select}${mailto}`;
    const json = JSON.parse(await httpGetText(url, { retries: 2 }));
  return (json.message?.items ?? []).map((meta) => ({
    title: cleanWhitespace(meta.title?.[0] ?? ''),
    authors: (meta.author ?? []).map((author) => author.family
      ? { family: author.family, given: author.given ?? '' }
      : splitName(author.name ?? '')),
    abstract: stripJats(meta.abstract ?? ''),
    year: String(meta.issued?.['date-parts']?.[0]?.[0] ?? ''),
    venue: cleanWhitespace(meta['container-title']?.[0] ?? ''),
    arxivId: '',
    doi: meta.DOI ?? '',
    pdf: '',
    citations: null,
    provider: 'Crossref',
    url: meta.DOI ? `https://doi.org/${meta.DOI}` : '',
  })).filter((paper) => paper.title);
}

async function resolveDoi(doi) {
  const json = JSON.parse(await httpGetText(`https://api.crossref.org/works/${encodeURIComponent(doi)}`));
  const meta = json.message ?? {};
  const year = meta.issued?.['date-parts']?.[0]?.[0] ?? '';
    const paper = {
      title: cleanWhitespace(meta.title?.[0] ?? ''),
      authors: (meta.author ?? []).map((author) => author.family
        ? { family: author.family, given: author.given ?? '' }
        : splitName(author.name ?? '')),
      abstract: stripJats(meta.abstract ?? ''),
      year: String(year),
      venue: cleanWhitespace(meta['container-title']?.[0] ?? ''),
      arxivId: '',
      doi,
      pdf: '',
      citations: null,
      provider: 'Crossref',
      url: `https://doi.org/${doi}`,
    };
  if (!paper.abstract) {
    // Crossref often omits abstracts (e.g. Nature) â€” Semantic Scholar has them.
    try {
        const enrichment = JSON.parse(await httpGetText(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=abstract,authors,openAccessPdf,externalIds`));
        paper.abstract = cleanWhitespace(enrichment.abstract ?? '');
        if (!paper.authors.length && enrichment.authors?.length) {
          paper.authors = enrichment.authors.map((author) => splitName(author.name));
        }
        paper.pdf ||= enrichment.openAccessPdf?.url ?? '';
        paper.arxivId ||= enrichment.externalIds?.ArXiv ?? '';
    } catch {
      /* best-effort enrichment */
    }
  }
  return paper;
}

async function resolvePaperUrl(rawUrl) {
  // abs/, pdf/, and the newer html/ URLs all carry the same id; bare ids work too.
  const arxivId = rawUrl.match(/arxiv\.(?:org|net)\/(?:abs|pdf|html)\/([^\s?/#]+)/i)?.[1]
    ?? (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(rawUrl.trim()) ? rawUrl.trim() : '');
  if (arxivId) return [await fetchArxivById(arxivId)];
  // Any URL carrying a DOI works: doi.org, and publisher pages that embed it
  // in their path (Wiley/AGU /doi/..., Nature, ScienceDirect, Springer, ...).
  // The capture stops at query/hash/whitespace.
  const doi = rawUrl.match(/(10\.\d{4,9}\/[^\s"'?#&]+)/i)?.[1];
  if (doi) return [await resolveDoi(doi)];
  throw new Error('Unsupported URL â€” use an arXiv link (abs/pdf/html), a bare DOI, any publisher URL containing a DOI, or a search query.');
}

function mergeCandidates(groups) {
  const seen = new Map();
  for (const paper of groups.flat()) {
    if (!paper.title) continue;
    const key = cleanWhitespace(paper.title).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    const existing = seen.get(key);
    if (!existing) seen.set(key, paper);
      else {
        existing.abstract ||= paper.abstract;
        existing.pdf ||= paper.pdf;
        existing.doi ||= paper.doi;
        existing.arxivId ||= paper.arxivId;
        existing.citations ??= paper.citations;
        existing.venue ||= paper.venue;
        if (!existing.authors?.length) existing.authors = paper.authors ?? [];
      }
  }
  return [...seen.values()].slice(0, FETCH_TARGETS);
}

async function findOpenPdf(paper) {
    const candidates = [paper.pdf];
    if (paper.arxivId) candidates.push(`https://arxiv.org/pdf/${paper.arxivId}`);
    if (paper.doi && process.env.UNPAYWALL_EMAIL) {
      try {
        const json = JSON.parse(await httpGetText(`https://api.unpaywall.org/v2/${encodeURIComponent(paper.doi)}?email=${encodeURIComponent(process.env.UNPAYWALL_EMAIL)}`));
        const best = json.best_oa_location?.url_for_pdf ?? json.best_oa_location?.url;
        if (best) {
          candidates.push(best);
          const host = new URL(best).host;
          console.log(`[agent] Unpaywall: open-access copy found (${host})`);
        } else {
          console.log('[agent] Unpaywall: no open-access copy for this DOI');
        }
      } catch {
        /* unpaywall is best-effort */
      }
    } else if (paper.doi) {
      console.log('[agent] tip: set UNPAYWALL_EMAIL in .env for open-access copy lookup');
    }
    // Index loop on purpose: appended citation_pdf_url candidates must be
    // iterated too (a filter() snapshot would silently drop them).
    for (let index = 0; index < candidates.length; index++) {
      const url = candidates[index];
      if (!url) continue;
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': BROWSER_UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.subarray(0, 4).toString('latin1') === '%PDF') {
          mkdirSync(papersDir, { recursive: true });
          const dest = join(papersDir, `${slugifyFile(paper.title)}.pdf`);
          writeFileSync(dest, buffer);
          return dest;
        }
        // Landing page instead of a PDF? Publisher pages carry the standard
        // citation_pdf_url meta tag â€” Unpaywall often only knows the landing
        // page (Copernicus, Nature, Elsevier all use this).
        const html = buffer.toString('utf8');
        const pdfLink = html.match(/<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']/i)?.[1]
          ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']/i)?.[1];
        if (pdfLink && !candidates.includes(pdfLink)) {
          candidates.push(pdfLink);
          console.log('[agent] following citation_pdf_url from the landing page');
        }
      } catch {
        /* try next candidate */
      }
    }
    return '';
  }

async function extractPdfText(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(filePath)), useSystemFonts: false }).promise;
  const pages = [];
  for (let index = 1; index <= doc.numPages; index++) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return pages.join('\n\n').replaceAll(/[ \t]+/g, ' ').trim();
}

const SUMMARIZE_SYSTEM =
  'You summarize academic papers in precise, plain English for a researcher. ' +
  'Base everything strictly on the provided text; never invent results.';

async function summarizeText(text) {
  const chunks = splitChunks(text, SUMMARY_CHUNK_CHARS).slice(0, SUMMARY_MAX_CHUNKS);
  const truncated = chunks.length >= SUMMARY_MAX_CHUNKS;
  if (chunks.length === 1) {
    return chat(
      [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `Summarize this paper text. Structure:\n**Problem** / **Method** / **Key results** (with numbers when present) / **Limitations** / **Why it matters**.\n\n${chunks[0]}` },
      ],
      { maxTokens: 2048, temperature: 0.2 },
    );
  }
  const notes = [];
  for (const [index, chunk] of chunks.entries()) {
    process.stdout.write(`\r[agent] reading part ${index + 1}/${chunks.length}â€¦`);
    if (index) await pace();
    notes.push(await chat(
      [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `Extract the key claims, methods and numbers from this section of a paper. Be terse bullet points.\n\n${chunk}` },
      ],
      { maxTokens: 1200, temperature: 0.2 },
    ));
  }
  process.stdout.write('\n');
  return chat(
    [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      {
        role: 'user',
        content: `These are section notes from one paper${truncated ? ' (text was truncated; later sections like references may be missing)' : ''}. Write the final summary. Structure:\n**Problem** / **Method** / **Key results** (numbers when present) / **Limitations** / **Why it matters**.\n\n${notes.join('\n\n')}`,
      },
    ],
    { maxTokens: 2048, temperature: 0.2 },
  );
}

/** Share of the query's title tokens present in the candidate title (0-1). */
function relevanceScore(paper, query) {
  const tokens = [...new Set(normalizeSearchQuery(query).toLowerCase().split(/\s+/).filter((token) => token.length > 2))];
  if (!tokens.length) return 0;
  const title = paper.title.toLowerCase();
  return tokens.filter((token) => title.includes(token)).length / tokens.length;
}

function printCandidates(candidates, scores = []) {
  console.log(`\nFound ${candidates.length} candidate(s):\n`);
  candidates.forEach((paper, index) => {
    const score = scores[index] != null ? ` Â· ${Math.round(scores[index] * 100)}% match` : '';
    console.log(`  ${index + 1}. [${paper.year || '????'}] ${paper.title}`);
    console.log(`     ${[paper.venue, paper.provider, paper.citations != null ? `${paper.citations} citations` : ''].filter(Boolean).join(' Â· ')}${score}`);
  });
  console.log('');
}

let lastFetchedPaper = null;

/** The most recent paper the agent presented â€” the save targets (zotero/ris)
 * operate on this, always on explicit user action. */
function getLastFetchedPaper() {
  return lastFetchedPaper;
}

async function presentAndSummarize(paper, { allowUniLink = false } = {}) {
    lastFetchedPaper = paper;
    console.log(`\nPaper: ${paper.title}`);
    if (paper.authors?.length) {
      const first = paper.authors[0];
      const suffix = paper.authors.length > 1 ? ' et al.' : '';
      console.log(`Authors: ${[first.given, first.family].filter(Boolean).join(' ')}${suffix}`);
    }
    if (paper.venue || paper.year) console.log(`Venue: ${[paper.venue, paper.year].filter(Boolean).join(', ')}`);
    let filePath = '';
  process.stdout.write('[agent] looking for an open-access PDFâ€¦\n');
  if (paper.abstract || paper.title) filePath = await findOpenPdf(paper);
  if (filePath) {
    console.log(`[agent] PDF saved: ${filePath}`);
    process.stdout.write('[agent] extracting textâ€¦\n');
    const text = await extractPdfText(filePath);
    if (text.length < 500) throw new Error('The PDF has no extractable text (likely a scan). Save a text-rich copy manually and use: summarize <file>');
    console.log(`[agent] ${text.length.toLocaleString()} chars extracted â€” summarizingâ€¦\n`);
    const summary = await summarizeText(text);
    console.log(`\n${summary}\n`);
    console.log('Keep it: type "zotero" (save to Zotero library) or "ris" (citation file for Mendeley).');
    return;
  }
  // Paywalled â€” hybrid fallback: institutional link (only if you confirm) + drop folder.
  const landing = paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : '');
  const proxy = process.env.UNI_EZPROXY_URL;
  console.log('\nNo open-access PDF found (paywalled).');
  let uniWanted = false;
  if (proxy && landing) {
    uniWanted = uniLinkConfirmer
      ? await uniLinkConfirmer(paper)
      : allowUniLink;
      if (uniWanted) {
        if (/webvpn/i.test(proxy)) {
          // Chinese university WebVPN gateways drop you at the portal home
          // after login instead of honoring ?url= â€” the reliable path is the
          // portal's own address bar.
          const webvpnHome = proxy.replace(/\/login\?url=$/i, '').replace(/\/+$/, '');
          console.log(`
University access (WebVPN) â€” 3 steps:
  1. Open  ${webvpnHome}  and log in with your student account
  2. In the WebVPN portal's address bar, paste this link:
       ${landing}
  3. The publisher page opens through the campus network â€” download the PDF from there`);
        } else {
          console.log(`\nOpen through your university access (you log in yourself in the browser):\n  ${proxy}${encodeURIComponent(landing)}`);
        }
      } else {
      console.log(`\nPaper page: ${landing}`);
      console.log('(university access link withheld â€” in the REPL answer y, or rerun with --uni)');
    }
  } else if (landing) {
    console.log(`\nPaper page: ${landing}`);
    console.log('(Tip: set UNI_EZPROXY_URL in .env to get one-click university links.)');
  }
  console.log(`\nThen save the PDF as: runtime/papers/${slugifyFile(paper.title)}.pdf`);
  console.log(`And run: summarize ${slugifyFile(paper.title)}`);
  if (paper.abstract) {
    console.log('\nMeanwhile, here is the abstract:\n');
    const summary = await chat(
      [
        { role: 'system', content: SUMMARIZE_SYSTEM },
        { role: 'user', content: `Summarize this abstract in 3-4 plain English sentences, then one line on why it matters.\n\n${paper.abstract}` },
      ],
      { maxTokens: 800, temperature: 0.2 },
    );
    console.log(summary);
  }
  console.log('\nKeep it: type "zotero" (save to Zotero library) or "ris" (citation file for Mendeley).');
}

async function fetchCommand(corpus, rawArgument) {
  const argument = rawArgument.replace(/--pick\s+\d+\s*/i, '').replace(/--uni\s*/i, '').trim();
  const pickMatch = rawArgument.match(/--pick\s+(\d+)/i);
  const allowUniLink = /--uni/i.test(rawArgument);
  if (!argument) throw new Error('Usage: fetch <query | arxiv-url | doi>   e.g. fetch "attention is all you need"');
  process.stdout.write('[agent] searching the webâ€¦\n');
  let candidates;
  if (/^https?:\/\//i.test(argument) || /^\d{4}\.\d{4,5}(v\d+)?$/i.test(argument)) {
    candidates = await resolvePaperUrl(argument);
  } else if (/^10\.\d{4,9}\//.test(argument)) {
    candidates = [await resolveDoi(argument)];
    } else {
      const [arxiv, s2, crossref] = await Promise.all([
        searchArxiv(argument).catch(() => []),
        searchSemanticScholar(argument).catch(() => []),
        searchCrossref(argument).catch(() => []),
      ]);
      candidates = mergeCandidates([crossref, s2, arxiv]);
      if (!candidates.length) {
        // Brand-new papers are often not indexed by the search APIs yet, but
        // your own DailyInfo corpus already tracks them â€” use its source link.
        // Same relevance gate as auto-pick: a single shared keyword is not a
        // match, otherwise a stray dataset item gets fetched instead.
        const localMatch = search(corpus, normalizeSearchQuery(argument))
          .find((item) => item.sourceUrl && relevanceScore({ title: item.title }, argument) >= 0.55);
        if (localMatch) {
          console.log(`[agent] not indexed by the search APIs yet â€” found it in your corpus: [${localMatch.category}/${localMatch.id}] (${localMatch.title})`);
          candidates = await resolvePaperUrl(localMatch.sourceUrl);
        }
      }
    }
    if (!candidates.length) {
      console.log(`\nNothing found for "${argument}". Try a shorter keyword set or an exact title in quotes.`);
      return;
    }
    // Relevance gate: the top candidate must share enough of the query's
    // title tokens before the agent is allowed to choose on its own â€”
    // otherwise the list is shown and the user decides.
    const AUTO_PICK_THRESHOLD = 0.55;
    const scores = candidates.map((candidate) => relevanceScore(candidate, argument));
    candidates = candidates
      .map((candidate, position) => ({ candidate, position }))
      .sort((a, b) => scores[b.position] - scores[a.position])
      .map((entry) => entry.candidate);
    let index = 0;
    if (pickMatch) {
      index = Math.min(Number(pickMatch[1]) - 1, candidates.length - 1);
    } else if (candidates.length > 1 && candidatePicker) {
      printCandidates(candidates, scores);
      index = await candidatePicker(candidates.length);
      if (index < 0) return;
    } else if (scores[0] >= AUTO_PICK_THRESHOLD) {
      if (candidates.length > 1) {
        printCandidates(candidates, scores);
        console.log(`(auto-picking 1 â€” ${Math.round(scores[0] * 100)}% title match; rerun with --pick N to choose another)\n`);
      }
    } else {
      printCandidates(candidates, scores);
      console.log('No confident title match â€” pick one with --pick N, or refine the query.\n');
      return;
    }
    await presentAndSummarize(candidates[index], { allowUniLink });
  }

async function summarizeCommand(argument) {
  if (!argument) throw new Error('Usage: summarize <file-name-in-runtime/papers | absolute path>');
  const direct = existsSync(argument) ? argument : '';
  const inPapers = join(papersDir, argument.endsWith('.pdf') ? argument : `${argument}.pdf`);
  const found = direct || (existsSync(inPapers) ? inPapers : '');
  if (!found) {
    const available = existsSync(papersDir) ? readdirSync(papersDir).filter((name) => name.endsWith('.pdf')) : [];
    console.log(`\nNo PDF found for "${argument}".${available.length ? ` Available in runtime/papers: ${available.join(', ')}` : ' runtime/papers/ is empty â€” save a PDF there first.'}`);
    return;
  }
  console.log(`\n[agent] summarizing ${found}â€¦`);
  const text = await extractPdfText(found);
  if (text.length < 500) throw new Error('No extractable text in this PDF (likely a scanned image).');
  const summary = await summarizeText(text);
  console.log(`\n${summary}\n`);
}

function papersCommand() {
    const files = existsSync(papersDir) ? readdirSync(papersDir).filter((name) => name.endsWith('.pdf')) : [];
    if (!files.length) {
      console.log('\nNo papers downloaded yet. They land in runtime/papers/ when you run: fetch <query>\n');
      return;
    }
    console.log(`\n${files.length} paper(s) in runtime/papers/:\n`);
    for (const file of files) console.log(`  ${file}`);
    console.log('');
  }

  async function zoteroCommand() {
    const paper = getLastFetchedPaper();
    if (!paper) throw new Error('No paper fetched in this session yet â€” run fetch first.');
    const { saveToZoteroLocal, pingZotero } = await import('./zotero.mjs');
    if (!(await pingZotero())) {
      console.log('\nZotero is not running. Open the Zotero desktop app, then run: zotero\n');
      return;
    }
    const outcome = await saveToZoteroLocal(paper);
    console.log(`\n${outcome.message}\n`);
  }

  async function risCommand() {
    const paper = getLastFetchedPaper();
    if (!paper) throw new Error('No paper fetched in this session yet â€” run fetch first.');
    const { writeRis } = await import('./zotero.mjs');
    const path = writeRis(paper);
    console.log(`\nCitation file written: ${path}`);
    console.log('Import into Mendeley: drag the file onto the Mendeley window (or File -> Import).\n');
  }

// ---------------------------------------------------------------------------
// CLI / REPL
// ---------------------------------------------------------------------------

const HELP = `DailyInfo Bot â€” English translation + Q&A + paper agent

  translate [date] [category]   English edition of a day's briefings (default: latest, all)
                                 e.g. translate 2026-11-14 code | translate latest papers --refresh
  update                        git pull, then translate every day not yet cached
  fetch <query|url|doi>         AGENT: search the web, get the paper (open access),
                                summarize it.  e.g. fetch "attention is all you need"
                                 add --pick N to choose a specific search result
                                 add --uni to include the DUT WebVPN link for
                                 paywalled papers (REPL asks instead)
  summarize <pdf-name>          summarize a PDF from runtime/papers/ (drop paywalled
                                PDFs there when the agent can't fetch them itself)
  papers                        list downloaded papers
  zotero                        save the last fetched paper to your Zotero library
  ris                           write a citation file (runtime/papers/*.ris) for Mendeley
  ask <question>     search the corpus, answer in English with citations
  search <keywords>  raw search, no LLM (works without an API key)
  dates              dates that have briefings
  help               this help
  exit / quit        leave (REPL only)

  Filters for ask/search:  @2026-11-14 or @latest   #papers #ai-news #code #resource #arxiv
  Env: GEMINI_API_KEY / OPENROUTER_API_KEY / GLM_API_KEY (one required),
       BOT_MODEL, BOT_FALLBACK_MODELS, BOT_BASE_URL,
       UNI_EZPROXY_URL (optional: one-click university links for paywalled papers),
       UNPAYWALL_EMAIL (optional: wider open-access lookup)`;

function usage() {
  console.log(HELP);
}

async function runCommand(corpus, input) {
  const trimmed = input.trim();
  if (!trimmed) return true;
  const [command, ...rest] = trimmed.split(/\s+/);
  const argument = rest.join(' ').trim();
  switch (command.toLowerCase()) {
    case 'help':
    case '?':
      usage();
      return true;
    case 'dates': {
      const dates = listDates(corpus.briefings);
      console.log(`\n${dates.length} date(s): ${dates.join(', ') || '(none)'}\n`);
      return true;
    }
    case 'translate':
      await translateCommand(corpus, argument, { refresh: /--refresh/.test(argument) });
      return true;
    case 'update': {
      // One step: pull freshly published content (from the `upstream` remote
      // when configured â€” the origin may be a stale fork), then translate
      // every briefing day not fully cached yet (cached files cost nothing).
      const remotes = spawnSync('git', ['remote'], { cwd: repo, encoding: 'utf8' }).stdout.split(/\s+/).filter(Boolean);
      const pullFrom = remotes.includes('upstream') ? ['upstream', 'main'] : [];
      let pull = spawnSync('git', ['pull', '--ff-only', ...pullFrom], { cwd: repo, encoding: 'utf8' });
      if (pull.status !== 0 && pullFrom.length) {
        // Local commits (bot tooling) make a fast-forward impossible; rebase
        // them on top of upstream instead. Conflicts abort cleanly.
        pull = spawnSync('git', ['pull', '--rebase', ...pullFrom], { cwd: repo, encoding: 'utf8' });
      }
      console.log(pull.stdout.trim() || pull.stderr.trim() || '(git pull produced no output)');
      if (pull.status !== 0) {
        console.error('[bot] git pull failed â€” resolve it manually, then run translate.');
        return true;
      }
      const fresh = { items: loadItems(), briefings: loadBriefings() };
      console.error(`[bot] corpus after pull: ${fresh.items.length} items, ${fresh.briefings.length} briefings (${listDates(fresh.briefings).length} dates)`);
      const pending = listDates(fresh.briefings).filter((date) =>
        fresh.briefings.filter((b) => b.date === date).some((b) => !existsSync(join(cacheDir, date, `${b.category}.md`))),
      );
      if (!pending.length) {
        console.log('All published days are already translated.');
        return true;
      }
      console.error(`[bot] translating ${pending.length} day(s): ${pending.join(', ')}`);
      for (const date of pending) {
        await translateCommand(fresh, date, { refresh: false });
      }
      return true;
    }
    case 'ask':
      if (!argument) console.log('Usage: ask <question>');
      else await askCommand(corpus, argument);
      return true;
    case 'search':
      if (!argument) console.log('Usage: search <keywords>');
      else searchCommand(corpus, argument);
      return true;
    case 'fetch':
      await fetchCommand(corpus, argument);
      return true;
    case 'summarize':
      await summarizeCommand(argument);
      return true;
      case 'papers':
        papersCommand();
        return true;
      case 'zotero':
        await zoteroCommand();
        return true;
      case 'ris':
        await risCommand();
        return true;
    case 'exit':
    case 'quit':
      return false;
    default:
      await askCommand(corpus, trimmed);
      return true;
  }
}

async function main() {
  const corpus = { items: loadItems(), briefings: loadBriefings() };
  console.error(`[bot] corpus: ${corpus.items.length} items, ${corpus.briefings.length} briefings (${listDates(corpus.briefings).length} dates)`);
  const args = process.argv.slice(2);
  if (args.length) {
    await runCommand(corpus, args.join(' '));
    return;
  }
    if (!API_KEY) console.error('[bot] No LLM key set â€” translate/ask/fetch need one; search/dates work without.\n');
    usage();
    const readline = createInterface({ input: process.stdin, output: process.stdout, prompt: 'dailyinfo> ' });
    candidatePicker = async (count) => {
      const answer = (await readline.question('pick 1-' + count + ' (Enter = 1, q = cancel): ')).trim();
      if (/^q$/i.test(answer)) return -1;
      const number = Number(answer) || 1;
      return Math.min(Math.max(number, 1), count) - 1;
    };
    uniLinkConfirmer = async (paper) => {
      const answer = (await readline.question(`show the DUT WebVPN link for "${paper.title}"? (y/N): `)).trim();
      return /^y/i.test(answer);
    };
    readline.prompt();
  for (;;) {
    const line = await readline.question('').catch(() => null);
    if (line === null) break;
    let keepGoing;
    try {
      keepGoing = await runCommand(corpus, line);
    } catch (error) {
      console.error(`\n[bot] ${error.message}\n`);
      keepGoing = true;
    }
    if (!keepGoing) break;
    readline.prompt();
  }
  readline.close();
}

// Only run the CLI/REPL when executed directly â€” the agent server imports
// this module for its functions.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[bot] ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  loadItems,
  loadBriefings,
  runCommand,
  listDates,
  search,
  translateCommand,
  askCommand,
  fetchCommand,
  searchCommand,
  getLastFetchedPaper,
};
