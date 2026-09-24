#!/usr/bin/env node
// Link a newly finalized refresh report to the previous report it replaces.
//
// Modes:
//   --prepare-current  Update only the new report's report-meta.yaml revision
//                      before the rest of the per-report finalize-report pipeline runs.
//   default            Ensure the new report is marked current/refresh-of, then
//                      mark the old report superseded and update only its assembled
//                      revision metadata. Intended to run inside finalize-report after the
//                      new report already passed its publishable gate.
//
// The previous report is resolved from the new report's revision.refreshOfRunId
// (idempotent re-runs), then from .research-cache/<newRunId>/refresh-context.yaml
// written by create-report-run.mjs --refresh, and only then by a single
// unambiguous current summary-card match. Multiple fallback matches fail so the
// agent reruns create-report-run.mjs --refresh-of before link-refresh mutates
// revision state.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  SUMMARY_CARD_FILE,
  isFinalizedReportFolder,
  isRunId,
  listDirs,
  normalizeCompanyName,
  normalizeDomain,
  normalizeRevision,
  readYaml,
  REPORT_META_FILE,
  reportsDir,
  researchCacheDir,
  tryReadYaml,
  writeYaml,
} from './utils.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const syncPreservedFieldsScript = resolve(
  here,
  '../../translate-zh/scripts/sync-preserved-fields.mjs',
);

function usage() {
  console.error('Usage: node .agents/skills/startup-research/scripts/link-refresh.mjs <new-report-folder> [--refresh-reason <text>] [--prepare-current]');
  process.exit(EXIT.failure);
}

