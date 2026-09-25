#!/usr/bin/env node
// Run the post-chapter finalization pipeline as a single command. Every step
// here only touches the given report folder (and, with --refresh, the prior
// report folder it supersedes). No cross-report catalog is written; the
// website discovers reports by walking reports/<runId>/summary-card.yaml.
//
// Pipeline:
//   1. check-chapter.mjs --strict -> strict pre-finalization sweep for every configured chapter
//   2. check-report-meta.mjs -> shape + enum check on report-meta.yaml
//                                   (runs first so every missing/invalid field
//                                   surfaces in one shot, instead of one per
//                                   finalize-loop iteration)
//   3. (refresh only) link-refresh.mjs --prepare-current
//                       -> mark the new report as revision.status=current
//   4. build-evidence-ledger.mjs -> evidence.yaml + chapter claimRef consolidation
//   5. check-cross-chapter.mjs -> drift checks across chapters
//   6. build-report.mjs -> full-report.yaml + summary-card.yaml
//   7. check-report.mjs -> schema/contract validation and publishability gate
//   8. (refresh only) link-refresh.mjs
//                       -> mark the previous report as revision.status=superseded
//                          and update its assembled revision fields only
//
// Re-runs after fixing report-meta.yaml or a chapter reuse the existing
// evidence.yaml; pass --rebuild to force a full ledger consolidation (which
// reassigns canonical claim IDs).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  FINAL_ARTIFACTS,
  REPORT_META_FILE,
  WORKFLOW_SNAPSHOT_FILE,
  canonicalSourceUrl,
  getAnalysisArtifacts,
  isRunId,
  loadWorkflowConfig,
  researchCacheDir,
  tryReadYaml,
  writeWorkflowSnapshot,
} from './utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function usage() {
  console.error('Usage: node .agents/skills/startup-research/scripts/finalize-report.mjs <report-folder> [--rebuild] [--refresh] [--refresh-reason <text>] [--refresh-snapshot]');
  process.exit(EXIT.failure);
}

function parseArgs(argv) {
  const parsed = { folder: null, rebuild: false, refresh: false, refreshReason: '', refreshSnapshot: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rebuild') parsed.rebuild = true;
    else if (arg === '--refresh') parsed.refresh = true;
    else if (arg === '--refresh-reason') parsed.refreshReason = argv[++i] ?? '';
    else if (arg === '--refresh-snapshot') parsed.refreshSnapshot = true;
    else if (arg.startsWith('-')) usage();
    else if (!parsed.folder) parsed.folder = arg;
    else usage();
  }
  return parsed;
}

const parsedArgs = parseArgs(args);
const folderArg = parsedArgs.folder;
const rebuild = parsedArgs.rebuild;
const refresh = parsedArgs.refresh;
// Mutable so ensureRefreshReasonMatchesCache() can backfill from the cached
// refresh-context.yaml when the caller did not pass --refresh-reason. SKILL.md
// used to require the same reason on both create-report-run and finalize-report;
// the backfill removes that footgun and keeps both code paths in sync.
let refreshReason = parsedArgs.refreshReason;

if (!folderArg) {
  usage();
}

const reportFolder = resolve(folderArg);
if (!existsSync(reportFolder)) {
  console.error(`[finalize-report] report folder not found: ${reportFolder}`);
  process.exit(EXIT.notFound);
}
if (!existsSync(join(reportFolder, REPORT_META_FILE))) {
  console.error(`[finalize-report] missing ${REPORT_META_FILE} in ${reportFolder}; author it before finalizing.`);
  process.exit(EXIT.notFound);
}

