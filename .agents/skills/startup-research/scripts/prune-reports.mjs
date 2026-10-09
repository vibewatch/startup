#!/usr/bin/env node
import { planReportPruning, pruneSupersededReports } from './report-retention.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply') || args.length > 1) {
  console.error('Usage: prune-reports.mjs [--apply]');
  process.exit(1);
}
try {
  const apply = args.includes('--apply');
  const plan = apply ? pruneSupersededReports() : planReportPruning();
  for (const { runId, targetRunId } of plan.removals) {
    console.log(`[prune-reports] ${apply ? 'removed' : 'would remove'} ${runId} -> ${targetRunId}`);
  }
  console.log(`[prune-reports] ${apply ? 'removed' : 'would remove'} ${plan.removals.length} superseded report(s); current English and Chinese files unchanged.`);
  if (!apply && plan.removals.length) console.log('[prune-reports] review the targets, then rerun with --apply.');
} catch (error) {
  console.error(`[prune-reports] ${error.message}`);
  process.exitCode = 1;
}
