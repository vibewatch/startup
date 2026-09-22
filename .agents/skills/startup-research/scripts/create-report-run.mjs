#!/usr/bin/env node
// Create or resume a report folder under reports/<timestamp>-<slug>/ after
// walking existing reports/<runId>/summary-card.yaml files for duplicate
// company name or website/domain risk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  EXIT,
  SUMMARY_CARD_FILE,
  companySlugFromRunId,
  isFinalizedReportFolder,
  isRunId,
  listDirs,
  loadWorkflowConfig,
  normalizeCompanyName,
  normalizeDomain,
  normalizeRevision,
  nowRunTimestamp,
  readYaml,
  reportsDir,
  researchCacheDir,
  slugify,
} from './utils.mjs';

function volatileFactRefreshInstruction() {
  const facts = loadWorkflowConfig().agentPolicy?.volatileFacts ?? [];
  return facts.length
    ? `Re-fetch volatile facts: ${facts.join(', ')}.`
    : 'Re-fetch volatile facts from the workflow agent policy.';
}

function usage() {
  console.error('Usage: node .agents/skills/startup-research/scripts/create-report-run.mjs <company name> [--website <url>] [--refresh --refresh-reason <text> [--refresh-of <runId>]] [--resume [--resume-run <runId>]]');
  process.exit(EXIT.failure);
}

function parseArgs(argv) {
  const args = { nameParts: [], website: '', refresh: false, refreshReason: '', refreshOfRunId: '', resume: false, resumeRunId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--website') args.website = argv[++i] ?? '';
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--refresh-reason') args.refreshReason = argv[++i] ?? '';
    else if (arg === '--refresh-of') args.refreshOfRunId = argv[++i] ?? '';
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--resume-run') args.resumeRunId = argv[++i] ?? '';
    else if (arg.startsWith('--')) usage();
    else args.nameParts.push(arg);
  }
  args.timestamp = nowRunTimestamp();
  if (!args.nameParts.length) usage();
  // Refresh runs must record a reason: link-refresh writes it to
  // revision.refreshReason on both the new and prior reports, and
  // finalize-report reuses the cached value when --refresh-reason is
  // omitted on its CLI. Without enforcement here a refresh run silently
  // ends with revision.refreshReason: null. Resume invocations are
  // exempt because the cached refresh-context.yaml from the original
  // create-report-run already carries the reason.
  if (args.refresh && !args.resume && !args.refreshReason.trim()) {
    console.error('[create-report-run] --refresh requires --refresh-reason "<text>" so revision.refreshReason is recorded on the new and prior reports.');
    process.exit(EXIT.failure);
  }
  if (args.refreshOfRunId && !args.refresh) {
    console.error('[create-report-run] --refresh-of is only valid with --refresh.');
    process.exit(EXIT.failure);
  }
  if (args.resumeRunId && !args.resume) {
    console.error('[create-report-run] --resume-run is only valid with --resume.');
    process.exit(EXIT.failure);
  }
  if (args.refreshOfRunId && !isRunId(args.refreshOfRunId)) {
    console.error(`[create-report-run] --refresh-of must be a report runId (YYYYMMDDhhmmss-<slug>); got ${JSON.stringify(args.refreshOfRunId)}.`);
    process.exit(EXIT.failure);
  }
  if (args.resumeRunId && !isRunId(args.resumeRunId)) {
    console.error(`[create-report-run] --resume-run must be a report runId (YYYYMMDDhhmmss-<slug>); got ${JSON.stringify(args.resumeRunId)}.`);
    process.exit(EXIT.failure);
  }
  return args;
}

// Walk every reports/<runId>/summary-card.yaml and return a flat list of the
// fields needed for duplicate detection and --refresh target resolution.
// Folders without summary-card.yaml (in-progress, partial) are skipped.
function loadReportsFromDisk() {
  const reports = [];
  for (const runId of listDirs(reportsDir)) {
    const cardPath = join(reportsDir, runId, SUMMARY_CARD_FILE);
    if (!existsSync(cardPath)) continue;
    let card;
    try { card = readYaml(cardPath); }
    catch (err) {
      console.warn(`[create-report-run] skipping ${cardPath} (unreadable YAML): ${err.message}`);
      continue;
    }
    const company = card?.company ?? {};
    const revision = normalizeRevision(card?.revision);
    reports.push({
      runId,
      companyName: company.name ?? null,
      website: company.website ?? null,
      revisionStatus: revision.status,
      path: `reports/${runId}/${SUMMARY_CARD_FILE}`,
    });
  }
  return reports;
}

