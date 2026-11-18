/**
 * Corpus search ranking tests for the bot (scripts/dailyinfo-bot.mjs).
 *
 * Regression guard: an item whose title exactly matches the query must rank
 * FIRST even when distractors share the query's common words (water, model,
 * balance, ...). This is the failure the "search can't find the paper I just
 * fetched" report exposed.
 *
 * Run: node scripts/dailyinfo-bot.tests.mjs   (part of npm test)
 */
import assert from 'node:assert/strict';
import { search, relevanceScore } from './dailyinfo-bot.mjs';

const QUERY = 'Testing the temporal and spatial transferability of a water balance model using a parameter learning approach';

function item(id, title, summary = 'hydrology abstract text', publishedAt = '2026-11-18T00:00:00+08:00') {
  return {
    kind: 'item',
    id,
    category: 'papers',
    title,
    summary,
    why: '',
    tags: [],
    source: '',
    sourceUrl: '',
    publishedAt,
    path: `test/${id}`,
  };
}

const corpus = {
  items: [
    item('target', 'Testing the temporal and spatial transferability of a water balance model using a parameter learning approach'),
    // Distractors share many common tokens (water/model/balance/spatial/...)
    // but not the distinctive ones (transferability, parameter learning).
    item('distractor-hydrogcn', 'HydroGCN: A Graph Neural Network surrogate of a shallow-water model for floodplain water-depth prediction'),
    item('distractor-meltwater', 'Future meltwater dynamics and water balance components under climate warming and land use change in a cryosphere-dominated basin'),
    item('distractor-sociohydro', 'Exploring the mutual interactions among population, income and water resource availability using a coupled socio-hydrological model'),
    item('distractor-rainfall', 'Spatiotemporal dynamics and teleconnection associations of extreme precipitation in China at the twenty-four solar terms scale'),
    item('distractor-flood', 'Data-Driven Pluvial Flood Modeling for Urban Regions: An Investigation of Spatial Generalizability'),
  ],
  briefings: [],
};

let passed = 0;

{
  const results = search(corpus, QUERY);
  assert.ok(results.length > 0, 'search returns matches');
  assert.equal(results[0].id, 'target', 'the exact-title item ranks FIRST');
  passed += 1;
}
{
  const target = corpus.items[0];
  const score = relevanceScore(target, QUERY);
  assert.ok(score >= 0.99, `exact title scores ~100% (got ${Math.round(score * 100)}%)`);
  passed += 1;
}
{
  // The gates (fetch auto-pick, corpus fallback) must reject weak matches:
  // a distractor sharing only common words stays far below the threshold.
  const weak = relevanceScore(corpus.items[1], QUERY);
  assert.ok(weak < 0.55, `common-word overlap stays below the 55% gate (got ${Math.round(weak * 100)}%)`);
  passed += 1;
}
{
  // Query for something absent: no crashes, and no false "exact" ordering.
  const results = search(corpus, 'quantum chromodynamics jet tomography');
  assert.ok(!results.some((entry) => entry.id === 'target'), 'unrelated query does not return the target first');
  passed += 1;
}

console.log(`[dailyinfo-bot tests] ${passed}/${passed} passed`);
