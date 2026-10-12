#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const httpUrl = value => typeof value === 'string' && URL.canParse(value)
  && ['http:', 'https:'].includes(new URL(value).protocol);

export function checkNoEligibleCandidates(folder) {
  const review = JSON.parse(readFileSync(join(folder, 'candidate-review.json'), 'utf8'));
  assert.equal(review.schemaVersion, 'unicorn-candidate-review-v1', 'Missing candidate review schema');
  assert.equal(review.status, 'no-eligible-candidates', 'Discovery did not confirm a no-candidate outcome');
  assert(nonEmpty(review.outcome), 'Missing discovery outcome explanation');
  assert(Array.isArray(review.searches), 'Missing reviewed searches');
  assert(Array.isArray(review.decisions), 'Missing candidate decisions');
  for (const decision of review.decisions) {
    assert(nonEmpty(decision.company) && (decision.website === null || httpUrl(decision.website))
      && decision.decision === 'reject' && nonEmpty(decision.reason)
      && Array.isArray(decision.sourceUrls) && decision.sourceUrls.length > 0
      && decision.sourceUrls.every(httpUrl), `Incomplete or unresolved candidate decision: ${decision.company ?? '(unnamed)'}`);
  }
  const searches = new Map();
  for (const search of review.searches) {
    assert(nonEmpty(search.query) && nonEmpty(search.provider) && nonEmpty(search.result),
      'Incomplete search review');
    searches.set(search.query.trim(), search);
  }
  const successfulQueries = new Set();
  let resultCount = 0;
  const cache = join(folder, 'search-results');
  for (const file of readdirSync(cache).filter(file => file.endsWith('.json'))) {
    const result = JSON.parse(readFileSync(join(cache, file), 'utf8'));
    assert(result.schemaVersion === 'startup-search-result-v1'
      && nonEmpty(result.query) && nonEmpty(result.provider)
      && Number.isFinite(Date.parse(result.fetchedAt))
      && Array.isArray(result.results) && result.results.every(item => httpUrl(item.url)),
      `Invalid repository search evidence: ${file}`);
    const search = searches.get(result.query.trim());
    if (search?.provider === result.provider) {
      successfulQueries.add(result.query.trim());
      resultCount += result.results.length;
    }
  }
  assert(successfulQueries.size >= 3, 'No-candidate outcome requires at least three distinct successful reviewed searches');
  assert(resultCount > 0, 'Discovery returned no source URLs; search availability is not established');
  assert([...searches.keys()].every(query => successfulQueries.has(query)),
    'Reviewed searches lack successful repository search evidence');
  return { outcome: review.outcome.trim(), searchCount: successfulQueries.size, candidateCount: review.decisions.length };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 3, 'Usage: check-unicorn-discovery.mjs <discovery-folder>');
    const result = checkNoEligibleCandidates(process.argv[2]);
    console.log(`[unicorn-discovery] No eligible candidates after ${result.searchCount} reviewed searches and ${result.candidateCount} rejected candidates: ${result.outcome}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `\n### Discovery outcome\nNo eligible new candidates; no reports were generated or published.\n\n${result.outcome}\n\nReviewed searches: ${result.searchCount}. Rejected candidates: ${result.candidateCount}.\n`);
    }
  } catch (error) {
    console.error(`[unicorn-discovery] ${error.message}`);
    process.exitCode = 1;
  }
}
