#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { EXIT, loadWorkflowConfig, normalizeDomain } from './utils.mjs';

function usage(code = EXIT.ok) {
  console.error('Usage: evaluate-report.mjs <report-folder> [--format json|text]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { folder: '', format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!args.folder && !arg.startsWith('-')) args.folder = arg;
    else if (arg === '--format') args.format = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(EXIT.failure);
  }
  if (!args.folder || !['json', 'text'].includes(args.format)) usage(EXIT.failure);
  return args;
}

function loadYaml(path) {
  return yaml.load(readFileSync(path, 'utf8'));
}

function ratio(count, total) {
  return total ? Number((count / total).toFixed(3)) : 0;
}

function countWords(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean).length;
}

function chapterMetrics(chapter) {
  const sources = chapter.localEvidence?.sources ?? [];
  const claims = chapter.localEvidence?.claims ?? [];
  const questions = chapter.localEvidence?.researchQuestions ?? [];
  return {
    key: chapter.artifact,
    sources: sources.length,
    uniqueUrls: new Set(sources.map((source) => source.url)).size,
    domains: new Set(sources.map((source) => normalizeDomain(source.url)).filter(Boolean)).size,
    claims: claims.length,
    questions: questions.length,
    answeredQuestions: questions.filter((question) => question.status === 'answered').length,
    tables: chapter.tables?.length ?? 0,
    figures: chapter.figures?.length ?? 0,
    sectionWords: (chapter.sections ?? []).reduce(
      (total, section) => total + countWords(section.body),
      0,
    ),
    blockingGaps: (chapter.localEvidence?.evidenceGaps ?? [])
      .filter((gap) => gap.severity === 'blocking').length,
  };
}

const args = parseArgs(process.argv.slice(2));
const folder = resolve(args.folder);
const searchStrategy = loadYaml(
  resolve('.agents/skills/startup-research/references/search-strategy.yaml'),
);
const evidence = loadYaml(join(folder, 'evidence.yaml'));
const fullReport = loadYaml(join(folder, 'full-report.yaml'));
const summary = loadYaml(join(folder, 'summary-card.yaml'));
const chapterFiles = readdirSync(folder)
  .filter((file) => /^\d{2}-[a-z0-9-]+\.yaml$/.test(file))
  .sort();
const chapters = chapterFiles.map((file) => loadYaml(join(folder, file)));
const workflowConfig = loadWorkflowConfig({ reportFolder: folder });
const sources = evidence.sources ?? [];
const claims = evidence.claims ?? [];
const chapterSources = chapters.flatMap((chapter) => chapter.localEvidence?.sources ?? []);
const chapterUniqueUrls = new Set(chapterSources.map((source) => source.url));
const uniqueUrls = new Set(sources.map((source) => source.url));
const domains = new Set(sources.map((source) => normalizeDomain(source.url)).filter(Boolean));
const primaryTypes = new Set(['official', 'filing', 'regulatory', 'legal']);
const restrictedStatuses = new Set(['paywall', 'js-only', 'broken', 'rate-limited']);
const independentSources = sources.filter((source) => source.independence === 'independent');
const primarySources = sources.filter((source) => primaryTypes.has(source.sourceType));
const adverseSources = sources.filter((source) => source.stance === 'adverse');
const restrictedSources = sources.filter((source) => restrictedStatuses.has(source.accessStatus));
const lowReputationSources = sources.filter((source) => source.reputationTier === 'low');
const configuredLowSignalDomains = new Set(searchStrategy.quality?.lowSignalDomains ?? []);
const configuredLowSignalSources = sources.filter(
  (source) => configuredLowSignalDomains.has(normalizeDomain(source.url)),
);
const companyControlledSources = sources.filter((source) => source.independence === 'company');
const highConfidenceClaims = claims.filter((claim) => claim.confidence === 'high');
const chapterRows = chapters.map(chapterMetrics);
const totalQuestions = chapterRows.reduce((total, chapter) => total + chapter.questions, 0);
const answeredQuestions = chapterRows.reduce(
  (total, chapter) => total + chapter.answeredQuestions,
  0,
);
const blockingGaps = chapterRows.reduce((total, chapter) => total + chapter.blockingGaps, 0);

const output = {
  schemaVersion: 'startup-report-evaluation-v1',
  reportFolder: folder,
  runId: basename(folder),
  researchProfile: workflowConfig.activeResearchProfile ?? 'deep',
  company: summary.company?.name ?? null,
  recommendation: summary.summary?.recommendation ?? null,
  confidence: summary.summary?.confidence ?? null,
  evidence: {
    sourceEntries: sources.length,
    uniqueUrls: uniqueUrls.size,
    uniqueDomains: domains.size,
    duplicateUrlShare: Number((1 - ratio(uniqueUrls.size, sources.length)).toFixed(3)),
    chapterSourceEntries: chapterSources.length,
    crossChapterReuseShare: Number(
      (1 - ratio(chapterUniqueUrls.size, chapterSources.length)).toFixed(3),
    ),
    primarySourceShare: ratio(primarySources.length, sources.length),
    independentSourceShare: ratio(independentSources.length, sources.length),
    adverseSourceShare: ratio(adverseSources.length, sources.length),
    restrictedSourceShare: ratio(restrictedSources.length, sources.length),
    lowReputationSourceShare: ratio(lowReputationSources.length, sources.length),
    configuredLowSignalSourceShare: ratio(configuredLowSignalSources.length, sources.length),
    companyControlledSourceShare: ratio(companyControlledSources.length, sources.length),
    claims: claims.length,
    highConfidenceClaimShare: ratio(highConfidenceClaims.length, claims.length),
    answeredQuestionShare: ratio(answeredQuestions, totalQuestions),
    blockingGaps,
  },
  output: {
    chapters: chapters.length,
    sections: chapters.reduce((total, chapter) => total + (chapter.sections?.length ?? 0), 0),
    tables: fullReport.tables?.length ?? 0,
    figures: fullReport.figures?.length ?? 0,
    sectionWords: chapterRows.reduce((total, chapter) => total + chapter.sectionWords, 0),
    serializedCharacters: JSON.stringify(fullReport).length,
  },
  chapters: chapterRows,
};

if (args.format === 'json') {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  console.log(`[evaluate-report] ${output.company} (${output.runId})`);
  console.log(`  profile: ${output.researchProfile}`);
  console.log(`  evidence: ${sources.length} ledger entries / ${chapterSources.length} chapter entries / ${uniqueUrls.size} unique URLs / ${domains.size} domains`);
  console.log(`  mix: primary=${output.evidence.primarySourceShare} independent=${output.evidence.independentSourceShare} adverse=${output.evidence.adverseSourceShare} restricted=${output.evidence.restrictedSourceShare} low-reputation=${output.evidence.lowReputationSourceShare} configured-low-signal=${output.evidence.configuredLowSignalSourceShare}`);
  console.log(`  claims/questions: ${claims.length} claims / answered=${output.evidence.answeredQuestionShare} / blocking gaps=${blockingGaps}`);
  console.log(`  output: ${output.output.chapters} chapters / ${output.output.tables} tables / ${output.output.figures} figures / ${output.output.sectionWords} section words`);
}