function duplicateMatches({ companyName, website, reports }) {
  const candidateName = normalizeCompanyName(companyName);
  const candidateDomain = normalizeDomain(website);
  if (!candidateName && !candidateDomain) return [];
  return reports.filter((report) => {
    const sameName = candidateName && normalizeCompanyName(report.companyName) === candidateName;
    const sameDomain = candidateDomain && normalizeDomain(report.website) === candidateDomain;
    return sameName || sameDomain;
  });
}

function currentMatches(matches) {
  return matches.filter((report) => (report.revisionStatus ?? 'current') !== 'superseded');
}

function inProgressRunsForSlug(companySlug) {
  return listDirs(reportsDir)
    .filter((runId) => {
      if (!isRunId(runId)) return false;
      try {
        return companySlugFromRunId(runId) === companySlug && !isFinalizedReportFolder(join(reportsDir, runId));
      } catch {
        return false;
      }
    })
    .sort((a, b) => String(b).localeCompare(String(a)));
}

function printInProgressCandidates(candidates) {
  for (const runId of candidates) {
    console.error(`  - reports/${runId}`);
  }
}

function ensureFinalizedRun(runId, label) {
  const folder = join(reportsDir, runId);
  if (!isFinalizedReportFolder(folder)) {
    console.error(`[create-report-run] ${label} is not a finalized report folder: reports/${runId}`);
    process.exit(EXIT.failure);
  }
}

function resolveRefreshTarget({ refresh, matches, refreshOfRunId }) {
  if (!refresh) return null;
  if (!matches.length) {
    console.error('[create-report-run] --refresh requested, but no matching finalized report exists for this company/domain.');
    process.exit(EXIT.failure);
  }
  const candidates = currentMatches(matches).sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
  if (!candidates.length) {
    console.error('[create-report-run] --refresh requested, but every matching report is already superseded.');
    process.exit(EXIT.failure);
  }
  if (refreshOfRunId) {
    const explicit = candidates.find((candidate) => candidate.runId === refreshOfRunId);
    if (!explicit) {
      console.error(`[create-report-run] --refresh-of ${refreshOfRunId} is not a current finalized report matching this company/domain.`);
      console.error('[create-report-run] matching current candidates:');
      for (const candidate of candidates) console.error(`  - ${candidate.runId} (${candidate.path})`);
      process.exit(EXIT.failure);
    }
    ensureFinalizedRun(explicit.runId, '--refresh target');
    return explicit;
  }
  if (candidates.length > 1) {
    console.error('[create-report-run] --refresh is ambiguous: multiple current finalized reports match this company/domain.');
    console.error('[create-report-run] rerun with --refresh-of <runId> using one of:');
    for (const candidate of candidates) console.error(`  - ${candidate.runId} (${candidate.path})`);
    process.exit(EXIT.failure);
  }
  const target = candidates[0];
  ensureFinalizedRun(target.runId, '--refresh target');
  return target;
}

function checkDuplicateRisk({ matches, refreshTarget }) {
  if (!matches.length) return;
  if (refreshTarget) {
    console.error(`[create-report-run] refresh mode: duplicate company/domain accepted; refreshing ${refreshTarget.runId}.`);
    return;
  }

  console.error('[create-report-run] duplicate-risk: high');
  for (const match of matches) {
    console.error(`  - ${match.companyName ?? match.runId} (${match.path})`);
  }
  console.error('[create-report-run] stop: a finalized report already exists for this company/domain.');
  process.exit(EXIT.alreadyExists);
}

