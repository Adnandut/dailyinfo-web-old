# dailyinfo-web

DailyInfo public web portal — a static publication site built with [Astro](https://astro.build).

**Live deployments**

| Site | URL |
| --- | --- |
| Upstream (iHeadWater) | <https://iheadwater.github.io/dailyinfo-web/> |
| This fork (auto-deploys daily with the English edition) | <https://adnandut.github.io/dailyinfo-web/> |
| English edition (`/en/`) | <https://adnandut.github.io/dailyinfo-web/en/> |
| **Agent web UI (local)** | <http://127.0.0.1:4323> — run `npm run agent-ui` |

This repository **contains no backend code**: no Python, database, SSR, API routes, or
serverless functions. The whole site is generated at build time from content files into
static HTML / CSS / XML. (The agent web UI is a local-only development tool, not part of
the deployed site — see [DailyInfo Bot & Agent](#dailyinfo-bot--agent).)

## Relationship with dailyinfo

| Repository | Responsibility |
| --- | --- |
| `dailyinfo` (backend) | collect → normalize → deduplicate → retrieval/filtering → LLM summarization → publication generation |
| `dailyinfo-web` (this repo) | publication → schema validation → Astro static pages → RSS → sitemap → GitHub Pages |

Long-term architecture:

```text
DailyInfo Core
      ↓
Canonical Publication
      ↓
WebPublisher (Phase 2D)
      ↓
dailyinfo-web (this repo)
      ↓
Astro Build
      ↓
GitHub Pages
```

**Phase 2D boundary**: production content is only accepted under
`src/content/items/generated/` and `src/content/briefings/generated/`, managed by the
DailyInfo WebPublisher. Synthetic demo content lives in `tests/fixtures/content/` and is
validated through `npm run validate -- --fixtures` and the contract tests; it never mixes
into the production site.

## Technical architecture

- **Astro 5** (`output: 'static'`) + TypeScript (strict)
- **Astro Content Collections** (glob loader) carry all content
- **Zod schema** (via `astro/zod`) performs build-time contract validation, fail-closed
- **@astrojs/rss** generates global and per-category feeds; **@astrojs/sitemap** generates the sitemap
- **rehype-sanitize** sanitizes Briefing Markdown; arbitrary raw HTML is forbidden
- Zero UI frameworks (no React/Vue/Svelte); the only client-side JS is the theme toggle (localStorage)

## Requirements

- Node.js **≥ 22.18** (scripts import TS directly, relying on Node's built-in type stripping)
- Package manager: **npm** (`package-lock.json` is authoritative)

## Install and local development

```bash
npm install
npm run dev        # http://localhost:4321/dailyinfo-web/
```

Other commands:

```bash
npm run validate     # standalone content validation (fail-closed, first CI gate)
npm run test         # contract regression tests (identity/URL/GUID/integrity + Astro cache probes)
npm run check        # astro check (Astro + TypeScript)
npm run build        # production build to dist/, and validates the artifact's base path
npm run verify-build # validate an existing dist/ artifact on its own
npm run preview      # serve dist/ locally
npm run ci           # validate + test + check + build (full local gate)
```

The production build needs no Python, database, network APIs, or secrets.

### Local development notes

- The production configuration uses `SITE_BASE=/dailyinfo-web`; visit
  <http://localhost:4321/dailyinfo-web/> locally. When switching to a custom domain,
  set `SITE_ORIGIN=https://daily.iheadwater.org` and `SITE_BASE=/`; business routes and
  Item identity need no changes.
- **Astro content cache**: the contract tests keep a cache-behavior probe; production
  `npm run build` uses `astro build --force` so freshly written or removed generated
  content is always re-synced and re-validated by WebPublisher.
- **Telemetry**: Astro disables telemetry automatically in CI. No configuration needed
  for normal local development; only in restricted sandboxes set
  `export ASTRO_TELEMETRY_DISABLED=1`.

## Content model and contracts (frozen)

> **Canonical contract document: [docs/contracts/publication-v1.md](docs/contracts/publication-v1.md)**
> It is the cross-repository interface contract (identity, URLs, RSS GUIDs, immutable
> fields, validation responsibilities, Phase 2 producer requirements). The section below
> is an overview only.

Two core concepts, strictly separated:

- **Item** — the smallest independently shareable intelligence unit (paper / project /
  news / resource). Identity is the stable `id`, **never** derived from title, hash, or
  filename.
- **Briefing** — the day's digest for one category, referencing Items by `item_ids`
  (a list of stable IDs).

### Category contract

Canonical definition lives only in [`src/lib/categories.ts`](src/lib/categories.ts):

| Internal ID | Public URL |
| --- | --- |
| `papers` | `/papers/` |
| `ai_news` | `/ai-news/` |
| `code` | `/code/` |
| `resource` | `/resource/` |
| `arxiv` | `/arxiv/` |

Adding a category = adding one entry in that file; routes, navigation, feeds, sitemap,
and the archive all follow automatically — no other file changes required.

### Schema

See [`src/lib/schemas.ts`](src/lib/schemas.ts) (zod, `.strict()` rejects unknown
fields). Key points:

- Item: `schema_version` (must be 1), `id`, `category`, `title`, `source{name,url,external_id?}`,
  `authors[]`, `source_published_at` (reliable source time or explicit `null`),
  `retrieved_at`, `published_at`, `updated_at?`, `summary`, `why_it_matters?` (may be
  explicit `null`), `tags[]`, `language`, `briefing_ids[]`
- Briefing: `schema_version`, `id` (must equal `{category}-{date}`), `category`, `date`,
  `title`, `generated_at`, `published_at`, `updated_at?`, `item_ids[]`; the Markdown body
  is the digest itself

### URL contract

```text
/                                    homepage (latest available date derived from content)
/{category}/                         category page (published_at DESC)
/archive/                            archive
/daily/{YYYY-MM-DD}/                 all briefings for a date
/daily/{YYYY-MM-DD}/{category}/      a single Briefing
/{category}/{item-id}/               Item permalink (stable ID)
```

The Item URL is determined only by `category + id`; title changes never change the URL.

Deployment URLs come in three layers and must not be mixed in business code:

- **Logical route**: `/papers/openreview-example-001/` — business routing and
  publication identity only.
- **Browser href**: `/dailyinfo-web/papers/openreview-example-001/` — `withBase()` adds
  the current deployment base to the logical route.
- **Absolute public URL**: `https://iheadwater.github.io/dailyinfo-web/papers/openreview-example-001/`
  — generated by `absoluteUrl()` for canonical, `og:url`, RSS link/GUID, robots, and sitemap.

Deployment configuration is centralized in [`src/lib/site.ts`](src/lib/site.ts).
This fork deploys with `SITE_ORIGIN=https://adnandut.github.io`,
`SITE_BASE=/dailyinfo-web` (set owner-aware in the deploy workflow).

## DailyInfo Bot & Agent

An optional local assistant (not part of the deployed site) built on top of this repo:

```bash
npm run bot            # interactive CLI
npm run agent-ui       # web UI → http://127.0.0.1:4323
```

| Command (CLI or web UI) | What it does |
| --- | --- |
| `update` | pull the newest upstream content, then translate every briefing day not yet cached |
| `translate [date] [category]` | English edition of a day's briefings (cached under `runtime/bot-cache/`) |
| `ask <question>` | Q&A over the local corpus, answered in English with citations |
| `fetch <query \| url \| doi>` | **paper agent**: search the web (arXiv / Semantic Scholar / Crossref / Unpaywall), download the open-access PDF, extract text, produce a structured summary (Problem / Method / Key results / Limitations / Why it matters) |
| `summarize <pdf>` | summarize a PDF from `runtime/papers/` (drop paywalled PDFs there manually) |
| `zotero` / `ris` | save the last fetched paper to your Zotero library (local connector) / write a `.ris` citation file for Mendeley |

Notes:

- Requires an LLM key in `.env` (gitignored): `GEMINI_API_KEY` (recommended, largest free
  tier), `OPENROUTER_API_KEY`, or `GLM_API_KEY`. Optional: `BOT_MODEL`,
  `BOT_FALLBACK_MODELS`, `UNI_EZPROXY_URL` (one-click university access links for
  paywalled papers), `UNPAYWALL_EMAIL`.
- Zotero saving uses the **local connector** (`localhost:23119`) — the same endpoint as
  the Zotero browser plugin; the desktop app must be running. Mendeley has no public
  API, so it receives a `.ris` file instead (drag onto the window to import).
- Saving citations and university access links are **explicit, per-paper actions** —
  nothing is saved or opened automatically.
- The English edition is rendered at `/en/` wherever the translation cache exists
  (locally and on this fork's deployment); on machines without it, `/en/` is empty and
  the header link is hidden. The canonical publication contract is untouched.

### Scheduled deployment (this fork — zero-touch)

The pipeline runs itself; no human commands are needed:

- **Windows scheduled task `DailyInfoUpdate`** (on the maintainer's machine): triggers at
  **07:10 / 09:30 / 12:00 / 21:00** Asia/Shanghai, plus runs on wake if a slot was missed.
  One command chain: sync the local corpus from upstream → translate new days → back up
  local `main` to origin (`--force-with-lease`) → dispatch the cloud deploy. The log
  (`runtime/update-log.txt`) carries explicit `*** WARNING ***` markers if the local sync
  ever fails to catch up.
- **GitHub Actions cron** (3 slots daily: 07:00 / 08:30 / 10:00 +08:00) + every push +
  manual dispatch: merge the newest `iHeadWater/dailyinfo-web` content → translate new
  briefing days (translation cache in Actions cache; already-cached days cost zero API
  calls) → validate → test → check → build → deploy to GitHub Pages. GitHub's own cron
  has proven unreliable on this repo, which is why the local task is the primary
  trigger and the crons are a bonus.
- Upstream publishes categories in **waves** through the morning (ai_news first, then
  arxiv/code/papers/resource); the repeated slots exist so the deployed site catches
  every wave instead of a single morning snapshot.

## Content ownership and fixtures

`src/content/items/generated/` and `src/content/briefings/generated/` are the sole
production write boundary of the WebPublisher. Paths, frontmatter, and Markdown bodies
are generated deterministically by DailyInfo; this web repo does not read the legacy
`briefings/` or `pushed/` directories.

Synthetic demo data lives in `tests/fixtures/content/` and covers 2 dates, 5 categories,
17 Items, 10 Briefings, multi-author/no-author cases, many-tags/no-tags, long titles,
mixed Chinese/English, and different sources. All entries are fictional and copy no
third-party full texts.

## Validation (fail-closed)

The shared validation core `src/lib/validate-content.ts` has a single implementation,
called by two gates (CLI and build cannot drift):

1. **`npm run validate`** (`scripts/validate-content.mjs`) — validates the production
   generated directories (always fresh) through the shared core: schema validation,
   duplicate stable IDs, Briefing ID determinism, briefing ↔ item bidirectional reference
   integrity, and category consistency. Empty directories are a valid state before first
   publication.
2. **`npm run validate -- --fixtures`** — validates the isolated synthetic fixtures and
   runs coverage checks.
3. **`npm run test`** (`scripts/contract-tests.mjs`) — contract regression tests:
   title/category changes' effect on URLs and GUIDs, schema negative cases, integrity
   negative cases, nullable source time/significance, and the `tests/refine-probe` probe
   (pins the Astro content cache behavior matrix).
4. **`astro check`** — Astro/TypeScript static checks.
5. **`astro build`** — Content Collections schema validation + the build-side integrity
   checks of the same shared core.

Validation responsibility split (Schema Validator vs Integrity Validator) and the W1-001
root cause (Astro's content cache does not re-validate unchanged entries after schema
tightening) are documented in the contract document §10.

## GitHub Pages

`.github/workflows/deploy.yml` (main branch; this fork also schedules it daily): under
explicit `SITE_ORIGIN`/`SITE_BASE` env — install → sync upstream content → translate →
validate → test → check → build (including dist artifact verification) →
`actions/deploy-pages@v4`. `.github/workflows/validate.yml` (PRs): install → validate →
test → check → build.

Repository Settings → Pages must select **GitHub Actions** as the deployment source.

## DailyInfo WebPublisher (Phase 2D)

```text
dailyinfo
  → PublicationStore (Canonical PublicationBundle)
  → WebPublisher (writes only generated/, upserts by stable identity)
  → npm run validate / test / check / build
  → dailyinfo-web (static generation and GitHub Pages)
```

WebPublisher uses a persistent local checkout, requires the target branch, origin, and
worktree to match its configuration and be clean; then fetches/fast-forwards, writes
generated files atomically, runs the full web gates, and creates one briefing-granularity
regular commit as the DailyInfo Bot. Only fast-forward pushes of the form
`git push origin main` are allowed; on failure the local publisher commit is kept and the
next run can retry safely. Web's delivery state lives in DailyInfo's `deliveries/web/`,
independent of Discord.
