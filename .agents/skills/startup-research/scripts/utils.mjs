import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { REGISTRABLE_DOMAIN_MAX_PARTS, MULTI_PART_TLDS } from './validation-catalog.mjs';
import { normalizeWorkflowConfig as normalizeWorkflowConfigFromSchema } from './contracts/workflow-config.schema.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const reportsDir = join(repoRoot, 'reports');
const researchCacheRoot = join(repoRoot, '.research-cache');
export const workflowConfigPath = join(repoRoot, '.agents', 'skills', 'startup-research', 'references', 'workflow-config.yaml');
// Per-report config snapshot. Written by finalize-report so every finalized
// report carries the exact workflow-config.yaml that produced it; check-*
// and build-* scripts then validate/assemble each report against its own
// snapshot, so editing the head config never retroactively re-judges old
// reports. Hidden filename keeps it out of the website loader and the
// reports-contract artifact list.
export const WORKFLOW_SNAPSHOT_FILE = '.workflow-snapshot.yaml';
export const workflowSnapshotPathFor = (reportFolder) => join(reportFolder, WORKFLOW_SNAPSHOT_FILE);
export const RUN_ID_RE = /^\d{14}-[a-z0-9-]+$/;
export const REVISION_STATUSES = new Set(['current', 'superseded']);
export const REPORT_META_FILE = 'report-meta.yaml';
// Final-stage artifact filenames are fixed by report-v2 artifact contracts.
// Keep this object shape — chapter runtime contexts and downstream tooling iterate by camelCase key.
export const FINAL_ARTIFACTS = Object.freeze({
  evidence: { file: 'evidence.yaml', artifact: 'evidence' },
  fullReport: { file: 'full-report.yaml', artifact: 'full-report' },
  summaryCard: { file: 'summary-card.yaml', artifact: 'summary-card' },
});
// summary-card.yaml is the cross-run revision-graph anchor (current/superseded
// pointers live here). Several scripts reference it by filename outside the
// FINAL_ARTIFACTS map, so expose it as a named constant.
export const SUMMARY_CARD_FILE = FINAL_ARTIFACTS.summaryCard.file;
const FINAL_REPORT_FILES = Object.freeze([
  ...Object.values(FINAL_ARTIFACTS).map((artifact) => artifact.file),
  REPORT_META_FILE,
]);

// Single contract for non-zero exit codes used across skill scripts. Callers
// (CI, finalize-report) switch on these to distinguish recoverable
// state errors from validation failures. Keep stable; SKILL.md references
// some of these by number.
//
// `failure` collapses what used to be `validation` and `invalidArgs` — both
// mean "this script could not produce a passing artifact"; CI and humans only
// need to know it failed. Anything that needs to distinguish should read
// stderr (every script prefixes its messages with `[script-name]`).
export const EXIT = Object.freeze({
  ok: 0,
  failure: 1,            // bad CLI args, validation findings, or any non-recoverable failure
  alreadyExists: 2,      // company already has a finalized current report (create-report-run duplicate guard)
  inProgress: 3,         // an in-progress folder for the same run already exists; rerun with --resume
  notFound: 4,           // requested target (e.g. resume folder) does not exist
});

// Per-run scratch dir under .research-cache/ (gitignored). Single source of
// truth so create-report-run.mjs, load-chapter-runtime-context.mjs, and any
// future consumer never hand-build the path. The folder name under
// .research-cache/ is the run id (`<timestamp>-<companySlug>`) — the same
// name as the report folder.
export function researchCacheDir(runId) {
  const value = String(runId ?? '');
  if (!RUN_ID_RE.test(value)) {
    throw new Error(`[utils] researchCacheDir requires a runId matching ${RUN_ID_RE}; got: ${JSON.stringify(value)}`);
  }
  return join(researchCacheRoot, value);
}

// Strip the leading "<timestamp>-" prefix from a run id / report folder name
// to recover the company slug that chapter-level `slug:` fields and
// create-report-run.mjs's `slugify(companyName)` use. Single source of truth so
// every "what's the canonical slug for this run" caller agrees. Throws
// if `runId` is not in `<14-digit-timestamp>-<slug>` form so a misuse
// (e.g. an absolute path) fails loudly instead of silently producing
// nonsense paths downstream.
export function companySlugFromRunId(runId) {
  const value = String(runId ?? '');
  if (!RUN_ID_RE.test(value)) {
    throw new Error(`[utils] companySlugFromRunId requires a runId matching ${RUN_ID_RE}; got: ${JSON.stringify(value)}`);
  }
  return value.replace(/^\d{14}-/, '');
}

export function isRunId(value) {
  return RUN_ID_RE.test(String(value ?? ''));
}

// UTC YYYYMMDDHHmmss for the leading 14 chars of a runId. Single source of
// truth so create-report-run.mjs and any other caller never re-implement the
// formatting — both must agree on UTC and zero-padding so the same Date can
// reproduce the same runId.
export function nowRunTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

