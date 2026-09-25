#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { checkPairQuality, editorialQualityImproved } from './check-translation-quality.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const scriptsDir = resolve(repoRoot, '.agents', 'skills', 'translate-zh', 'scripts');
const FULL_SPLIT_MAX_CHARS = '45000';
const FULL_SPLIT_MAX_ITEMS = '300';

function usage(code = 0) {
  console.error('Usage: run-translation.mjs <command> <runId-or-company-name> [--keep-cache] [--force]');
  console.error('');
  console.error('Commands:');
  console.error('  preflight         Validate repo, dependency, report, and cache paths');
  console.error('  init              Export summary/full bundles and split full-report into parts');
  console.error('  repair-init       Seed bundles from existing zh overlays and record baseline quality');
  console.error('  editor-init       Checkpoint validated overlays and seed a full source-anchored editorial pass');
  console.error('  editor-accept     Strictly validate and accept the editorial pass');
  console.error('  editor-restore    Restore the validated draft after an editorial regression');
  console.error('  lint-parts        Validate translated full-report parts without writing outputs');
  console.error('  finalize-summary  Import/apply/check summary-card.zh.yaml');
  console.error('  finalize-full     Merge parts when present, import/apply/check full-report.zh.yaml');
  console.error('  measure           Record current quality and compare it with repair baseline');
  console.error('  verify            Strictly verify final summary/full zh overlays');
  console.error('  cleanup           Delete .translate-cache/<runId>');
  console.error('');
  console.error('Examples:');
  console.error('  node .agents/skills/translate-zh/scripts/run-translation.mjs init 20260504115542-thinking-machines');
  console.error('  node .agents/skills/translate-zh/scripts/run-translation.mjs finalize-full 20260504115542-thinking-machines');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { command: null, runId: null, keepCache: false, force: false, skipQuality: false };
  for (const arg of argv) {
    if (arg === '--keep-cache') args.keepCache = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--skip-quality') args.skipQuality = true;
    else if (arg === '-h' || arg === '--help') usage(0);
    else if (!args.command) args.command = arg;
    else if (!args.runId) args.runId = arg;
    else usage(1);
  }
  if (!args.command || !args.runId) usage(1);
  return args;
}