function writeRefreshContext({ base, companyName, website, refreshTarget, refreshReason }) {
  if (!refreshTarget) return;
  const previousRunId = refreshTarget.runId;
  const previousCardPath = join(reportsDir, previousRunId, SUMMARY_CARD_FILE);
  const previousCard = existsSync(previousCardPath) ? readYaml(previousCardPath) : {};
  const revision = normalizeRevision(previousCard.revision);
  const cacheDir = researchCacheDir(base);
  mkdirSync(cacheDir, { recursive: true });
  const context = {
    schemaVersion: 'refresh-context-v1',
    mode: 'refresh',
    newRunId: base,
    refreshOfRunId: previousRunId,
    refreshReason: refreshReason || null,
    previousReport: {
      runId: previousRunId,
      path: `reports/${previousRunId}`,
      summaryCardPath: `reports/${previousRunId}/${SUMMARY_CARD_FILE}`,
      runDate: previousCard.runDate ?? null,
      revisionStatus: revision.status,
      company: previousCard.company ?? {
        name: refreshTarget.companyName ?? companyName,
        website: refreshTarget.website ?? website ?? null,
      },
      headline: previousCard.summary?.headline ?? null,
      overallScore: previousCard.summary?.overallScore ?? null,
      recommendation: previousCard.summary?.recommendation ?? null,
      riskRating: previousCard.summary?.riskRating ?? null,
      valuationStance: previousCard.summary?.valuationStance ?? null,
      keyMetrics: previousCard.summary?.keyMetrics ?? {},
      unresolvedGaps: previousCard.summary?.unresolvedGaps ?? [],
      sourceStats: previousCard.sourceStats ?? {},
    },
    refreshInstructions: [
      'Use the previous report only as background and diff context; do not copy stale claims without re-verifying them.',
      volatileFactRefreshInstruction(),
      'Generate a full report covering every configured analysis chapter and run the normal chapter gates before finalizing.',
      'Do not author report-meta.yaml revision fields; create-report-run --refresh-of handles disambiguation before this context is cached, and finalize-report/link-refresh writes revision.status, refreshOfRunId, supersededByRunId, and refreshReason automatically.',
    ],
  };
  const path = join(cacheDir, 'refresh-context.yaml');
  writeFileSync(path, yaml.dump(context, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
  console.error(`[create-report-run] wrote refresh context: ${path}`);
}

function fetchLogExportLine(base) {
  return `export STARTUP_FETCH_LOG_PATH=.research-cache/${base}/_fetch-log.jsonl`;
}

function writeFetchEnvSnippet(base) {
  const cacheDir = researchCacheDir(base);
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, 'env.sh');
  const body = [
    '# Source this file before running fetch-url for this startup-research run.',
    '# check-chapter --strict audits cited URLs against this JSONL trail.',
    fetchLogExportLine(base),
    '',
  ].join('\n');
  // Skip the rewrite when the file already matches the intended body so
  // --resume does not stomp on hand-edits (e.g. an operator pointing at a
  // CI-shared trail) when the canonical content is already correct.
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === body) return path;
    } catch { /* fall through to overwrite */ }
  }
  writeFileSync(path, body, 'utf8');
  return path;
}

function printFetchTrailHint(base) {
  const envPath = writeFetchEnvSnippet(base);
  console.error(`[create-report-run] wrote fetch env snippet: ${envPath}`);
  // CI exception: a workflow-wide trail (e.g. .research-cache/_fetch-log.jsonl)
  // may already be exported by an outer script. Sourcing the per-run snippet
  // would clobber that path. Detect the already-exported case and surface a
  // different hint so the agent does not blindly re-export.
  const exported = process.env.STARTUP_FETCH_LOG_PATH;
  if (exported && exported.trim()) {
    console.error(`[create-report-run] note: STARTUP_FETCH_LOG_PATH already exported (${exported}); keep that value and do NOT source ${envPath} (sourcing would override the workflow-wide trail).`);
    return;
  }
  console.error(`[create-report-run] hint: source ${envPath} before running fetch-url, or run ${fetchLogExportLine(base)}, so check-chapter can audit cited URLs.`);
}

const args = parseArgs(process.argv.slice(2));
const companyName = args.nameParts.join(' ') || 'startup';
const companySlug = slugify(companyName);
const reports = loadReportsFromDisk();
const matches = duplicateMatches({ companyName, website: args.website, reports });

