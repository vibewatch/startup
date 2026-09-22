#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  isFinalizedReportFolder,
  normalizeCompanyName,
  normalizeDomain,
} from './utils.mjs';

const reportsDir = resolve('reports');

function usage(code = 0) {
  console.error('Usage: plan-refresh-batch.mjs [--date YYYY-MM-DD] [--limit N] [--format json|matrix] [--out <path>]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { date: '', limit: 0, format: 'json', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') args.date = argv[++i] ?? '';
    else if (arg === '--limit') args.limit = Number(argv[++i] ?? 0);
    else if (arg === '--format') args.format = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(1);
  }
  if (!['json', 'matrix'].includes(args.format)) usage(1);
  if (!Number.isInteger(args.limit) || args.limit < 0) {
    throw new Error('--limit must be a non-negative integer.');
  }
  return args;
}

function parseDate(value) {
  const date = value ? new Date(`${value}T00:00:00Z`) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function runDate(runId) {
  const isoMatch = runId.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoMatch) return isoMatch[1];
  const compactMatch = runId.match(/^(\d{4})(\d{2})(\d{2})/);
  return compactMatch
    ? `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`
    : '0000-00-00';
}

const args = parseArgs(process.argv.slice(2));
const today = parseDate(args.date);
const year = today.getUTCFullYear();
const month = today.getUTCMonth();
const monthStart = new Date(Date.UTC(year, month, 1));
const monthEnd = new Date(Date.UTC(year, month + 1, 0));
const remainingDays = monthEnd.getUTCDate() - today.getUTCDate() + 1;

const entries = await readdir(reportsDir, { withFileTypes: true });
const currentReports = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const folder = join(reportsDir, entry.name);
  if (!isFinalizedReportFolder(folder)) continue;
  const summary = yaml.load(await readFile(join(folder, 'summary-card.yaml'), 'utf8'));
  if (summary?.revision?.status !== 'current') continue;
  const companyName = String(summary.company?.name ?? '').trim();
  const companyUrl = String(summary.company?.website ?? '').trim();
  currentReports.push({
    runId: basename(folder),
    runDate: String(summary.runDate ?? runDate(entry.name)),
    companyName,
    companyUrl,
    identity: `${normalizeCompanyName(companyName)}|${normalizeDomain(companyUrl)}`,
  });
}

const identityCounts = new Map();
for (const report of currentReports) {
  identityCounts.set(report.identity, (identityCounts.get(report.identity) ?? 0) + 1);
}
const duplicateIdentities = [...identityCounts].filter(([, count]) => count > 1);
if (duplicateIdentities.length) {
  throw new Error(`Refusing to schedule duplicate current identities: ${JSON.stringify(duplicateIdentities)}`);
}

const monthStartText = isoDate(monthStart);
const eligible = currentReports
  .filter((report) => report.runDate < monthStartText)
  .sort((left, right) => (
    left.runDate.localeCompare(right.runDate)
    || left.companyName.localeCompare(right.companyName)
    || left.runId.localeCompare(right.runId)
  ));
const dailyRequired = eligible.length ? Math.ceil(eligible.length / remainingDays) : 0;
const plannedCount = args.limit
  ? Math.min(args.limit, eligible.length)
  : dailyRequired;
const monthlyCompletionGuaranteed = plannedCount >= dailyRequired;
const matrix = {
  include: eligible.slice(0, plannedCount).map((report) => ({
    runId: report.runId,
    companyName: report.companyName,
    companyUrl: report.companyUrl,
    refreshReason: `Scheduled monthly refresh for ${today.toISOString().slice(0, 7)}`,
  })),
};
const output = args.format === 'matrix' ? matrix : {
  schemaVersion: 'startup-refresh-batch-v1',
  generatedAt: new Date().toISOString(),
  date: isoDate(today),
  monthStart: monthStartText,
  monthEnd: isoDate(monthEnd),
  remainingDays,
  currentReportCount: currentReports.length,
  eligibleReportCount: eligible.length,
  dailyRequired,
  plannedCount,
  monthlyCompletionGuaranteed,
  matrix,
};
const serialized = `${JSON.stringify(output, null, args.format === 'matrix' ? 0 : 2)}\n`;
if (args.out) {
  const out = resolve(args.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, serialized);
} else {
  process.stdout.write(serialized);
}
if (!monthlyCompletionGuaranteed) {
  console.error(`Warning: today's batch needs ${dailyRequired} reports for monthly completion; limit selected ${plannedCount}.`);
}