function fail(message) {
  console.error(`[translate-zh] ${message}`);
  process.exit(1);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function isNonEmptyDir(path) {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listReportDirs() {
  const reportsDir = resolve(repoRoot, 'reports');
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => {
      try {
        return statSync(join(reportsDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function resolveRunId(input) {
  const raw = input.trim();
  if (!raw || raw.includes('/') || raw.includes('\\') || raw === '.' || raw === '..') {
    fail(`invalid report identifier: ${JSON.stringify(input)}`);
  }

  const exactPath = resolve(repoRoot, 'reports', raw);
  if (existsSync(exactPath) && statSync(exactPath).isDirectory()) return basename(exactPath);

  const slug = slugify(raw);
  if (!slug) fail(`invalid report identifier: ${JSON.stringify(input)}`);

  const matches = listReportDirs().filter((name) => name === slug || name.endsWith(`-${slug}`) || name.includes(slug));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail(`ambiguous report identifier ${JSON.stringify(input)}; matches: ${matches.slice(0, 10).join(', ')}`);
  }
  fail(`report folder not found for ${JSON.stringify(input)}`);
}

function pathsFor(input) {
  const runId = resolveRunId(input);
  const reportDir = resolve(repoRoot, 'reports', runId);
  const cacheDir = resolve(repoRoot, '.translate-cache', runId);
  return {
    runId,
    reportDir,
    cacheDir,
    partsDir: join(cacheDir, 'parts'),
    summarySource: join(reportDir, 'summary-card.yaml'),
    fullSource: join(reportDir, 'full-report.yaml'),
    summaryBundle: join(cacheDir, 'summary-card.translate.yaml'),
    fullBundle: join(cacheDir, 'full-report.translate.yaml'),
    summaryJson: join(cacheDir, 'summary-card.zh.json'),
    fullJson: join(cacheDir, 'full-report.zh.json'),
    qualityBefore: join(cacheDir, 'quality.before.json'),
    qualityAfter: join(cacheDir, 'quality.after.json'),
    editorFindings: join(cacheDir, 'editor-findings.json'),
    checkpointDir: join(cacheDir, 'validated-draft'),
    summaryCheckpoint: join(cacheDir, 'validated-draft', 'summary-card.zh.yaml'),
    fullCheckpoint: join(cacheDir, 'validated-draft', 'full-report.zh.yaml'),
    summaryOut: join(reportDir, 'summary-card.zh.yaml'),
    fullOut: join(reportDir, 'full-report.zh.yaml'),
  };
}

function loadYaml(path) {
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
}

function seedExistingText(bundle, translated) {
  if (typeof bundle === 'string') {
    return typeof translated === 'string' && translated.trim() ? translated : bundle;
  }
  if (Array.isArray(bundle)) {
    return bundle.map((value, index) => seedExistingText(value, translated?.[index]));
  }
  if (bundle && typeof bundle === 'object') {
    return Object.fromEntries(Object.entries(bundle).map(([key, value]) => [
      key, seedExistingText(value, translated?.[key]),
    ]));
  }
  return bundle;
}

function qualityFor(paths, options = {}) {
  const findings = [];
  for (const [artifact, sourcePath, targetPath] of [
    ['summary-card', paths.summarySource, paths.summaryOut],
    ['full-report', paths.fullSource, paths.fullOut],
  ]) {
    if (!existsSync(targetPath)) continue;
    for (const issue of checkPairQuality(loadYaml(sourcePath), loadYaml(targetPath), options)) {
      findings.push({ artifact, ...issue });
    }
  }
  const errorCount = findings.filter((finding) => finding.severity === 'error').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  return {
    schemaVersion: 'translation-repair-quality-v1',
    runId: paths.runId,
    measuredAt: new Date().toISOString(),
    errorCount,
    warningCount,
    hardPass: errorCount === 0,
    findings,
  };
}

function writeQuality(path, quality) {
  writeFileSync(path, `${JSON.stringify(quality, null, 2)}\n`, 'utf8');
}

function ensurePreflight(runId) {
  const paths = pathsFor(runId);
  if (!existsSync(repoRoot)) fail(`repo root not found: ${repoRoot}`);
  if (!existsSync(join(repoRoot, 'package.json'))) fail('package.json not found at repo root');
  if (!existsSync(join(repoRoot, 'node_modules', 'js-yaml'))) {
    fail('missing dependency js-yaml; run npm install at the repo root first');
  }
  if (!existsSync(paths.reportDir)) fail(`report folder not found: reports/${runId}`);
  if (!existsSync(paths.summarySource)) fail(`missing source file: reports/${runId}/summary-card.yaml`);
  if (!existsSync(paths.fullSource)) fail(`missing source file: reports/${runId}/full-report.yaml`);
  return paths;
}

function runNodeScript(scriptName, args) {
  const scriptPath = resolve(scriptsDir, scriptName);
  const child = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (child.status !== 0) {
    fail(`${scriptName} failed with exit code ${child.status ?? 'unknown'}`);
  }
}

function preflight(runId) {
  const paths = ensurePreflight(runId);
  console.log('[translate-zh] preflight ok');
  console.log(`[translate-zh] repo: ${repoRoot}`);
  console.log(`[translate-zh] report: ${relative(repoRoot, paths.reportDir)}`);
  console.log(`[translate-zh] cache: ${relative(repoRoot, paths.cacheDir)}`);
}

function init(runId, options = {}) {
  const paths = ensurePreflight(runId);
  if (isNonEmptyDir(paths.cacheDir)) {
    if (!options.force) {
      fail(`cache is not empty: ${relative(repoRoot, paths.cacheDir)}; run cleanup first or pass --force to discard it`);
    }
    cleanup(paths.runId);
  }
  ensureDir(paths.cacheDir);
  ensureDir(paths.partsDir);
  runNodeScript('bundle-translatable.mjs', ['export', paths.summarySource, '--out', paths.summaryBundle]);
  runNodeScript('bundle-translatable.mjs', ['export', paths.fullSource, '--out', paths.fullBundle]);
  runNodeScript('bundle-translatable.mjs', ['split', paths.fullBundle, '--out-dir', paths.partsDir, '--max-chars', FULL_SPLIT_MAX_CHARS, '--max-items', FULL_SPLIT_MAX_ITEMS]);
  console.log('[translate-zh] init complete');
  console.log(`[translate-zh] edit summary bundle: ${relative(repoRoot, paths.summaryBundle)}`);
  console.log(`[translate-zh] edit full-report parts under: ${relative(repoRoot, paths.partsDir)}`);
}

function repairInit(runId, options = {}) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryOut) || !existsSync(paths.fullOut)) {
    fail(`existing zh overlays are required for repair: reports/${paths.runId}`);
  }
  if (isNonEmptyDir(paths.cacheDir)) {
    if (!options.force) {
      fail(`cache is not empty: ${relative(repoRoot, paths.cacheDir)}; run cleanup first or pass --force to discard it`);
    }
    cleanup(paths.runId);
  }
  ensureDir(paths.cacheDir);
  ensureDir(paths.partsDir);
  for (const [source, translated, bundle] of [
    [paths.summarySource, paths.summaryOut, paths.summaryBundle],
    [paths.fullSource, paths.fullOut, paths.fullBundle],
  ]) {
    runNodeScript('bundle-translatable.mjs', ['export', source, '--out', bundle]);
    const seeded = seedExistingText(loadYaml(bundle), loadYaml(translated));
    writeFileSync(bundle, yaml.dump(seeded, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
  }
  runNodeScript('bundle-translatable.mjs', ['split', paths.fullBundle, '--out-dir', paths.partsDir, '--max-chars', FULL_SPLIT_MAX_CHARS, '--max-items', FULL_SPLIT_MAX_ITEMS]);
  const baseline = qualityFor(paths);
  writeQuality(paths.qualityBefore, baseline);
  console.log(`[translate-zh] repair baseline: ${baseline.errorCount} error(s), ${baseline.warningCount} warning(s)`);
  for (const finding of baseline.findings.filter((finding) => finding.severity === 'error')) {
    console.log(`[translate-zh] target ${finding.artifact}:${finding.path} (${finding.code})`);
  }
  console.log(`[translate-zh] baseline: ${relative(repoRoot, paths.qualityBefore)}`);
  console.log(`[translate-zh] edit summary bundle: ${relative(repoRoot, paths.summaryBundle)}`);
  console.log(`[translate-zh] edit only targeted leaves in full-report parts under: ${relative(repoRoot, paths.partsDir)}`);
}

function editorInit(runId, options = {}) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryOut) || !existsSync(paths.fullOut)) {
    fail(`existing zh overlays are required for editing: reports/${paths.runId}`);
  }
  runNodeScript('check-translation.mjs', [paths.reportDir, '--strict', '--require-final']);
  runNodeScript('check-translation-quality.mjs', [paths.summarySource, paths.summaryOut]);
  runNodeScript('check-translation-quality.mjs', [paths.fullSource, paths.fullOut]);
  repairInit(runId, options);
  ensureDir(paths.checkpointDir);
  copyFileSync(paths.summaryOut, paths.summaryCheckpoint);
  copyFileSync(paths.fullOut, paths.fullCheckpoint);
  console.log(`[translate-zh] validated draft checkpoint: ${relative(repoRoot, paths.checkpointDir)}`);
  console.log('[translate-zh] editorial scope: compare every cached Chinese leaf with its English source and rewrite awkward prose source-first');
}

function editorAccept(runId) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryCheckpoint) || !existsSync(paths.fullCheckpoint)) {
    fail(`validated draft checkpoint is missing: ${relative(repoRoot, paths.checkpointDir)}`);
  }
  const strictQuality = qualityFor(paths, { strictEditor: true });
  writeQuality(paths.editorFindings, strictQuality);
  runNodeScript('check-translation.mjs', [paths.reportDir, '--strict', '--require-final']);
  if (strictQuality.errorCount !== 0) {
    for (const finding of strictQuality.findings.filter((finding) => finding.severity === 'error')) {
      console.error(`[translate-zh] strict ${finding.artifact}:${finding.path} (${finding.code}): ${finding.message}`);
    }
    console.error(`[translate-zh] complete strict findings: ${relative(repoRoot, paths.editorFindings)}`);
    fail(`editorial pass has ${strictQuality.errorCount} strict error(s)`);
  }
  const baseline = JSON.parse(readFileSync(paths.qualityBefore, 'utf8'));
  const quality = qualityFor(paths);
  writeQuality(paths.qualityAfter, quality);
  if (!editorialQualityImproved(baseline, quality)) {
    fail(`editorial advisories did not improve: ${baseline.warningCount} -> ${quality.warningCount}`);
  }
  console.log(`[translate-zh] editorial advisories ${baseline.warningCount} -> ${quality.warningCount}`);
  cleanup(runId);
  console.log('[translate-zh] editorial pass accepted');
}

