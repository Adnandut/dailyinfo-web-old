#!/usr/bin/env node
/**
 * DailyInfo Agent UI — a local web interface for the bot.
 *
 *   npm run agent-ui        → http://localhost:4323
 *
 * Same engine as the CLI (scripts/dailyinfo-bot.mjs) — translate, ask,
 * fetch papers — served as a chat page. Binds to 127.0.0.1 only; no keys
 * are exposed to the page. GitHub Pages cannot host this part (it needs a
 * server for the LLM/paper fetching), so it runs on your machine.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getLastFetchedPaper } from './dailyinfo-bot.mjs';
import { pingZotero, saveToZoteroLocal, writeRis } from './zotero.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const papersDir = join(repo, 'runtime/papers');
const PORT = Number(process.env.AGENT_UI_PORT) || 4323;
const HOST = '127.0.0.1';

// Load the bot FRESH per job: the query-string import busts Node's module
// cache, so code updates and newly synced corpus days apply without
// restarting the server. (A long-lived server otherwise serves the module
// snapshot from its first import — that once fed the page stale search code.)
let botStamp = 0;
async function loadBot() {
  botStamp = Date.now();
  return import(`./dailyinfo-bot.mjs?ts=${botStamp}`);
}

async function currentCorpus() {
  const bot = await loadBot();
  return { bot, corpus: { items: bot.loadItems(), briefings: bot.loadBriefings() } };
}

// ---------------------------------------------------------------------------
// Job queue: one job at a time (LLM calls are sequential anyway). Each job
// captures its console output so the page can stream progress.
// ---------------------------------------------------------------------------
const jobs = new Map();
let jobCounter = 0;
let activeJob = null;
const queue = [];

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);

function routedWrite(original, ...args) {
  const text = String(args[0] ?? '');
  if (activeJob) activeJob.log.push(text);
  original(...args);
}

function startJob(command) {
  const job = { id: ++jobCounter, command, status: 'running', log: [], result: '', startedAt: Date.now() };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  if (activeJob || !queue.length) return;
  activeJob = queue.shift();
  const job = activeJob;
  process.stdout.write = (...args) => routedWrite(ORIGINAL_STDOUT_WRITE, ...args);
  process.stderr.write = (...args) => routedWrite(ORIGINAL_STDERR_WRITE, ...args);
  // Yield first so the caller gets its jobId before work starts.
    setTimeout(async () => {
      try {
        const { bot, corpus } = await currentCorpus();
        await bot.runCommand(corpus, job.command);
        job.status = 'done';
      } catch (error) {
        job.status = 'error';
        job.result = error.message;
      } finally {
        ORIGINAL_STDOUT_WRITE(`[agent-ui] job ${job.id} ${job.status}\n`);
        process.stdout.write = ORIGINAL_STDOUT_WRITE;
        process.stderr.write = ORIGINAL_STDERR_WRITE;
        activeJob = null;
        pump();
      }
    }, 30);
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// ---------------------------------------------------------------------------
// UI — single self-contained page
// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DailyInfo Agent</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column;
    font: 15px/1.55 system-ui, "Segoe UI", sans-serif;
    background: light-dark(#f6f7f9, #14161a); color: light-dark(#1c1f24, #e8eaee);
  }
  header { padding: 14px 22px; border-bottom: 1px solid light-dark(#e2e5ea, #2a2e35);
           display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-size: 17px; margin: 0; }
  header .tag { font-size: 12.5px; color: light-dark(#6a7280, #9aa3af); }
  header a { margin-left: auto; font-size: 13px; color: light-dark(#2b6cb0, #7fb3ff); }
  #log { flex: 1; overflow-y: auto; padding: 18px 22px; }
  .entry { max-width: 860px; margin: 0 auto 14px; }
  .you { font-weight: 600; margin-bottom: 2px; }
  .cmd { font-family: ui-monospace, Consolas, monospace; font-size: 13.5px;
         color: light-dark(#2b6cb0, #7fb3ff); word-break: break-word; }
  .out { white-space: pre-wrap; word-break: break-word; background: light-dark(#fff, #1d2026);
         border: 1px solid light-dark(#e2e5ea, #2a2e35); border-radius: 10px;
         padding: 12px 16px; margin-top: 6px; }
  .out.busy { color: light-dark(#6a7280, #9aa3af); font-style: italic; }
  .err { border-color: light-dark(#f0b4b4, #5c2a2a); background: light-dark(#fdf3f3, #2a1d1e); }
  form { display: flex; gap: 10px; padding: 14px 22px; border-top: 1px solid light-dark(#e2e5ea, #2a2e35);
         background: light-dark(#fff, #191c21); }
  form > .inner { display: flex; gap: 10px; max-width: 860px; margin: 0 auto; width: 100%; }
  select, input[type=text] {
    font: inherit; padding: 9px 12px; border-radius: 8px;
    border: 1px solid light-dark(#c9cfd8, #3a3f47);
    background: light-dark(#fff, #23262c); color: inherit;
  }
  input[type=text] { flex: 1; }
  button { font: inherit; font-weight: 600; padding: 9px 18px; border: 0; border-radius: 8px;
           cursor: pointer; background: light-dark(#2b6cb0, #2f6fce); color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .save-actions { display: flex; gap: 8px; align-items: center; max-width: 860px; margin: -4px auto 16px; }
  .save-actions button { background: light-dark(#3d7a4f, #2f7a45); padding: 6px 12px; font-size: 13px; }
  .save-actions .save-msg { font-size: 12.5px; color: light-dark(#6a7280, #9aa3af); }
  .hints { max-width: 860px; margin: 0 auto 10px; font-size: 12.5px; color: light-dark(#6a7280, #9aa3af); }
  .hints code { background: light-dark(#eceef1, #23262c); padding: 1px 6px; border-radius: 5px; }
</style>
</head>
<body>
<header>
  <h1>DailyInfo Agent</h1>
  <span class="tag" id="corpus"></span>
  <a href="http://localhost:4321/dailyinfo-web/en/" target="_blank">open /en/ site ↗</a>
</header>
<div id="log"></div>
<form id="f">
  <div class="inner">
    <select id="mode">
      <option value="ask">ask</option>
      <option value="fetch">fetch paper</option>
      <option value="search">search corpus</option>
      <option value="translate">translate day</option>
      <option value="update">update (pull + translate)</option>
    </select>
    <input type="text" id="q" placeholder='e.g. SWIFT time-series fine-tuning  |  arxiv url  |  "what is new today @latest"' autocomplete="off" />
    <button id="go">Run</button>
  </div>
</form>
<script>
  const log = document.getElementById('log');
  const f = document.getElementById('f'), q = document.getElementById('q'),
        go = document.getElementById('go'), mode = document.getElementById('mode');
  let busy = false, poll = null;

  fetch('/api/info').then(r => r.json()).then(info => {
    document.getElementById('corpus').textContent = info.corpus;
  });

  function addEntry(command) {
    const entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML = '<div class="you"><span class="cmd"></span></div><div class="out busy"></div>';
    entry.querySelector('.cmd').textContent = command;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    return entry.querySelector('.out');
  }

  function render(out, job) {
    const text = job.log.join('');
    if (job.status === 'running') {
      const lines = text.split('\\n').filter(Boolean);
      out.textContent = lines.slice(-6).join('\\n') + '\\n… working';
    } else if (job.status === 'error') {
      out.className = 'out err';
      out.textContent = text + '\\nERROR: ' + job.result;
    } else {
      out.className = 'out';
      out.textContent = text.trim() || job.result || '(no output)';
    }
    log.scrollTop = log.scrollHeight;
  }

  function addSaveActions(out) {
    if (out.parentElement.querySelector('.save-actions')) return;
    const bar = document.createElement('div');
    bar.className = 'save-actions';
    bar.innerHTML = '<button data-act="zotero" class="ghost">Save to Zotero</button>' +
                    '<button data-act="ris" class="ghost">Save .ris (Mendeley)</button>' +
                    '<span class="save-msg"></span>';
    out.parentElement.appendChild(bar);
    bar.addEventListener('click', async (e) => {
      const button = e.target.closest('button[data-act]');
      if (!button) return;
      const msg = bar.querySelector('.save-msg');
      button.disabled = true;
      msg.textContent = '…';
      try {
        const result = await fetch('/api/' + (button.dataset.act === 'zotero' ? 'zotero/save' : 'ris'),
                                   { method: 'POST' }).then(r => r.json());
        msg.textContent = result.message || (result.ok ? 'done' : 'failed');
      } catch (err) {
        msg.textContent = 'failed: ' + err.message;
      }
      button.disabled = false;
    });
  }

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) return;
    const command = mode.value === 'update'
      ? 'update'
      : (mode.value + ' ' + q.value).trim();
    if (mode.value !== 'update' && !q.value.trim()) { q.focus(); return; }
    busy = true; go.disabled = true;
    const out = addEntry(command);
    fetch('/api/job', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ command }) })
      .then(r => r.json())
      .then(({ id }) => {
        poll = setInterval(() => {
          fetch('/api/job/' + id).then(r => r.json()).then(job => {
            render(out, job);
            if (job.status !== 'running') {
              clearInterval(poll); busy = false; go.disabled = false; q.focus();
              if (job.status === 'done' && /^fetch\\b/.test(job.command)) {
                addSaveActions(out);
              }
            }
          });
        }, 1200);
      });
  });

  q.focus();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      const { bot, corpus } = await currentCorpus();
      json(res, 200, {
        corpus: `${corpus.items.length} items · ${corpus.briefings.length} briefings · ${bot.listDates(corpus.briefings).length} dates`,
        busy: Boolean(activeJob),
        queue: queue.length,
        zotero: await pingZotero(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/zotero/save') {
      const paper = getLastFetchedPaper();
      if (!paper) { json(res, 400, { ok: false, message: 'No paper fetched yet — run a fetch first.' }); return; }
      if (!(await pingZotero())) { json(res, 200, { ok: false, message: 'Zotero is not running — open the Zotero desktop app and try again.' }); return; }
      json(res, 200, await saveToZoteroLocal(paper));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ris') {
      const paper = getLastFetchedPaper();
      if (!paper) { json(res, 400, { ok: false, message: 'No paper fetched yet — run a fetch first.' }); return; }
      const path = writeRis(paper, papersDir);
      json(res, 200, { ok: true, message: `Citation file written: ${path} — drag it onto the Mendeley window.` });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/job') {
      const { command } = JSON.parse(await readBody(req));
      if (typeof command !== 'string' || !command.trim()) { json(res, 400, { error: 'empty command' }); return; }
      if (activeJob || queue.length) { json(res, 429, { error: 'another job is running — try again in a moment' }); return; }
      const job = startJob(command.trim());
      json(res, 200, { id: job.id });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/job/')) {
      const job = jobs.get(Number(url.pathname.split('/').pop()));
      if (!job) { json(res, 404, { error: 'unknown job' }); return; }
      json(res, 200, { id: job.id, status: job.status, log: job.log, result: job.result });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}).listen(PORT, HOST, async () => {
  const { corpus } = await currentCorpus();
  ORIGINAL_STDOUT_WRITE(`[agent-ui] http://${HOST}:${PORT} — corpus: ${corpus.items.length} items, ${corpus.briefings.length} briefings (hot-reloaded per job)\n`);
  ORIGINAL_STDOUT_WRITE('[agent-ui] Ctrl+C to stop. The page talks to the same engine as the CLI.\n');
});