// Extract YYYY-MM-DD (UTC) from the leading timestamp of a runId. The runId
// is the canonical clock anchor for a report; chapter doc heads `runDate`
// values come from this so the agent never has to format a date itself.
export function runDateFromRunId(runId) {
  const value = String(runId ?? '');
  if (!RUN_ID_RE.test(value)) {
    throw new Error(`[utils] runDateFromRunId requires a runId matching ${RUN_ID_RE}; got: ${JSON.stringify(value)}`);
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

export function isFinalizedReportFolder(path) {
  return FINAL_REPORT_FILES.every((file) => existsSync(join(path, file)));
}

export function normalizeRevision(value) {
  const revision = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = revision.status === 'superseded' ? 'superseded' : 'current';
  const nullableString = (field) => (typeof revision[field] === 'string' && revision[field].trim() ? revision[field].trim() : null);
  return {
    status,
    refreshOfRunId: nullableString('refreshOfRunId'),
    supersededByRunId: nullableString('supersededByRunId'),
    refreshReason: nullableString('refreshReason'),
  };
}

export function readYaml(path) {
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
}

export function writeYaml(path, value) {
  writeFileSync(path, yaml.dump(value, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
}

export function listDirs(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => {
      try { return statSync(join(path, name)).isDirectory(); }
      catch (err) {
        console.warn(`[utils] could not stat ${join(path, name)}: ${err.message}`);
        return false;
      }
    });
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'startup';
}

export function normalizeCompanyName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b(inc\.?|llc|ltd\.?|corp\.?|corporation|company|co\.?|limited)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeDomain(value) {
  try {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// Allowed URL schemes for source references. Reject javascript:, data:, file:, etc.
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

export function canonicalSourceUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!ALLOWED_URL_SCHEMES.has(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(lower)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    // If URL parsing fails, only return a normalized form if it looks like http(s)
    if (/^https?:\/\//i.test(raw)) {
      return raw.replace(/#.*$/, '').replace(/\?.*utm_[^#]*/i, '').replace(/\/$/, '').toLowerCase();
    }
    return '';
  }
}

// Internal helper used by parseDate(); kept private since no external caller
// needs raw date-to-string coercion.
function asDateString(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value : '';
}

export function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Parses a YYYY-MM-DD-ish value into a Date (UTC midnight) or null. Tolerates
// Date objects and strings; returns null on anything unparseable. Used by
// build-evidence-ledger and build-report for source/claim freshness anchoring.
export function parseDate(value) {
  const text = asDateString(value);
  if (!text) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.valueOf()) ? null : date;
}

// Best-effort registrable domain (eTLD+1) for canonical-URL bookkeeping.
// Uses MULTI_PART_TLDS from validation-catalog for consistency across the codebase.
export function registrableDomain(url) {
  const host = normalizeDomain(url);
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= REGISTRABLE_DOMAIN_MAX_PARTS) return host;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

// Recursively collects every value found under a `claimRefs` array anywhere in
// the document, regardless of nesting depth.
export function collectClaimRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectClaimRefs(item, refs);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'claimRefs' && Array.isArray(child)) refs.push(...child);
      else collectClaimRefs(child, refs);
    }
  }
  return refs;
}

// Convenience reader that throws a clear error message rather than the bare
// js-yaml stack trace.
export function tryReadYaml(path) {
  try {
    return { ok: true, value: readYaml(path) };
  } catch (err) {
    return { ok: false, error: err.message.split('\n')[0] };
  }
}

export function loadWorkflowConfig({ reportFolder } = {}) {
  if (reportFolder) {
    const snapshotPath = workflowSnapshotPathFor(reportFolder);
    if (existsSync(snapshotPath)) {
      return normalizeWorkflowConfigFromSchema(readYaml(snapshotPath));
    }
  }
  if (!existsSync(workflowConfigPath)) {
    throw new Error(`[workflow-config] missing ${workflowConfigPath}`);
  }
  return normalizeWorkflowConfigFromSchema(readYaml(workflowConfigPath));
}

// Copy the head workflow-config.yaml into <reportFolder>/.workflow-snapshot.yaml
// so subsequent validations of this report use the config it was produced
// against. By default a no-op when the snapshot already exists; pass
// `force: true` (wired via finalize-report --refresh-snapshot) to overwrite.
export function writeWorkflowSnapshot(reportFolder, { force = false } = {}) {
  if (!existsSync(workflowConfigPath)) {
    throw new Error(`[workflow-config] missing ${workflowConfigPath}`);
  }
  const target = workflowSnapshotPathFor(reportFolder);
  if (!force && existsSync(target)) return { written: false, path: target };
  copyFileSync(workflowConfigPath, target);
  return { written: true, path: target };
}

export function getAnalysisArtifacts(config = loadWorkflowConfig()) {
  return config.chapters.map((chapter) => ({
    key: chapter.key,
    order: chapter.order,
    letter: chapter.letter,
    file: chapter.file,
    artifact: chapter.key,
    chapter: chapter.order,
    title: chapter.title,
    gate: chapter.gate,
    contentRequirements: chapter.contentRequirements ?? [],
    plannedTables: chapter.plannedTables ?? [],
    plannedFigures: chapter.plannedFigures ?? [],
  }));
}

export function getCoreArtifacts(config = loadWorkflowConfig()) {
  const analysis = getAnalysisArtifacts(config).map(({ file, artifact, chapter }) => ({ file, artifact, chapter }));
  return [
    ...analysis,
    ...Object.values(FINAL_ARTIFACTS),
  ];
}

