#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  EXIT,
  getAnalysisArtifacts,
  isRunId,
  loadWorkflowConfig,
  readYaml,
  researchCacheDir,
  runDateFromRunId,
  tryReadYaml,
} from './utils.mjs';

const strategyPath = resolve('.agents/skills/startup-research/references/search-strategy.yaml');

function usage(code = EXIT.ok) {
  console.error('Usage: build-search-plan.mjs --report-folder <path> [--company <name>] [--website <url>] [--chapter <key|order>] [--profile fast|deep] [--format json|yaml] [--out <path>]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { folder: '', company: '', website: '', chapter: '', profile: 'deep', format: 'json', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-folder') args.folder = argv[++i] ?? '';
    else if (arg === '--company') args.company = argv[++i] ?? '';
    else if (arg === '--website') args.website = argv[++i] ?? '';
    else if (arg === '--chapter') args.chapter = argv[++i] ?? '';
    else if (arg === '--profile') args.profile = argv[++i] ?? '';
    else if (arg === '--format') args.format = argv[++i] ?? '';
    else if (arg === '--out') args.out = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(EXIT.failure);
  }
  if (!args.folder || !['json', 'yaml'].includes(args.format)) usage(EXIT.failure);
  return args;
}

function loadRefreshContext(runId) {
  const result = tryReadYaml(join(researchCacheDir(runId), 'refresh-context.yaml'));
  return result.ok ? result.value : null;
}

function previousGaps(refreshContext) {
  const path = refreshContext?.previousReport?.summaryCardPath;
  if (!path || !existsSync(path)) return [];
  return readYaml(path)?.summary?.unresolvedGaps ?? [];
}

function sharedQueries({ company, domain, year, strategy, budget }) {
  const provider = (intent) => strategy.routing[intent] ?? strategy.routing.broad;
  return [
    {
      intent: 'primary',
      query: `"${company}" ${domain ? `site:${domain}` : 'official'} product company`,
      rationale: 'Establish the official product, positioning, and current company facts.',
    },
    {
      intent: 'freshness',
      query: `"${company}" funding valuation revenue customers leadership launches ${year}`,
      rationale: 'Re-check volatile company facts using the canonical run year.',
    },
    {
      intent: 'adverse',
      query: `"${company}" lawsuit regulatory outage breach complaints risks ${year}`,
      rationale: 'Actively seek adverse and contradictory evidence.',
    },
  ].slice(0, budget.globalQueries).map((query, index) => ({
    id: `G${String(index + 1).padStart(2, '0')}`,
    ...query,
    preferredProvider: provider(query.intent)[0],
    fallbackProviders: provider(query.intent).slice(1),
    maxResults: budget.maxResultsPerQuery,
  }));
}

function chapterQueries({ company, year, chapter, mode, strategy, gaps, budget }) {
  const provider = (intent) => strategy.routing[intent] ?? strategy.routing.broad;
  const focus = strategy.chapterFocus?.[chapter.key] ?? [
    `${chapter.title} company evidence`,
    chapter.contentRequirements.slice(0, 1).join(' '),
  ];
  const chapterQueries = [
    {
      intent: 'broad',
      query: `"${company}" ${focus[0]}`,
      rationale: `Discover chapter-specific evidence for ${chapter.key}.`,
    },
    {
      intent: 'semantic',
      query: `"${company}" ${focus[1] ?? focus[0]}`,
      rationale: 'Close the highest-priority content requirements with semantic search.',
    },
    {
      intent: 'primary',
      query: `"${company}" official ${chapter.title}`,
      rationale: `Find first-party evidence specific to ${chapter.key}.`,
    },
  ];
  const queries = [];
  if (mode === 'fresh') {
    queries.push(...chapterQueries.slice(0, budget.freshQueriesPerChapter));
  } else {
    if (gaps.length) {
      queries.push(...gaps.slice(0, budget.maxGapQueriesPerChapter).map((gap) => ({
        intent: 'semantic',
        query: `"${company}" ${gap} ${year}`,
        rationale: 'Carry forward and close an unresolved gap from the prior report.',
      })));
    }
    queries.push(...chapterQueries.slice(0, budget.refreshQueriesPerChapter));
  }
  return queries.map((query, index) => ({
    id: `${chapter.letter}${String(index + 1).padStart(2, '0')}`,
    ...query,
    preferredProvider: provider(query.intent)[0],
    fallbackProviders: provider(query.intent).slice(1),
    maxResults: budget.maxResultsPerQuery,
  }));
}

