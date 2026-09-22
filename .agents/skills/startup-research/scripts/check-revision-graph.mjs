#!/usr/bin/env node
// Walk every reports/<runId>/summary-card.yaml and validate that the
// revision graph (current ↔ superseded pointers) is internally consistent.
// Read-only: writes nothing, owns no on-disk catalog.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIT,
  SUMMARY_CARD_FILE,
  hasText,
  isRunId,
  listDirs,
  normalizeRevision,
  readYaml,
  reportIdentityKey,
  reportsDir,
} from './utils.mjs';
import {
  formatValidationCompact,
  formatValidationText,
  validationEnvelope,
  validationIssue,
} from './contracts/validation-result.mjs';

function parseArgs(argv) {
  const args = { format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') args.format = argv[++i] ?? 'text';
    else if (arg === '-h' || arg === '--help') {
      console.error('Usage: node .agents/skills/startup-research/scripts/check-revision-graph.mjs [--format text|json|compact]');
      process.exit(EXIT.failure);
    } else {
      console.error(`[check:revision-graph] unknown argument: ${arg}`);
      process.exit(EXIT.failure);
    }
  }
  if (!['text', 'json', 'compact'].includes(args.format)) {
    console.error(`[check:revision-graph] invalid --format: ${args.format}`);
    process.exit(EXIT.failure);
  }
  return args;
}

function collectReports() {
  const reports = [];
  const issues = [];
  for (const runId of listDirs(reportsDir).sort().reverse()) {
    const cardPath = join(reportsDir, runId, SUMMARY_CARD_FILE);
    if (!existsSync(cardPath)) continue;
    let card;
    try { card = readYaml(cardPath); }
    catch (err) {
      issues.push(validationIssue({
        path: `${runId}/${SUMMARY_CARD_FILE}`,
        message: `card parse failed: ${err.message}`,
        dimension: 'yamlParse',
        code: 'revisionGraph.yamlParse',
        fix: 'Fix YAML syntax in the summary-card.yaml.',
      }));
      continue;
    }
    const revision = normalizeRevision(card?.revision);
    reports.push({
      runId,
      company: card?.company ?? {},
      revisionStatus: revision.status,
      refreshOfRunId: revision.refreshOfRunId,
      supersededByRunId: revision.supersededByRunId,
    });
  }
  return { reports, issues };
}

function validateRevisionGraph(reports) {
  const issues = [];
  const byRunId = new Map(reports.map((report) => [report.runId, report]));
  const push = (runId, message, code = 'revisionGraph.invalid', fix = null) => {
    issues.push(validationIssue({
      path: `${runId}/${SUMMARY_CARD_FILE}`,
      message,
      dimension: 'revisionGraph',
      code,
      fix,
    }));
  };
  for (const report of reports) {
    const status = report.revisionStatus ?? 'current';
    const refreshOfRunId = report.refreshOfRunId;
    const supersededByRunId = report.supersededByRunId;

    if (status === 'current' && hasText(supersededByRunId)) {
      push(report.runId, `current reports must not set supersededByRunId`, 'revisionGraph.currentHasSuperseded',
        'Clear revision.supersededByRunId on current reports.');
    }
    if (status === 'superseded' && !hasText(supersededByRunId)) {
      push(report.runId, `superseded reports must set supersededByRunId`, 'revisionGraph.supersededMissingPointer',
        'Set revision.supersededByRunId to the new run id that replaced this report.');
    }
    if (hasText(refreshOfRunId) && refreshOfRunId === supersededByRunId) {
      push(report.runId, `refreshOfRunId and supersededByRunId cannot point to the same run`, 'revisionGraph.selfReference');
    }

    for (const [field, value] of Object.entries({ refreshOfRunId, supersededByRunId })) {
      if (value == null) continue;
      if (!hasText(value)) {
        push(report.runId, `revision.${field} must be a non-empty runId string or null`, 'revisionGraph.invalidId');
        continue;
      }
      if (!isRunId(value)) push(report.runId, `revision.${field}=${value} is not a valid report run id`, 'revisionGraph.invalidId');
      if (value === report.runId) push(report.runId, `revision.${field} cannot reference the same report run`, 'revisionGraph.selfReference');
      if (!byRunId.has(value)) push(report.runId, `revision.${field} references a missing finalized report: ${value}`, 'revisionGraph.missingTarget');
    }

    if (hasText(refreshOfRunId) && byRunId.has(refreshOfRunId)) {
      const previous = byRunId.get(refreshOfRunId);
      if (previous.supersededByRunId !== report.runId) {
        push(report.runId, `refreshOfRunId=${refreshOfRunId} must point to a report whose revision.supersededByRunId is ${report.runId}`, 'revisionGraph.brokenLink',
          'Run link-refresh.mjs to fix the back-pointer on the prior report.');
      }
    }
    if (hasText(supersededByRunId) && byRunId.has(supersededByRunId)) {
      const next = byRunId.get(supersededByRunId);
      if (next.refreshOfRunId !== report.runId) {
        push(report.runId, `supersededByRunId=${supersededByRunId} must point to a report whose revision.refreshOfRunId is ${report.runId}`, 'revisionGraph.brokenLink',
          'Run link-refresh.mjs to fix the forward-pointer on the new report.');
      }
    }
  }
  return issues;
}

function validateCurrentDuplicates(reports) {
  const issues = [];
  const groups = new Map();
  for (const report of reports) {
    if (report.revisionStatus === 'superseded') continue;
    const key = reportIdentityKey(report.company);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    const runIds = matches.map((report) => report.runId).sort();
    for (const report of matches) {
      issues.push(validationIssue({
        path: `${report.runId}/${SUMMARY_CARD_FILE}`,
        message: `multiple current reports have the same normalized company name and website domain: ${runIds.join(', ')}`,
        dimension: 'revisionGraph',
        code: 'revisionGraph.duplicateCurrentIdentity',
        fix: 'Run npm run reports:duplicates, review the exact-identity group, then run npm run reports:dedupe to keep only the newest finalized report.',
      }));
    }
  }
  return issues;
}

const args = parseArgs(process.argv.slice(2));
const { reports, issues: parseIssues } = collectReports();
const issues = [...parseIssues, ...validateRevisionGraph(reports), ...validateCurrentDuplicates(reports)];

const result = validationEnvelope({
  ok: issues.length === 0,
  validator: 'check-revision-graph',
  issues,
  summary: { reports: reports.length },
});

if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
else if (args.format === 'compact') console.log(formatValidationCompact(result));
else if (result.ok) console.log(`[check:revision-graph] ✓ ${reports.length} report(s); revision graph consistent.`);
else console.error(formatValidationText(result, { failureMessage: '[check:revision-graph] failures' }));

process.exit(result.ok ? EXIT.ok : EXIT.failure);
