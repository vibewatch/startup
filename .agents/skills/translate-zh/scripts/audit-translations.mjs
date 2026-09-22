#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { checkPairQuality } from './check-translation-quality.mjs';

const reportsDir = resolve('reports');

function usage(code = 0) {
  console.error('Usage: audit-translations.mjs [--limit <count>] [--report <run-id>] [--format text|json]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { limit: 0, report: null, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--report') args.report = argv[++i] ?? '';
    else if (arg === '--format') args.format = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(1);
  }
  if (
    !Number.isInteger(args.limit)
    || args.limit < 0
    || (args.report !== null && (!args.report || args.report.includes('/') || args.report.includes('\\')))
    || !['text', 'json'].includes(args.format)
  ) usage(1);
  return args;
}

function load(path) {
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
}

const args = parseArgs(process.argv.slice(2));
let folders = readdirSync(reportsDir)
  .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
  .map((name) => join(reportsDir, name))
  .filter((folder) => {
    try { return statSync(folder).isDirectory(); } catch { return false; }
  })
  .sort();
if (args.report) {
  folders = folders.filter((folder) => folder.split('/').pop() === args.report);
  if (!folders.length) {
    console.error(`[audit-translations] report not found: ${args.report}`);
    process.exit(1);
  }
}
if (args.limit) folders = folders.slice(-args.limit);

const findings = [];
const reports = [];
let checkedPairs = 0;
let cleanPairs = 0;
let hardPassPairs = 0;
for (const folder of folders) {
  const report = {
    runId: folder.split('/').pop(),
    checkedPairs: 0,
    cleanPairs: 0,
    hardPassPairs: 0,
    errorCount: 0,
    warningCount: 0,
  };
  for (const basename of ['summary-card', 'full-report']) {
    const enPath = join(folder, `${basename}.yaml`);
    const zhPath = join(folder, `${basename}.zh.yaml`);
    if (!existsSync(enPath) || !existsSync(zhPath)) continue;
    checkedPairs += 1;
    report.checkedPairs += 1;
    const issues = checkPairQuality(load(enPath), load(zhPath));
    if (!issues.length) {
      cleanPairs += 1;
      report.cleanPairs += 1;
    }
    if (!issues.some((issue) => issue.severity === 'error')) {
      hardPassPairs += 1;
      report.hardPassPairs += 1;
    }
    for (const issue of issues) {
      if (issue.severity === 'error') report.errorCount += 1;
      if (issue.severity === 'warning') report.warningCount += 1;
      findings.push({
        runId: report.runId,
        artifact: basename,
        ...issue,
      });
    }
  }
  report.hardPassRatePct = report.checkedPairs
    ? Number(((report.hardPassPairs / report.checkedPairs) * 100).toFixed(1))
    : 100;
  report.cleanRatePct = report.checkedPairs
    ? Number(((report.cleanPairs / report.checkedPairs) * 100).toFixed(1))
    : 100;
  reports.push(report);
}

const byCode = {};
for (const finding of findings) {
  byCode[finding.code] = (byCode[finding.code] ?? 0) + 1;
}
const result = {
  schemaVersion: 'translation-quality-audit-v1',
  folders: folders.length,
  checkedPairs,
  cleanPairs,
  hardPassPairs,
  hardPassRatePct: checkedPairs ? Number(((hardPassPairs / checkedPairs) * 100).toFixed(1)) : 100,
  cleanRatePct: checkedPairs ? Number(((cleanPairs / checkedPairs) * 100).toFixed(1)) : 100,
  errorCount: findings.filter((finding) => finding.severity === 'error').length,
  warningCount: findings.filter((finding) => finding.severity === 'warning').length,
  byCode: Object.fromEntries(Object.entries(byCode).sort((a, b) => b[1] - a[1])),
  reports: reports.sort((a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount || a.runId.localeCompare(b.runId)),
  findings,
};

if (args.format === 'json') {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[audit-translations] ${checkedPairs} pair(s), hard-pass ${result.hardPassRatePct}%, fully clean ${result.cleanRatePct}%, ${result.errorCount} error(s), ${result.warningCount} warning(s).`);
  for (const [code, count] of Object.entries(result.byCode)) console.log(`  ${code}: ${count}`);
}