const args = parseArgs(process.argv.slice(2));
const folder = resolve(args.folder);
const runId = basename(folder);
if (!isRunId(runId)) {
  console.error(`[build-search-plan] report folder must end in a valid runId: ${folder}`);
  process.exit(EXIT.failure);
}
const strategy = yaml.load(readFileSync(strategyPath, 'utf8'));
const budget = strategy.budgets.profiles?.[args.profile];
if (!budget) {
  console.error(`[build-search-plan] unknown profile: ${args.profile}`);
  process.exit(EXIT.failure);
}
const refreshContext = loadRefreshContext(runId);
const company = args.company || refreshContext?.previousReport?.company?.name || '';
const website = args.website || refreshContext?.previousReport?.company?.website || '';
if (!company) {
  console.error('[build-search-plan] --company is required for fresh runs; refresh runs infer it from refresh-context.yaml.');
  process.exit(EXIT.failure);
}
const config = loadWorkflowConfig({ reportFolder: folder });
let chapters = getAnalysisArtifacts(config);
if (args.chapter) {
  chapters = chapters.filter((chapter) => (
    chapter.key === args.chapter || String(chapter.order) === String(args.chapter)
  ));
  if (!chapters.length) {
    console.error(`[build-search-plan] unknown chapter selector: ${args.chapter}`);
    process.exit(EXIT.failure);
  }
}
let domain = '';
try {
  const url = new URL(website.startsWith('http') ? website : `https://${website}`);
  domain = url.hostname.replace(/^www\./, '');
} catch {}
const mode = refreshContext ? 'refresh' : 'fresh';
const gaps = previousGaps(refreshContext);
const output = {
  schemaVersion: 'startup-search-plan-v1',
  runId,
  runDate: runDateFromRunId(runId),
  mode,
  profile: args.profile,
  company: { name: company, website: website || null, domain: domain || null },
  strategy: {
    concurrency: budget.concurrency,
    maxResultsPerQuery: budget.maxResultsPerQuery,
    cacheTtlHours: strategy.budgets.cacheTtlHours,
    reportEvidenceTarget: {
      minDistinctDomains: config.reportGate.minDistinctDomains,
    },
    evidenceRule: 'Search results discover URLs; fetch every retained URL with fetch-url before citation.',
    previousUnresolvedGaps: gaps,
  },
  globalQueries: sharedQueries({
    company,
    domain,
    year: runId.slice(0, 4),
    strategy,
    budget,
  }),
  chapters: chapters.map((chapter) => ({
    key: chapter.key,
    order: chapter.order,
    file: chapter.file,
    evidenceTarget: {
      minSources: chapter.gate.minLocalSources,
      minNetNewSources: chapter.gate.minNetNewSources,
      minDomains: chapter.gate.minSourceDomains,
    },
    queries: chapterQueries({
      company,
      year: runId.slice(0, 4),
      chapter,
      mode,
      strategy,
      gaps,
      budget,
    }),
  })),
};
const rendered = args.format === 'yaml'
  ? yaml.dump(output, { lineWidth: 120, noRefs: true, sortKeys: false })
  : `${JSON.stringify(output, null, 2)}\n`;
if (args.out) writeFileSync(resolve(args.out), rendered, 'utf8');
else process.stdout.write(rendered);
