import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  isFinalizedReportFolder, isRunId, normalizeCompanyName, normalizeDomain,
  normalizeRevision, readYaml, reportsDir, SUMMARY_CARD_FILE,
} from './utils.mjs';

export const REPORT_REDIRECTS_DIRECTORY = '.redirects';

export function reportRedirectTarget(runId, root = reportsDir) {
  if (!isRunId(runId)) throw new Error(`Invalid retired report run ID: ${runId}`);
  const directory = join(root, REPORT_REDIRECTS_DIRECTORY);
  if (!existsSync(directory)) return '';
  if (!lstatSync(directory).isDirectory()) throw new Error(`Invalid report redirects directory: ${directory}`);
  const path = join(directory, `${runId}.json`);
  if (!existsSync(path)) return '';
  if (!lstatSync(path).isFile()) throw new Error(`Invalid report redirect file: ${path}`);
  let target;
  try {
    target = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid report redirect ${path}: ${error.message}`);
  }
  if (typeof target !== 'string' || !isRunId(target) || target === runId) {
    throw new Error(`Invalid report redirect target: ${path}`);
  }
  return target;
}

/** @returns {Record<string, string>} */
export function readReportRedirects(root = reportsDir) {
  const directory = join(root, REPORT_REDIRECTS_DIRECTORY);
  if (!existsSync(directory)) return {};
  if (!lstatSync(directory).isDirectory()) throw new Error(`Invalid report redirects directory: ${directory}`);
  /** @type {Record<string, string>} */
  const redirects = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const runId = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
    if (!entry.isFile() || !isRunId(runId)) throw new Error(`Invalid report redirect file: ${entry.name}`);
    redirects[runId] = reportRedirectTarget(runId, root);
  }
  return redirects;
}

function sameCompany(left, right) {
  const name = normalizeCompanyName(left?.name);
  const domain = normalizeDomain(left?.website);
  return Boolean((name && name === normalizeCompanyName(right?.name))
    || (domain && domain === normalizeDomain(right?.website)));
}

function assertFinalizedRevision(report, root) {
  const folder = join(root, report.runId);
  if (!isFinalizedReportFolder(folder)) throw new Error(`Report is not finalized: ${report.runId}`);
  for (const file of ['report-meta.yaml', 'full-report.yaml', 'summary-card.zh.yaml', 'full-report.zh.yaml']) {
    const path = join(folder, file);
    if (!existsSync(path)) continue;
    const revision = readYaml(path)?.revision;
    if (file === 'report-meta.yaml' && revision == null) continue;
    if (JSON.stringify(normalizeRevision(revision)) !== JSON.stringify(report.revision)) {
      throw new Error(`Inconsistent revision in ${report.runId}/${file}`);
    }
  }
}

export function planReportPruning(root = reportsDir) {
  const reports = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const path = join(root, entry.name, SUMMARY_CARD_FILE);
    if (!existsSync(path)) continue;
    const card = readYaml(path);
    reports.set(entry.name, { runId: entry.name, company: card.company, revision: normalizeRevision(card.revision) });
  }
  const existingRedirects = readReportRedirects(root);
  const redirects = { ...existingRedirects };
  const removals = [];
  const checked = new Set();
  function currentReplacement(runId, visited = new Set()) {
    if (visited.has(runId)) throw new Error(`Report retirement cycle at ${runId}`);
    visited.add(runId);
    const report = reports.get(runId);
    if (!report) {
      if (existingRedirects[runId]) return currentReplacement(existingRedirects[runId], visited);
      throw new Error(`Missing replacement report: ${runId}`);
    }
    if (!isRunId(runId)) throw new Error(`Invalid report run ID: ${runId}`);
    if (!checked.has(runId)) {
      assertFinalizedRevision(report, root);
      checked.add(runId);
    }
    if (report.revision.status === 'current') return report;
    const linked = reports.get(report.revision.supersededByRunId);
    if (linked && linked.revision.refreshOfRunId !== report.runId) {
      throw new Error(`Broken refresh back-pointer: ${report.runId} -> ${linked.runId}`);
    }
    const next = currentReplacement(report.revision.supersededByRunId, visited);
    if (!sameCompany(report.company, next.company)) throw new Error(`Replacement company mismatch: ${runId} -> ${next.runId}`);
    return next;
  }
  for (const report of reports.values()) {
    if (report.revision.status !== 'superseded') continue;
    const replacement = currentReplacement(report.runId);
    removals.push({ runId: report.runId, targetRunId: replacement.runId });
    redirects[report.runId] = replacement.runId;
  }
  for (const [runId, target] of Object.entries(redirects)) {
    if (reports.get(runId)?.revision.status === 'current') throw new Error(`Cannot retire a current report: ${runId}`);
    const replacement = currentReplacement(target);
    if (replacement.runId === runId) throw new Error(`Report cannot redirect to itself: ${runId}`);
    redirects[runId] = replacement.runId;
  }
  removals.sort((a, b) => a.runId.localeCompare(b.runId));
  return { removals, redirects };
}

export function pruneSupersededReports(root = reportsDir) {
  const plan = planReportPruning(root);
  const directory = join(root, REPORT_REDIRECTS_DIRECTORY);
  if (Object.keys(plan.redirects).length) mkdirSync(directory, { recursive: true });
  for (const [runId, target] of Object.entries(plan.redirects)) {
    const path = join(directory, `${runId}.json`);
    const text = `${JSON.stringify(target)}\n`;
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
  }
  for (const { runId } of plan.removals) {
    const folder = resolve(root, runId);
    if (!isRunId(runId) || folder !== join(resolve(root), runId) || !lstatSync(folder).isDirectory()) {
      throw new Error(`Refusing to delete unsafe report folder: ${folder}`);
    }
    rmSync(folder, { recursive: true, force: false });
  }
  return plan;
}