// Caller must pick an explicit EXIT.X — link-refresh handles a mix of
// invalidArgs / notFound / alreadyExists conditions and the right code
// matters because finalize-report.mjs passes our exit code straight through.
function abort(message, code) {
  console.error(`[refresh] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { folder: null, refreshReason: '', prepareCurrent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--refresh-reason') args.refreshReason = argv[++i] ?? '';
    else if (arg === '--prepare-current') args.prepareCurrent = true;
    else if (arg.startsWith('-')) usage();
    else if (!args.folder) args.folder = arg;
    else usage();
  }
  if (!args.folder) usage();
  return args;
}

function resolveReportFolder(folderArg) {
  const folder = resolve(folderArg);
  if (!existsSync(folder)) abort(`report folder not found: ${folder}`, EXIT.notFound);
  const runId = basename(folder);
  if (resolve(reportsDir, runId) !== folder) abort(`report folder must live under ${reportsDir}: ${folder}`, EXIT.failure);
  if (!isRunId(runId)) abort(`report folder name is not a valid run id: ${runId}`, EXIT.failure);
  return { folder, runId };
}

function readReportMeta(folder) {
  const path = join(folder, REPORT_META_FILE);
  if (!existsSync(path)) abort(`missing ${REPORT_META_FILE} in ${folder}`, EXIT.notFound);
  return { path, doc: readYaml(path) };
}

function readSummaryCard(runId) {
  const path = join(reportsDir, runId, SUMMARY_CARD_FILE);
  return existsSync(path) ? readYaml(path) : null;
}

function matchesCompany(card, company) {
  const candidateName = normalizeCompanyName(company?.name);
  const candidateDomain = normalizeDomain(company?.website);
  const cardName = normalizeCompanyName(card?.company?.name);
  const cardDomain = normalizeDomain(card?.company?.website);
  const sameName = candidateName && cardName && candidateName === cardName;
  const sameDomain = candidateDomain && cardDomain && candidateDomain === cardDomain;
  return Boolean(sameName || sameDomain);
}

function assertFinalizedRun(runId, label) {
  const folder = join(reportsDir, runId);
  if (!isFinalizedReportFolder(folder)) abort(`${label} is not a finalized report: reports/${runId}`, EXIT.failure);
}

function cachedRefreshOfRunId(newRunId) {
  if (!isRunId(newRunId)) return null;
  const result = tryReadYaml(join(researchCacheDir(newRunId), 'refresh-context.yaml'));
  const value = result.ok ? result.value?.refreshOfRunId : null;
  return typeof value === 'string' && isRunId(value) ? value : null;
}

function reusablePriorRunId(runId, { newRunId, newMeta, label }) {
  if (!runId) return null;
  if (runId === newRunId) abort(`${label} cannot reference the new report itself.`, EXIT.failure);
  if (!isRunId(runId)) abort(`${label} ${runId} is not a valid report run id.`, EXIT.failure);
  const folder = join(reportsDir, runId);
  if (!isFinalizedReportFolder(folder)) {
    abort(`${label} ${runId} is not a finalized report.`, EXIT.failure);
  }
  const card = readSummaryCard(runId);
  if (!matchesCompany(card, newMeta.company)) {
    abort(`${label} ${runId} does not match the new report company/domain.`, EXIT.failure);
  }
  const revision = normalizeRevision(card?.revision);
  const reusable = revision.status !== 'superseded' || revision.supersededByRunId === newRunId;
  if (!reusable) {
    abort(`${label} ${runId} is already superseded by ${revision.supersededByRunId}; refresh the current report instead.`, EXIT.alreadyExists);
  }
  return runId;
}

function resolvePreviousRunId({ newRunId, newMeta }) {
  // Idempotent re-runs of finalize-report --refresh: once link-refresh has marked the
  // old report superseded, no current candidate matches anymore. Honour the
  // new report's already-set revision.refreshOfRunId when it points at a
  // finalized matching report that is either still current or already
  // superseded by this same new report.
  const declared = normalizeRevision(newMeta?.revision).refreshOfRunId;
  if (declared) return reusablePriorRunId(declared, { newRunId, newMeta, label: 'report-meta revision.refreshOfRunId' });

  const cached = cachedRefreshOfRunId(newRunId);
  if (cached) return reusablePriorRunId(cached, { newRunId, newMeta, label: 'refresh-context refreshOfRunId' });

  const candidates = [];
  for (const runId of listDirs(reportsDir)) {
    if (runId === newRunId) continue;
    if (!isRunId(runId)) continue;
    if (!isFinalizedReportFolder(join(reportsDir, runId))) continue;
    const card = readSummaryCard(runId);
    if (!matchesCompany(card, newMeta.company)) continue;
    const revision = normalizeRevision(card?.revision);
    if (revision.status === 'superseded') continue;
    candidates.push(runId);
  }
  candidates.sort((a, b) => b.localeCompare(a));
  if (!candidates.length) abort('could not find a current finalized report matching the new report company/domain', EXIT.notFound);
  if (candidates.length > 1) {
    console.error('[refresh] multiple current finalized reports match the new report company/domain:');
    for (const runId of candidates) console.error(`  - ${runId}`);
    abort('ambiguous refresh target; edit .research-cache/<newRunId>/refresh-context.yaml to set refreshOfRunId: <intendedPriorRunId> and rerun finalize-report --refresh. (--refresh-of on create-report-run is honored only on the initial fresh invocation; --resume reuses the cached file unchanged.)', EXIT.failure);
  }
  return candidates[0];
}

function assertRefreshableOld(oldRunId, newRunId) {
  const oldCard = readSummaryCard(oldRunId);
  const oldRevision = normalizeRevision(oldCard?.revision);
  if (oldRevision.status === 'superseded' && oldRevision.supersededByRunId !== newRunId) {
    abort(`${oldRunId} is already superseded by ${oldRevision.supersededByRunId}; refresh the current report instead.`, EXIT.alreadyExists);
  }
}

function updateMetaRevision(metaPath, nextRevision) {
  const doc = readYaml(metaPath);
  const before = JSON.stringify(doc.revision ?? null);
  doc.revision = nextRevision;
  const after = JSON.stringify(doc.revision ?? null);
  if (before !== after) {
    writeYaml(metaPath, doc);
    return true;
  }
  return false;
}

function runScript(script, argv) {
  console.log(`[refresh] -> ${script} ${argv.join(' ')}`);
  const result = spawnSync(process.execPath, [resolve(here, script), ...argv], { stdio: 'inherit' });
  if (result.status !== 0) abort(`${script} failed (exit ${result.status})`, result.status ?? 1);
}

function setCurrentRevision({ newFolder, newRunId, oldRunId, refreshReason }) {
  assertRefreshableOld(oldRunId, newRunId);
  const { path: newMetaPath, doc: newMeta } = readReportMeta(newFolder);
  const existing = normalizeRevision(newMeta.revision);
  const nextRevision = {
    status: 'current',
    refreshOfRunId: oldRunId,
    supersededByRunId: null,
    refreshReason: refreshReason || existing.refreshReason || null,
  };
  return updateMetaRevision(newMetaPath, nextRevision);
}

function setOldRevision({ oldRunId, newRunId, refreshReason }) {
  const oldFolder = join(reportsDir, oldRunId);
  const { path: oldMetaPath, doc: oldMeta } = readReportMeta(oldFolder);
  const existing = normalizeRevision(oldMeta.revision);
  if (existing.status === 'superseded' && existing.supersededByRunId !== newRunId) {
    abort(`${oldRunId} is already superseded by ${existing.supersededByRunId}; refusing to relink.`, EXIT.alreadyExists);
  }
  const nextRevision = {
    status: 'superseded',
    refreshOfRunId: existing.refreshOfRunId,
    supersededByRunId: newRunId,
    refreshReason: existing.refreshReason || refreshReason || null,
  };
  return updateMetaRevision(oldMetaPath, nextRevision);
}

// Detect partial recovery: report-meta.yaml says superseded but the assembled
// artifacts still carry the old revision. Without this check, a re-run of
// finalize-report --refresh would skip reassemble (because setOldRevision returns
// false when meta is already up to date) and leave the inconsistency for
// check-revision-graph to discover.
function oldArtifactsAreInSync(oldRunId, expectedRevision) {
  const card = readSummaryCard(oldRunId);
  if (!card) return false;
  const cardRevision = normalizeRevision(card?.revision);
  return JSON.stringify(cardRevision) === JSON.stringify(expectedRevision);
}

function updateOldArtifactRevisions(oldRunId, revision) {
  const oldFolder = join(reportsDir, oldRunId);
  for (const file of [SUMMARY_CARD_FILE, 'full-report.yaml']) {
    const path = join(oldFolder, file);
    if (!existsSync(path)) abort(`missing ${file} in finalized previous report ${oldRunId}`, EXIT.notFound);
    const doc = readYaml(path);
    doc.revision = revision;
    writeYaml(path, doc);
  }
}

const args = parseArgs(process.argv.slice(2));
const { folder: newFolder, runId: newRunId } = resolveReportFolder(args.folder);
const { doc: newMeta } = readReportMeta(newFolder);
const oldRunId = resolvePreviousRunId({ newRunId, newMeta });
if (oldRunId === newRunId) abort('new report cannot refresh itself', EXIT.failure);
const refreshReason = args.refreshReason || normalizeRevision(newMeta.revision).refreshReason || '';

const currentChanged = setCurrentRevision({ newFolder, newRunId, oldRunId, refreshReason });
console.log(`[refresh] current report ${newRunId} refreshOfRunId=${oldRunId}${currentChanged ? ' (updated)' : ' (already set)'}`);

if (args.prepareCurrent) {
  process.exit(EXIT.ok);
}

if (currentChanged) {
  runScript('build-report.mjs', [newFolder]);
  runScript('check-report.mjs', [newFolder]);
}

assertFinalizedRun(newRunId, 'new refresh report');
const oldChanged = setOldRevision({ oldRunId, newRunId, refreshReason });
console.log(`[refresh] previous report ${oldRunId} supersededByRunId=${newRunId}${oldChanged ? ' (updated)' : ' (already set)'}`);
const { doc: oldMetaAfterLink } = readReportMeta(join(reportsDir, oldRunId));
const oldRevision = normalizeRevision(oldMetaAfterLink.revision);
if (oldChanged || !oldArtifactsAreInSync(oldRunId, oldRevision)) {
  const oldFolder = join(reportsDir, oldRunId);
  updateOldArtifactRevisions(oldRunId, oldRevision);
  runScript(syncPreservedFieldsScript, [oldFolder]);
  runScript('check-report.mjs', [oldFolder]);
}
console.log(`[refresh] ✓ linked ${oldRunId} -> ${newRunId}`);
