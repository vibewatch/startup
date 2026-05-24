#!/usr/bin/env node
// Batch-mode contract check: walks every reports/<runId>/ folder, filters to
// finalized v2 reports, and runs check-report's per-folder validation on
// each. Used by `npm run check:reports-contract`.
//
// Historical reports are run in contract mode (schema / renderer / reference
// checks only) — content-quality gates added after a report shipped are not
// retroactively enforced here.
//
// Incremental: each folder's SHA-1 (CHECK_VERSION + sorted *.yaml filenames
// + raw bytes) is persisted in .cache/check-reports.json on full success.
// Reports whose digest still matches the cache are skipped. We only persist
// when every checked report passes, so any failure forces a re-check next
// run. Bump CHECK_VERSION when validation rules change; set
// CHECK_REPORT_NO_CACHE=1 to bypass the cache.
//
// Usage:
//   node .agents/skills/startup-research/scripts/check-reports.mjs
//   node .agents/skills/startup-research/scripts/check-reports.mjs --format json
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkRun } from './check-report.mjs';
import { EXIT, FINAL_ARTIFACTS, isFinalizedReportFolder, isRunId, listDirs } from './utils.mjs';
import { validationEnvelope, validationIssue } from './contracts/validation-result.mjs';

const REPORTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../reports');
const REPO_ROOT = resolve(REPORTS_DIR, '..');
const CACHE_FILE = join(REPO_ROOT, '.cache', 'check-reports.json');
// Bump when check-report's validation rules change so cached digests
// invalidate everywhere.
const CHECK_VERSION = '1';
const USE_CACHE = process.env.CHECK_REPORT_NO_CACHE !== '1';
const SUMMARY_CARD_FILE = FINAL_ARTIFACTS.summaryCard.file;

function usage() {
  console.error('Usage: node .agents/skills/startup-research/scripts/check-reports.mjs [--format text|json|compact]');
  process.exit(EXIT.failure);
}

function parseArgs(argv) {
  const args = { format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') args.format = argv[++i] ?? 'text';
    else if (arg === '-h' || arg === '--help') usage();
    else usage();
  }
  if (!['text', 'json', 'compact'].includes(args.format)) usage();
  return args;
}

// Digest of a finalized report folder. SHA-1 over CHECK_VERSION + each
// sorted *.yaml filename + its raw bytes. Captures both the published
// artifacts and the per-report .workflow-snapshot.yaml (it lives in the
// folder), so any change that should re-trigger a check shows up here.
function folderDigest(dir) {
  const hash = createHash('sha1').update(CHECK_VERSION).update('\0');
  let entries;
  try { entries = readdirSync(dir).sort(); } catch (err) {
    console.warn(`[check:reports] could not read directory ${dir}: ${err.message}`);
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.yaml')) continue;
    hash.update(name).update('\0');
    try { hash.update(readFileSync(join(dir, name))); } catch (err) {
      console.warn(`[check:reports] could not read ${join(dir, name)}: ${err.message}`);
      hash.update('<<unreadable>>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function loadCache() {
  if (!USE_CACHE) return {};
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (raw?.version === CHECK_VERSION && raw.folders && typeof raw.folders === 'object') return raw.folders;
    console.warn(`[check:reports] cache version mismatch or invalid structure; re-validating all reports.`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[check:reports] could not load cache (${err.code ?? err.message}); re-validating all reports.`);
    }
  }
  return {};
}

function saveCache(folders) {
  if (!USE_CACHE) return;
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ version: CHECK_VERSION, folders }, null, 2));
  } catch (e) {
    console.warn(`[check:reports] could not persist cache: ${e.message}`);
  }
}

function sweepAll(args) {
  const collected = [];
  let passCount = 0;
  let cacheHits = 0;
  const cached = loadCache();
  const nextDigests = {};
  for (const runId of listDirs(REPORTS_DIR).sort()) {
    if (!isRunId(runId)) continue;
    const folder = join(REPORTS_DIR, runId);
    if (!isFinalizedReportFolder(folder)) continue;
    const digest = folderDigest(folder);
    if (digest && cached[runId] === digest) {
      cacheHits += 1;
      passCount += 1;
      nextDigests[runId] = digest;
      continue;
    }
    const { checked, failures: runFailures } = checkRun(runId, { contentGates: false });
    if (checked && runFailures.length === 0) {
      passCount += 1;
      if (digest) nextDigests[runId] = digest;
    } else {
      collected.push({ runId, checked, failures: runFailures });
    }
  }
  if (collected.length) {
    if (args.format === 'json') {
      const result = validationEnvelope({
        ok: false,
        validator: 'check-reports',
        issues: collected.flatMap(({ runId, failures: list }) => list.map((entry) => validationIssue({
          path: entry.path ?? String(entry.message).split(':')[0] ?? runId,
          message: entry.message,
          dimension: entry.dimension ?? 'reportContract',
          code: entry.code ?? 'checkReport.failure',
          fix: entry.fix ?? 'Fix the reported artifact, then rerun check-reports.mjs.',
        }))),
        summary: { mode: 'contract', checkedReports: passCount + collected.length, failedReports: collected.length },
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error('[check:reports] failures across reports:');
      for (const { runId, failures: list, checked } of collected) {
        console.error(`\n--- ${runId} ---`);
        if (!checked) {
          console.error(`  - ${runId}: not a finalized v2 report (no ${SUMMARY_CARD_FILE})`);
        }
        for (const entry of list) console.error(`  - ${entry.message}`);
      }
    }
    // Don't persist the cache: we want failed folders re-checked next run.
    return EXIT.failure;
  }
  saveCache(nextDigests);
  const reused = cacheHits;
  const checked = passCount - reused;
  if (args.format === 'json') {
    const result = validationEnvelope({
      ok: true,
      validator: 'check-reports',
      summary: { mode: 'contract', checkedReports: passCount, reCheckedReports: checked, cachedReports: reused },
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[check:reports] ✓ ${passCount} finalized report(s); contract checks passed (${checked} re-checked, ${reused} cached).`);
  }
  return EXIT.ok;
}

try {
  const args = parseArgs(process.argv.slice(2));
  process.exit(sweepAll(args));
} catch (err) {
  console.error(`[check:reports] fatal error: ${err.message}`);
  process.exit(EXIT.failure);
}