if (args.resume) {
  let resumeRunId = args.resumeRunId;
  if (resumeRunId) {
    if (companySlugFromRunId(resumeRunId) !== companySlug) {
      console.error(`[create-report-run] --resume-run ${resumeRunId} does not match company slug "${companySlug}".`);
      process.exit(EXIT.failure);
    }
  } else {
    const candidates = inProgressRunsForSlug(companySlug);
    if (!candidates.length) {
      console.error(`[create-report-run] cannot resume: no in-progress report folder exists for company slug "${companySlug}".`);
      console.error('[create-report-run] run without --resume to create a fresh in-progress report folder.');
      process.exit(EXIT.notFound);
    }
    if (candidates.length > 1) {
      console.error(`[create-report-run] --resume is ambiguous: multiple in-progress folders match company slug "${companySlug}".`);
      console.error('[create-report-run] rerun with --resume-run <runId> using one of:');
      printInProgressCandidates(candidates);
      process.exit(EXIT.failure);
    }
    resumeRunId = candidates[0];
  }
  const resumePath = join(reportsDir, resumeRunId);
  if (!existsSync(resumePath)) {
    console.error(`[create-report-run] cannot resume missing report folder: ${resumePath}`);
    console.error('[create-report-run] run without --resume to create a fresh in-progress report folder.');
    process.exit(EXIT.notFound);
  }
  if (isFinalizedReportFolder(resumePath)) {
    console.error(`[create-report-run] finalized report folder already exists: ${resumePath}`);
    console.error('[create-report-run] stop: use the existing official report instead of resuming.');
    process.exit(EXIT.alreadyExists);
  }
  // Ensure the per-run scratch dir exists on resume too (it may have been
  // pruned between runs); the agent and fetch-url co-locate fetch logs and
  // refresh context here.
  mkdirSync(researchCacheDir(resumeRunId), { recursive: true });
  // Refresh on --resume must match the original create-run mode; we never
  // promote a fresh in-progress folder into a refresh half-way through, and
  // we never demote a refresh folder into a fresh run on resume.
  //   - cache present + --refresh: legitimate refresh resume; keep cache
  //     intact (do NOT overwrite, so a different --refresh-reason cannot
  //     silently mutate the cached audit value finalize-report compares).
  //   - cache present + no --refresh: original was a refresh; resume must
  //     also pass --refresh so the agent does not accidentally drop
  //     refresh semantics mid-run.
  //   - cache absent + --refresh: original was a fresh run; refusing here
  //     prevents the silent fresh\u2192refresh promotion noted in SKILL.md.
  //   - cache absent + no --refresh: legitimate fresh-run resume; nothing
  //     to write.
  const resumeRefreshCtxPath = join(researchCacheDir(resumeRunId), 'refresh-context.yaml');
  const resumeRefreshCacheExists = existsSync(resumeRefreshCtxPath);
  if (resumeRefreshCacheExists && !args.refresh) {
    console.error(`[create-report-run] cannot resume refresh run ${resumeRunId} without --refresh; the original create-report-run was --refresh and refresh-context.yaml is cached.`);
    console.error('[create-report-run] rerun with --resume --refresh (the cached --refresh-reason will be reused).');
    process.exit(EXIT.failure);
  }
  if (!resumeRefreshCacheExists && args.refresh) {
    console.error(`[create-report-run] cannot promote in-progress run ${resumeRunId} into a refresh: refresh-context.yaml is missing, which means the original create-report-run was a fresh run, not --refresh.`);
    console.error('[create-report-run] either resume the existing fresh run without --refresh, or finalize/discard it and start a new --refresh run separately.');
    process.exit(EXIT.failure);
  }
  printFetchTrailHint(resumeRunId);
  console.error(`[create-report-run] resume: ${resumePath}`);
  console.log(resumePath);
  process.exit(EXIT.ok);
}

const refreshTarget = resolveRefreshTarget({ refresh: args.refresh, matches, refreshOfRunId: args.refreshOfRunId });
checkDuplicateRisk({ matches, refreshTarget });

const inProgressCandidates = inProgressRunsForSlug(companySlug);
if (inProgressCandidates.length) {
  console.error(`[create-report-run] in-progress report folder already exists for company slug "${companySlug}":`);
  printInProgressCandidates(inProgressCandidates);
  console.error('[create-report-run] rerun with --resume (and --resume-run <runId> if more than one candidate is listed) to continue it; duplicate suffix folders are not created.');
  process.exit(EXIT.inProgress);
}

const base = `${args.timestamp}-${companySlug}`;
const path = join(reportsDir, base);
mkdirSync(path, { recursive: true });
// Always create the per-run scratch dir even for non-refresh runs. SKILL.md
// expects agents to be able to set STARTUP_FETCH_LOG_PATH=.research-cache/<runId>/_fetch-log.jsonl
// immediately after this command without an extra mkdir step. fetch-url's
// own mkdir-on-write is only a fallback; pre-creating the dir keeps the
// "scratch lives under .research-cache/<runId>/" invariant explicit.
mkdirSync(researchCacheDir(base), { recursive: true });
writeRefreshContext({ base, companyName, website: args.website, refreshTarget, refreshReason: args.refreshReason });
printFetchTrailHint(base);

// Final hint: the fetch-url skill only writes its audit trail when
// STARTUP_FETCH_LOG_PATH is set. Without it, check-chapter warns by default
// and fails under --strict once sources are cited. Stay on stderr so stdout
// still emits only the path.

console.log(path);