function editorRestore(runId) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryCheckpoint) || !existsSync(paths.fullCheckpoint)) {
    fail(`validated draft checkpoint is missing: ${relative(repoRoot, paths.checkpointDir)}`);
  }
  copyFileSync(paths.summaryCheckpoint, paths.summaryOut);
  copyFileSync(paths.fullCheckpoint, paths.fullOut);
  runNodeScript('check-translation.mjs', [paths.reportDir, '--strict', '--require-final']);
  runNodeScript('check-translation-quality.mjs', [paths.summarySource, paths.summaryOut]);
  runNodeScript('check-translation-quality.mjs', [paths.fullSource, paths.fullOut]);
  cleanup(runId);
  console.log('[translate-zh] editorial pass rolled back to the validated draft');
}

function lintParts(runId) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.partsDir)) {
    fail(`parts directory not found: ${relative(repoRoot, paths.partsDir)}; run init first`);
  }
  runNodeScript('check-part-leaf-counts.mjs', [paths.partsDir]);
  console.log('[translate-zh] full-report parts linted');
}

function finalizeSummary(runId, { skipQuality = false } = {}) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryBundle)) {
    fail(`summary bundle not found: ${relative(repoRoot, paths.summaryBundle)}; run init first`);
  }
  runNodeScript('bundle-translatable.mjs', ['import', paths.summarySource, paths.summaryBundle, '--out', paths.summaryJson]);
  runNodeScript('apply-translation.mjs', [paths.summarySource, paths.summaryJson, '--out', paths.summaryOut]);
  runNodeScript('check-translation.mjs', [paths.reportDir, ...(skipQuality ? [] : ['--strict'])]);
  if (!skipQuality) runNodeScript('check-translation-quality.mjs', [paths.summarySource, paths.summaryOut]);
  console.log('[translate-zh] summary finalized');
}

