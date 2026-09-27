#!/usr/bin/env node
// Batch-mode translation check: walks every reports/<runId>/ folder and
// runs check-translation's per-folder validation on each. Used by
// `npm run check:translations-zh`.
//
// Incremental: each folder's SHA-1 (CHECK_VERSION + strict/requireFinal
// flags + sorted *.yaml filenames + raw bytes — covers both EN and ZH
// siblings) is persisted in .cache/check-translations.json on full success.
// Folders whose digest still matches the cache are skipped. We only persist
// when every checked folder passes, so any failure forces a re-check next
// run. Checker and whitelist source bytes automatically version the cache;
// set CHECK_TRANSLATION_NO_CACHE=1 to bypass.
//
// Usage:
//   node .agents/skills/translate-zh/scripts/check-translations.mjs [--strict] [--require-final]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkFolder, valueExcerpt } from './check-translation.mjs';

const REPORTS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', 'reports');
const REPO_ROOT = resolve(REPORTS_DIR, '..');
const CACHE_FILE = join(REPO_ROOT, '.cache', 'check-translations.json');
const CHECK_VERSION = ['check-translations.mjs', 'check-translation.mjs', 'whitelist.mjs']
  .reduce((hash, name) => hash.update(name).update('\0')
    .update(readFileSync(new URL(name, import.meta.url))).update('\0'), createHash('sha256'))
  .digest('hex');
const USE_CACHE = process.env.CHECK_TRANSLATION_NO_CACHE !== '1';

function parseArgs(argv) {
  const args = { strict: false, requireFinal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--require-final') args.requireFinal = true;
    else if (a === '-h' || a === '--help') usage(0);
    else { console.error(`unknown arg: ${a}`); usage(1); }
  }
  return args;
}

function usage(code) {
  console.error('Usage: check-translations.mjs [--strict] [--require-final]');
  process.exit(code);
}

function listReportFolders() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .map((name) => join(REPORTS_DIR, name))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
}

// Digest covers CHECK_VERSION + the strict/requireFinal flags (they change
// the diff output) + each sorted *.yaml filename + raw bytes. The wildcard
// catches both EN and ZH siblings, so editing either side re-keys the
// digest.
function folderDigest(dir, options) {
  const hash = createHash('sha1').update(CHECK_VERSION).update('\0');
  hash.update(options.strict ? 'strict' : 'lenient').update('\0');
  hash.update(options.requireFinal ? 'requireFinal' : 'optionalFinal').update('\0');
  let entries;
  try { entries = readdirSync(dir).sort(); } catch { return null; }
  for (const name of entries) {
    if (!name.endsWith('.yaml')) continue;
    hash.update(name).update('\0');
    try { hash.update(readFileSync(join(dir, name))); } catch { hash.update('<<unreadable>>'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function loadCache() {
  if (!USE_CACHE) return {};
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    if (raw?.version === CHECK_VERSION && raw.folders && typeof raw.folders === 'object') return raw.folders;
  } catch {
    // Missing or unreadable cache: fall through and re-validate everything.
  }
  return {};
}

function saveCache(folders) {
  if (!USE_CACHE) return;
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ version: CHECK_VERSION, folders }, null, 2));
  } catch (e) {
    console.warn(`[check-translations] could not persist cache: ${e.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const options = { strict: args.strict, requireFinal: args.requireFinal };
const folders = listReportFolders();
const cached = loadCache();
const nextDigests = {};
let cacheHits = 0;
let cachedPairs = 0;
let totalPairs = 0;
let totalFailures = 0;

for (const folder of folders) {
  const folderKey = folder.split('/').pop() ?? folder;
  const digest = folderDigest(folder, options);
  if (digest) nextDigests[folderKey] = { digest, pairs: 0 };
  const cachedEntry = cached[folderKey];
  if (digest && cachedEntry && cachedEntry.digest === digest) {
    cacheHits += 1;
    const reusedPairs = typeof cachedEntry.pairs === 'number' ? cachedEntry.pairs : 0;
    nextDigests[folderKey].pairs = reusedPairs;
    totalPairs += reusedPairs;
    cachedPairs += reusedPairs;
    continue;
  }
  const { pairs, failures } = checkFolder(folder, options);
  totalPairs += pairs;
  if (nextDigests[folderKey]) nextDigests[folderKey].pairs = pairs;
  if (failures.length) {
    totalFailures += failures.length;
    for (const fail of failures) {
      console.error(`FAIL ${fail.zhPath}`);
      for (const issue of fail.issues.slice(0, 20)) {
        console.error(`  - [${issue.kind}] ${issue.path || '(root)'}: ${issue.message}`);
        if ('en' in issue || 'zh' in issue) {
          console.error(`      EN: ${valueExcerpt(issue.en)}`);
          console.error(`      ZH: ${valueExcerpt(issue.zh)}`);
        }
      }
      if (fail.issues.length > 20) console.error(`  ... +${fail.issues.length - 20} more`);
    }
  }
}

if (totalFailures) {
  console.error(`[check-translations] ${totalFailures} file(s) failed across ${totalPairs} translated pair(s).`);
  // Don't persist the cache on failure.
  process.exit(1);
}
saveCache(nextDigests);
if (totalPairs === 0) {
  console.log('[check-translations] no .zh.yaml pairs found; nothing to check.');
  process.exit(0);
}
const reChecked = totalPairs - cachedPairs;
console.log(`[check-translations] \u2713 ${totalPairs} translated pair(s) verified (${reChecked} re-checked, ${cachedPairs} cached across ${cacheHits}/${folders.length} folder(s)).`);
