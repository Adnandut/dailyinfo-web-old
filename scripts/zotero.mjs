/**
 * Citation saving for the DailyInfo agent.
 *
 * Zotero: uses the local connector server (http://127.0.0.1:23119) that the
 * Zotero desktop app runs — the same endpoint the browser plugin posts to.
 * No API key; requires Zotero to be open. Exposed as CLICK-ONLY actions from
 * the web UI / CLI: nothing is saved automatically.
 *
 * Mendeley: Elsevier's API is closed to new clients, so the path is a RIS
 * citation file the user imports (drag onto the Mendeley window).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ZOTERO_CONNECTOR = 'http://127.0.0.1:23119';
const REQUEST_TIMEOUT_MS = 15_000;

export async function pingZotero() {
  try {
    const response = await fetch(`${ZOTERO_CONNECTOR}/connector/ping`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

function cslCreators(paper) {
  return (paper.authors ?? []).map((author) => ({
    creatorType: 'author',
    firstName: author.given || '',
    lastName: author.family || author.given || 'Unknown',
  }));
}

function zoteroItem(paper) {
  const isArxiv = !paper.doi && (paper.arxivId || /arxiv/i.test(paper.venue ?? ''));
  const item = {
    itemType: isArxiv ? 'journalArticle' : 'journalArticle',
    title: paper.title,
    creators: cslCreators(paper),
    abstractNote: paper.abstract || '',
    date: paper.year || '',
    DOI: paper.doi || '',
    url: paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : ''),
    publicationTitle: isArxiv ? 'arXiv e-prints' : (paper.venue || ''),
    accessDate: new Date().toISOString().replace('T', ' ').slice(0, 16),
    language: '',
  };
  if (isArxiv && paper.arxivId) {
    item.archive = 'arXiv';
    item.callNumber = `arXiv:${paper.arxivId}`;
  }
  return item;
}

/** Save via Zotero's local connector. Returns { ok, message }. */
export async function saveToZoteroLocal(paper) {
  const response = await fetch(`${ZOTERO_CONNECTOR}/connector/saveItems`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionID: `dailyinfo-${Date.now()}`,
      items: [zoteroItem(paper)],
      uri: paper.url || '',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) {
    return { ok: true, message: `Saved to Zotero: "${paper.title}" — check your library (current collection).` };
  }
  const detail = (await response.text().catch(() => '')).slice(0, 200);
  return { ok: false, message: `Zotero connector returned ${response.status}. ${detail}` };
}

function risEscape(value) {
  return String(value ?? '').replaceAll(/\r?\n/g, ' ');
}

export function risText(paper) {
  const lines = [
    'TY  - JOUR',
    ...((paper.authors ?? []).map((author) => `AU  - ${risEscape(author.family)}, ${risEscape(author.given)}`)),
    `TI  - ${risEscape(paper.title)}`,
    `JO  - ${risEscape(paper.venue || 'arXiv e-prints')}`,
    `PY  - ${risEscape(paper.year)}`,
  ];
  if (paper.doi) lines.push(`DO  - ${risEscape(paper.doi)}`);
  if (paper.url) lines.push(`UR  - ${risEscape(paper.url)}`);
  if (paper.abstract) lines.push(`AB  - ${risEscape(paper.abstract)}`);
  if (paper.arxivId) lines.push(`N1  - arXiv:${risEscape(paper.arxivId)}`);
  lines.push('ER  - ', '');
  return lines.join('\n');
}

/** Write a RIS citation file next to the paper PDF. Returns the path. */
export function writeRis(paper, papersDir) {
  const target = join(papersDir, `${slugify(paper.title)}.ris`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, risText(paper), 'utf8');
  return target;
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
}