function finalizeFull(runId, { keepCache = false, skipQuality = false } = {}) {
  const paths = ensurePreflight(runId);
  if (isNonEmptyDir(paths.partsDir)) {
    runNodeScript('check-part-leaf-counts.mjs', [paths.partsDir]);
    const partFiles = readdirSync(paths.partsDir)
      .filter((name) => /^part\.\d+\.yaml$/.test(name))
      .sort()
      .map((name) => join(paths.partsDir, name));
    if (!partFiles.length) fail(`parts directory is present but empty: ${relative(repoRoot, paths.partsDir)}`);
    runNodeScript('bundle-translatable.mjs', ['merge', ...partFiles, '--out', paths.fullBundle]);
  }
  if (!existsSync(paths.fullBundle)) {
    fail(`full bundle not found: ${relative(repoRoot, paths.fullBundle)}; run init first`);
  }
  runNodeScript('bundle-translatable.mjs', ['import', paths.fullSource, paths.fullBundle, '--out', paths.fullJson]);
  runNodeScript('apply-translation.mjs', [paths.fullSource, paths.fullJson, '--out', paths.fullOut]);
  runNodeScript('check-translation.mjs', [paths.reportDir, ...(skipQuality ? [] : ['--strict']), '--require-final']);
  if (!skipQuality) {
    runNodeScript('check-translation-quality.mjs', [paths.summarySource, paths.summaryOut]);
    runNodeScript('check-translation-quality.mjs', [paths.fullSource, paths.fullOut]);
  }
  if (!keepCache) cleanup(runId);
  console.log('[translate-zh] full report finalized');
}

