#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  EXIT,
  SUMMARY_CARD_FILE,
  isFinalizedReportFolder,
  listDirs,
  normalizeRevision,
  readYaml,
  reportIdentityKey,
  reportsDir,
} from './utils.mjs';

function usage(code = EXIT.ok) {
  console.error('Usage: node .agents/skills/startup-research/scripts/dedupe-reports.mjs [--apply] [--format text|json]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { apply: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--format') args.format = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(EXIT.failure);
  }
  if (!['text', 'json'].includes(args.format)) usage(EXIT.failure);
  return args;
}

function collectExactDuplicateGroups() {
  const groups = new Map();
  for (const runId of listDirs(reportsDir)) {
    const folder = join(reportsDir, runId);
    const cardPath = join(folder, SUMMARY_CARD_FILE);
    if (!isFinalizedReportFolder(folder) || !existsSync(cardPath)) continue;
    const card = readYaml(cardPath);
    const revision = normalizeRevision(card?.revision);
    if (revision.status === 'superseded') continue;
    const identity = reportIdentityKey(card?.company);
    if (!identity) continue;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push({
      runId,
      folder,
      company: card.company,
      revision,
    });
  }

  return [...groups.entries()]
    .filter(([, reports]) => reports.length > 1)
    .map(([identity, reports]) => {
      const ordered = reports.sort((a, b) => b.runId.localeCompare(a.runId));
      const blocked = ordered.some((report) => (
        report.revision.refreshOfRunId || report.revision.supersededByRunId
      ));
      return {
        identity,
        keep: ordered[0],
        remove: ordered.slice(1),
        blocked,
        reason: blocked ? 'revision-linked reports require refresh-graph repair, not deletion' : null,
      };
    })
    .sort((a, b) => a.identity.localeCompare(b.identity));
}

function removeReport(report) {
  const expected = resolve(reportsDir, report.runId);
  if (resolve(report.folder) !== expected) {
    throw new Error(`refusing to delete path outside reports/: ${report.folder}`);
  }
  if (!isFinalizedReportFolder(expected)) {
    throw new Error(`refusing to delete non-finalized report folder: ${expected}`);
  }
  rmSync(expected, { recursive: true, force: false });
}

const args = parseArgs(process.argv.slice(2));
const groups = collectExactDuplicateGroups();
const result = {
  ok: groups.every((group) => !group.blocked),
  apply: args.apply,
  groupCount: groups.length,
  removalCount: groups.reduce((sum, group) => sum + (group.blocked ? 0 : group.remove.length), 0),
  groups: groups.map((group) => ({
    identity: group.identity,
    keepRunId: group.keep.runId,
    removeRunIds: group.remove.map((report) => report.runId),
    blocked: group.blocked,
    reason: group.reason,
  })),
};

if (args.apply) {
  for (const group of groups) {
    if (group.blocked) continue;
    for (const report of group.remove) removeReport(report);
  }
}

if (args.format === 'json') {
  console.log(JSON.stringify(result, null, 2));
} else if (!groups.length) {
  console.log('[dedupe-reports] ✓ no exact current duplicates found.');
} else {
  for (const group of result.groups) {
    console.log(`${group.blocked ? 'BLOCKED' : args.apply ? 'REMOVED' : 'WOULD REMOVE'} ${group.removeRunIds.join(', ')}`);
    console.log(`  keep: ${group.keepRunId}`);
    console.log(`  identity: ${group.identity}`);
    if (group.reason) console.log(`  reason: ${group.reason}`);
  }
  const action = args.apply ? 'removed' : 'would remove';
  console.log(`[dedupe-reports] ${action} ${result.removalCount} report(s) across ${result.groupCount} exact-identity group(s).`);
  if (!args.apply && result.removalCount) {
    console.log('[dedupe-reports] review the list, then rerun with --apply.');
  }
}

process.exit(result.ok ? EXIT.ok : EXIT.failure);