function runStep(step) {
  console.log(`[finalize-report] -> ${step.name}`);
  const result = spawnSync(process.execPath, [resolve(here, step.script), ...step.argv], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[finalize-report] ${step.name} failed (exit ${result.status}); fix the reported issues and rerun this command.`);
    if (step.script === 'check-chapter.mjs') {
      const jsonArgv = [...step.argv];
      const formatIndex = jsonArgv.indexOf('--format');
      if (formatIndex >= 0) jsonArgv.splice(formatIndex, 2, '--format', 'json');
      else jsonArgv.push('--format', 'json');
      console.error(`[finalize-report] structured triage: node ${resolve(here, step.script)} ${jsonArgv.map((arg) => JSON.stringify(String(arg))).join(' ')}`);
    }
    // Pass the subprocess exit code through as-is so callers see the same
    // semantic the underlying script emitted; only fall back to validation
    // when the subprocess died from a signal (status === null).
    process.exit(result.status ?? EXIT.failure);
  }
}

function rejectScratchFilesInNewReport() {
  if (existsSync(join(reportFolder, FINAL_ARTIFACTS.summaryCard.file))) return;
  const allowed = new Set([
    ...getAnalysisArtifacts().map((artifact) => artifact.file),
    REPORT_META_FILE,
    WORKFLOW_SNAPSHOT_FILE,
    ...Object.values(FINAL_ARTIFACTS).map((artifact) => artifact.file),
  ]);
  const unexpected = readdirSync(reportFolder, { withFileTypes: true })
    .filter((entry) => !allowed.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (unexpected.length === 0) return;
  console.error(`[finalize-report] unexpected scratch file(s) in new report folder: ${unexpected.join(', ')}`);
  console.error(`[finalize-report] move scratch/runtime context under .research-cache/${basename(reportFolder)}/ and rerun.`);
  process.exit(EXIT.notFound);
}

function enforceFastPrefetchedSources() {
  const config = loadWorkflowConfig({ reportFolder });
  if (config.activeResearchProfile !== 'fast') return;
  const bundlePath = join(researchCacheDir(basename(reportFolder)), 'search-bundle.json');
  if (!existsSync(bundlePath)) {
    console.error(`[finalize-report] fast report is missing its search bundle: ${bundlePath}`);
    console.error('[finalize-report] rerun research:bootstrap; fast reports may cite only successfully prefetched bundle URLs.');
    process.exit(EXIT.notFound);
  }
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    console.error(`[finalize-report] invalid fast search bundle ${bundlePath}: ${error.message}`);
    process.exit(EXIT.failure);
  }
  const approved = new Set(
    (bundle.fetchedSources ?? [])
      .filter((entry) => entry?.ok)
      .map((entry) => canonicalSourceUrl(entry.url))
      .filter(Boolean),
  );
  const poolByKey = new Map(
    (bundle.chapterPools ?? []).map((pool) => [
      pool.key,
      new Set(
        [...(pool.recommended ?? []), ...(pool.reserve ?? [])]
          .filter((candidate) => candidate.fetch?.ok)
          .map((candidate) => canonicalSourceUrl(candidate.url))
          .filter(Boolean),
      ),
    ]),
  );
  const unapproved = [];
  for (const spec of getAnalysisArtifacts(config)) {
    const chapter = tryReadYaml(join(reportFolder, spec.file));
    if (!chapter.ok) continue;
    const assigned = poolByKey.get(spec.key) ?? new Set();
    for (const source of chapter.value?.localEvidence?.sources ?? []) {
      const canonical = canonicalSourceUrl(source?.url);
      if (canonical && (!approved.has(canonical) || !assigned.has(canonical))) {
        unapproved.push(`${spec.file}:${source?.id ?? '?'} ${source.url}${approved.has(canonical) ? ' (assigned to another chapter)' : ''}`);
      }
    }
  }
  if (unapproved.length === 0) return;
  console.error('[finalize-report] fast report cites URL(s) that were not successfully prefetched by research:bootstrap:');
  for (const entry of unapproved) console.error(`  - ${entry}`);
  console.error('[finalize-report] replace them with relevant successful entries from that chapter’s assigned pool; do not borrow sibling URLs or add fetch-trail lines manually.');
  process.exit(EXIT.failure);
}

// Pre-finalization sweep: run check-chapter --strict on every configured
// chapter file. SKILL.md mandates this sweep, but agents can forget it; the
// pipeline enforces it here so unverifiedSource / tableNotes warnings cannot
// silently slip past finalize. Missing files become finalize failures so the
// agent fixes the chapter before the ledger and assembler run on partial
// inputs.
function strictCheckEveryChapter() {
  const chapters = getAnalysisArtifacts();
  const missing = chapters.filter((spec) => !existsSync(join(reportFolder, spec.file)));
  if (missing.length) {
    console.error(`[finalize-report] missing chapter file(s) before strict sweep: ${missing.map((m) => m.file).join(', ')}`);
    console.error('[finalize-report] author every configured chapter and pass check-chapter --strict before finalizing.');
    process.exit(EXIT.notFound);
  }
  for (const spec of chapters) {
    runStep({
      name: `check-chapter:${spec.key}:strict`,
      script: 'check-chapter.mjs',
      argv: [reportFolder, spec.file, '--strict', '--format', 'compact'],
    });
  }
}

// Stale-evidence detection: when finalize is rerun without --rebuild, the
// pipeline reuses the existing evidence.yaml. If any chapter file is newer
// than evidence.yaml, the ledger and downstream checks would otherwise see
// the stale ledger and the agent's edits get silently ignored. We compare
// mtimes (cheap; not content-aware) and trigger an automatic rebuild — the
// previous behaviour exited with `evidence.yaml is older than N chapter
// file(s)…` which forced the agent to remember to pass --rebuild after every
// edit (including prose-only ones like chapter.summary or sections[].body).
// build-report runs after the rebuild and surfaces dangling report-meta
// claimRefs if a canonical id pointer shifted, so safety is preserved.
function detectStaleEvidence() {
  const evidencePath = join(reportFolder, FINAL_ARTIFACTS.evidence.file);
  if (!existsSync(evidencePath)) return [];
  const evidenceMtime = statSync(evidencePath).mtimeMs;
  const newer = [];
  for (const spec of getAnalysisArtifacts()) {
    const chapterPath = join(reportFolder, spec.file);
    if (!existsSync(chapterPath)) continue;
    if (statSync(chapterPath).mtimeMs > evidenceMtime) newer.push(spec.file);
  }
  return newer;
}

// Refresh-reason consistency: SKILL.md asks the agent to pass the same
// --refresh-reason string to create-report-run and finalize-report so the
// audit trail (refresh-context cache vs. report-meta revision) stays in
// sync. We make the second pass optional: when finalize-report receives no
// --refresh-reason, we backfill from the cached refresh-context.yaml so the
// agent only has to remember the string once. When the caller does pass a
// value, we still enforce the original consistency check.
function ensureRefreshReasonMatchesCache() {
  if (!refresh) return;
  const runId = basename(reportFolder);
  if (!isRunId(runId)) return;
  const ctxPath = join(researchCacheDir(runId), 'refresh-context.yaml');
  const result = tryReadYaml(ctxPath);
  if (!result.ok) return; // create-report-run --refresh always writes it; absent means a refresh started without create-report-run, leave it to link-refresh
  const cached = result.value?.refreshReason ?? null;
  if (!refreshReason && cached) {
    refreshReason = cached;
    console.error(`[finalize-report] using cached --refresh-reason from refresh-context.yaml: ${JSON.stringify(cached)}`);
    return;
  }
  const provided = refreshReason || null;
  if ((cached ?? '') !== (provided ?? '')) {
    console.error(`[finalize-report] --refresh-reason mismatch: refresh-context.yaml has ${JSON.stringify(cached)} but finalize-report was given ${JSON.stringify(provided)}.`);
    console.error('[finalize-report] omit --refresh-reason to reuse the cached value, or pass the same string both times.');
    process.exit(EXIT.failure);
  }
}

// Strict sweep first so we never advance to the expensive ledger/assembler
// steps with unverified sources or missing table notes outstanding.
// Before any sub-script runs, freeze the current head workflow-config.yaml
// into reports/<runId>/.workflow-snapshot.yaml so every downstream check
// validates this report against the config that produced it. Default is
// no-op when a snapshot already exists; --refresh-snapshot overwrites it
// (use when an authored repair on an old report should be re-judged under
// the latest rules).
rejectScratchFilesInNewReport();
const snapshotResult = writeWorkflowSnapshot(reportFolder, { force: parsedArgs.refreshSnapshot });
if (snapshotResult.written) {
  console.log(`[finalize-report] wrote ${WORKFLOW_SNAPSHOT_FILE} (${parsedArgs.refreshSnapshot ? 'refreshed from head config' : 'first finalize'})`);
} else {
  console.log(`[finalize-report] reusing existing ${WORKFLOW_SNAPSHOT_FILE}; pass --refresh-snapshot to re-freeze from the current head config.`);
}

enforceFastPrefetchedSources();
strictCheckEveryChapter();

// Refresh audit-trail consistency must hold before we touch report-meta.
ensureRefreshReasonMatchesCache();

// Detect stale evidence so the ledger decision below can rebuild it. Skipped
// when --rebuild was passed (we are going to rebuild anyway) so the noisy
// notice is not printed twice.
const staleChapters = parsedArgs.rebuild ? [] : detectStaleEvidence();
if (staleChapters.length > 0) {
  console.error(`[finalize-report] auto-rebuild: evidence.yaml is older than ${staleChapters.length} chapter file(s): ${staleChapters.join(', ')}`);
  console.error('[finalize-report] note: rebuilding the ledger may shift canonical claim id pointers; build-report will surface dangling report-meta claimRefs if any.');
}

// Fast pre-flight: surface every shape/enum problem in report-meta.yaml
// before any expensive step runs. The full build-report.mjs check still
// runs later as defense-in-depth (it also covers cross-refs against
// evidence.yaml, which this step intentionally does not load).
runStep({ name: 'check-report-meta', script: 'check-report-meta.mjs', argv: [reportFolder] });

if (refresh) {
  const refreshArgs = [reportFolder, '--prepare-current'];
  if (refreshReason) refreshArgs.push('--refresh-reason', refreshReason);
  runStep({ name: 'prepare-refresh', script: 'link-refresh.mjs', argv: refreshArgs });
}

// Per-report pipeline. Build the evidence ledger only when there is no evidence.yaml yet (or when
// --rebuild forces a fresh consolidation, or when chapter files are newer
// than evidence.yaml — auto-rebuild). evidence.yaml is preserved across
// re-runs so canonical claim IDs stay stable; the chapter source of truth
// (localEvidence) is preserved by build-evidence-ledger so the agent always has a place to
// fix evidence-shape problems.
const hasExistingEvidence = existsSync(join(reportFolder, FINAL_ARTIFACTS.evidence.file));
const needsLedger = !hasExistingEvidence || rebuild || staleChapters.length > 0;
const steps = [];
if (needsLedger) {
  steps.push({ name: 'build-evidence-ledger', script: 'build-evidence-ledger.mjs', argv: [reportFolder] });
} else {
  console.log('[finalize-report] reusing existing evidence.yaml; pass --rebuild to force a full evidence-ledger rebuild.');
}
steps.push({ name: 'check-cross-chapter', script: 'check-cross-chapter.mjs', argv: [reportFolder] });
steps.push({ name: 'build-report', script: 'build-report.mjs', argv: [reportFolder] });
steps.push({ name: 'check-report', script: 'check-report.mjs', argv: [reportFolder] });

// link-refresh runs after the publishability gate so we never mark a prior
// report superseded by a report that did not validate. It only touches the
// two report folders (new + previous), not any cross-report ledger.
if (refresh) {
  const refreshArgs = [reportFolder];
  if (refreshReason) refreshArgs.push('--refresh-reason', refreshReason);
  steps.push({ name: 'link-refresh', script: 'link-refresh.mjs', argv: refreshArgs });
}

for (const step of steps) runStep(step);
console.log('[finalize-report] ✓ pipeline complete; report passed schema validation.');