function verify(runId) {
  const paths = ensurePreflight(runId);
  runNodeScript('check-translation.mjs', [paths.reportDir, '--strict', '--require-final']);
  console.log('[translate-zh] final overlays verified');
}

function measure(runId) {
  const paths = ensurePreflight(runId);
  if (!existsSync(paths.summaryOut) || !existsSync(paths.fullOut)) {
    fail(`final zh overlays are required for measurement: reports/${paths.runId}`);
  }
  ensureDir(paths.cacheDir);
  const current = qualityFor(paths);
  writeQuality(paths.qualityAfter, current);
  if (existsSync(paths.qualityBefore)) {
    const before = JSON.parse(readFileSync(paths.qualityBefore, 'utf8'));
    console.log(`[translate-zh] quality errors ${before.errorCount} -> ${current.errorCount} (${current.errorCount - before.errorCount >= 0 ? '+' : ''}${current.errorCount - before.errorCount})`);
    console.log(`[translate-zh] quality warnings ${before.warningCount} -> ${current.warningCount} (${current.warningCount - before.warningCount >= 0 ? '+' : ''}${current.warningCount - before.warningCount})`);
  } else {
    console.log(`[translate-zh] quality: ${current.errorCount} error(s), ${current.warningCount} warning(s)`);
  }
  console.log(`[translate-zh] hard pass: ${current.hardPass ? 'yes' : 'no'}`);
  console.log(`[translate-zh] measurement: ${relative(repoRoot, paths.qualityAfter)}`);
}

function cleanup(runId) {
  const { cacheDir } = pathsFor(runId);
  rmSync(cacheDir, { recursive: true, force: true });
  if (existsSync(cacheDir)) fail(`failed to remove cache: ${relative(repoRoot, cacheDir)}`);
  console.log(`[translate-zh] removed cache: ${relative(repoRoot, cacheDir)}`);
}

const args = parseArgs(process.argv.slice(2));

switch (args.command) {
  case 'preflight':
    preflight(args.runId);
    break;
  case 'init':
    init(args.runId, { force: args.force });
    break;
  case 'repair-init':
    repairInit(args.runId, { force: args.force });
    break;
  case 'editor-init':
    editorInit(args.runId, { force: args.force });
    break;
  case 'editor-accept':
    editorAccept(args.runId);
    break;
  case 'editor-restore':
    editorRestore(args.runId);
    break;
  case 'lint-parts':
    lintParts(args.runId);
    break;
  case 'finalize-summary':
    finalizeSummary(args.runId, { skipQuality: args.skipQuality });
    break;
  case 'finalize-full':
    finalizeFull(args.runId, { keepCache: args.keepCache, skipQuality: args.skipQuality });
    break;
  case 'measure':
    measure(args.runId);
    break;
  case 'verify':
    verify(args.runId);
    break;
  case 'cleanup':
    cleanup(args.runId);
    break;
  default:
    usage(1);
}