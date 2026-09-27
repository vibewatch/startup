#!/usr/bin/env node
// Deterministically assemble full-report.yaml and summary-card.yaml from
// the eight analysis chapter YAMLs, the consolidated evidence.yaml, and a
// hand-written report-meta.yaml that carries the judgment fields the chapters
// do not encode (recommendation, cover metrics, startup introduction, top
// strengths/risks, unresolved gaps, overall score, etc.).
//
// Re-running this script is idempotent and safe: it is the single source of
// truth for the consolidated artifacts so the agent never hand-edits them.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EXIT, FINAL_ARTIFACTS, REPORT_META_FILE, getAnalysisArtifacts, loadWorkflowConfig, parseDate, tryReadYaml, writeYaml } from './utils.mjs';
import { ReportMetaSchema, SCHEMA_VERSION, schemaErrors } from './contracts/report-artifacts.schema.mjs';
import { formatValidationCompact, validationEnvelope, validationIssue } from './contracts/validation-result.mjs';

const DEFAULT_DISCLAIMER = 'This report is a public-evidence diligence snapshot, not investment advice. Important financial, legal, technical, and contractual facts remain non-public and should be verified directly with management and primary documents before any investment decision.';
const CLAIM_ID_RE = /^C[A-Z]\d{3}$/;
const INLINE_CLAIM_REF_RE = /\[(C[A-Z]\d{3}|C\d{3})\]/g;

// Module-scope envelope state. abort() routes every error through the shared
// validation-result envelope when --format=json|compact, so finalize-report
// agents can read issues[].dimension/.fix without learning a per-script
// prose format. The text path emits the human-readable `[build-report] <message>`
// stderr line for direct CLI use.
let outputFormat = 'text';
let reportFolderForEnvelope = null;

function abort(messageOrOpts) {
  const opts = typeof messageOrOpts === 'string' ? { message: messageOrOpts } : (messageOrOpts ?? {});
  const {
    message = 'unknown failure',
    dimension = 'reportContract',
    code = 'buildReport.failure',
    fix = null,
    path = null,
    exitCode = EXIT.failure,
  } = opts;
  if (outputFormat === 'text') {
    console.error(`[build-report] ${message}`);
  } else {
    const envelope = validationEnvelope({
      ok: false,
      validator: 'build-report',
      reportFolder: reportFolderForEnvelope,
      issues: [validationIssue({ path: path ?? 'build-report', message, dimension, code, fix })],
      summary: { stage: 'build-report' },
    });
    if (outputFormat === 'json') console.log(JSON.stringify(envelope, null, 2));
    else console.log(formatValidationCompact(envelope));
  }
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { folder: null, dryRun: false, check: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--check') args.check = true;
    else if (arg === '--format') {
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) abort(`--format requires a value (text|json|compact)\nUsage: node .agents/skills/startup-research/scripts/build-report.mjs <report-folder> [--dry-run | --check] [--format text|json|compact]`);
      args.format = next;
    } else if (arg === '-h' || arg === '--help') abort(`Usage: node .agents/skills/startup-research/scripts/build-report.mjs <report-folder> [--dry-run | --check] [--format text|json|compact]`);
    else if (arg.startsWith('-')) abort(`unknown flag: ${arg}\nUsage: node .agents/skills/startup-research/scripts/build-report.mjs <report-folder> [--dry-run | --check] [--format text|json|compact]`);
    else if (!args.folder) args.folder = arg;
    else abort(`unexpected positional argument: ${arg}\nUsage: node .agents/skills/startup-research/scripts/build-report.mjs <report-folder> [--dry-run | --check] [--format text|json|compact]`);
  }
  if (!['text', 'json', 'compact'].includes(args.format)) abort(`invalid --format: ${args.format} (expected text|json|compact)`);
  if (args.dryRun && args.check) abort('--dry-run and --check cannot be combined');
  return args;
}

function main() {
const args = parseArgs(process.argv.slice(2));
outputFormat = args.format;
if (!args.folder) {
  abort('Usage: node .agents/skills/startup-research/scripts/build-report.mjs <report-folder> [--dry-run | --check] [--format text|json|compact]');
}

const reportFolder = resolve(args.folder);
reportFolderForEnvelope = reportFolder;
if (!existsSync(reportFolder)) abort({ message: `report folder not found: ${reportFolder}`, dimension: 'missingArtifact', code: 'buildReport.reportFolderMissing', fix: 'Create the report folder with create-report-run.mjs before running build-report.mjs.', path: reportFolder, exitCode: EXIT.notFound });

const config = loadWorkflowConfig({ reportFolder });
const chapters = getAnalysisArtifacts(config);
const evidenceFile = FINAL_ARTIFACTS.evidence.file;
const fullReportFile = FINAL_ARTIFACTS.fullReport.file;
const summaryCardFile = FINAL_ARTIFACTS.summaryCard.file;

function readRequiredYaml(file, label) {
  const path = join(reportFolder, file);
  const result = tryReadYaml(path);
  if (!result.ok) {
    if (result.error.startsWith('ENOENT')) {
      abort({ message: `missing ${label}: ${path}`, dimension: 'missingArtifact', code: 'buildReport.missingArtifact', fix: `Author ${file} (or run the upstream step that produces it) before re-running build-report.mjs.`, path: file, exitCode: EXIT.notFound });
    }
    abort({ message: `failed to parse ${label} (${file}): ${result.error}`, dimension: 'yamlParse', code: 'buildReport.yamlParse', fix: `Fix YAML syntax in ${file}.`, path: file });
  }
  return result.value;
}

const meta = readRequiredYaml(REPORT_META_FILE, 'report-meta');
const evidence = readRequiredYaml(evidenceFile, 'evidence ledger');
const chapterDocs = chapters.map((spec) => {
  const doc = readRequiredYaml(spec.file, `chapter ${spec.order}`);
  if (doc.artifact !== spec.artifact) {
    abort({ message: `${spec.file}: artifact "${doc.artifact}" does not match chapter key "${spec.artifact}"`, dimension: 'documentHead', code: 'buildReport.artifactMismatch', fix: `Set artifact: "${spec.artifact}" at the head of ${spec.file}.`, path: spec.file });
  }
  return { spec, doc };
});

// ---------------------------------------------------------------------------
// guardrails on report-meta.yaml shape
// ---------------------------------------------------------------------------
// All shape and enum guarantees come from ReportMetaSchema (single source of
// truth shared with check-report-meta.mjs). build-report runs the same Zod
// schema so it can be invoked standalone without first running check-report-meta.
function enforceReportMetaShape(metaDoc) {
  const issues = schemaErrors(ReportMetaSchema, metaDoc, {
    path: REPORT_META_FILE,
    dimension: 'reportMetaShape',
    source: 'scripts/contracts/report-artifacts.schema.mjs',
    fix: 'Run check-report-meta.mjs and fix the reported issues before re-running build-report.',
  });
  if (issues.length) {
    const lines = issues.slice(0, 8).map((issue) => `  - ${issue.path}: ${issue.message}`);
    const trailer = issues.length > 8 ? `\n  - ... and ${issues.length - 8} more (run check-report-meta.mjs for the full list)` : '';
    abort({ message: `${REPORT_META_FILE} fails ReportMetaSchema:\n${lines.join('\n')}${trailer}`, dimension: 'reportMetaShape', code: 'buildReport.reportMetaShape', fix: 'Run check-report-meta.mjs and fix the reported issues before re-running build-report.', path: REPORT_META_FILE });
  }
}

function collectReportMetaClaimRefs(value, path = REPORT_META_FILE, out = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(INLINE_CLAIM_REF_RE)) out.push({ ref: match[1], path });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectReportMetaClaimRefs(item, `${path}.${index}`, out));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'claimRefs') {
      if (!Array.isArray(child)) abort({ message: `${path}.claimRefs must be an array`, dimension: 'reportMetaShape', code: 'buildReport.claimRefsShape', fix: `Make ${path}.claimRefs an array of claim id strings.`, path });
      child.forEach((ref, index) => {
        if (typeof ref !== 'string') abort({ message: `${path}.claimRefs.${index} must be a claim id string`, dimension: 'reportMetaShape', code: 'buildReport.claimRefStringRequired', fix: `Replace ${path}.claimRefs.${index} with a C<ChapterLetter>### string.`, path: `${path}.claimRefs.${index}` });
        out.push({ ref, path: `${path}.claimRefs.${index}` });
      });
      continue;
    }
    if (key === 'claimRef') {
      if (typeof child !== 'string') abort({ message: `${path}.claimRef must be a claim id string`, dimension: 'reportMetaShape', code: 'buildReport.claimRefStringRequired', fix: `Replace ${path}.claimRef with a C<ChapterLetter>### string (or remove it).`, path: `${path}.claimRef` });
      out.push({ ref: child, path: `${path}.claimRef` });
      continue;
    }
    collectReportMetaClaimRefs(child, `${path}.${key}`, out);
  }
  return out;
}

function checkReportMetaClaimRefs(metaDoc, evidenceLedger) {
  const claimIds = new Set((evidenceLedger.claims ?? []).map((claim) => claim?.id).filter(Boolean));
  if (!claimIds.size) abort({ message: `${evidenceFile} has no claims; run build-evidence-ledger.mjs before build-report.mjs`, dimension: 'missingArtifact', code: 'buildReport.evidenceEmpty', fix: 'Run build-evidence-ledger.mjs to consolidate chapter localEvidence into evidence.yaml.', path: evidenceFile });
  for (const { ref, path } of collectReportMetaClaimRefs(metaDoc)) {
    if (!CLAIM_ID_RE.test(ref)) {
      abort({ message: `${path} has invalid claim ref ${ref}; expected C<ChapterLetter><Seq3> (for example CO001)`, dimension: 'claimRefs', code: 'buildReport.claimRefFormat', fix: `Replace ${ref} at ${path} with a C<ChapterLetter><Seq3> id (e.g. CO001).`, path });
    }
    if (!claimIds.has(ref)) {
      abort({ message: `${path} references missing claim ${ref} in ${evidenceFile}`, dimension: 'claimRefs', code: 'buildReport.claimRefMissing', fix: `Either add ${ref} to a chapter's localEvidence.claims (then re-run build-evidence-ledger.mjs), or replace ${path}.${ref} with an existing claim id.`, path });
    }
  }
}

enforceReportMetaShape(meta);
checkReportMetaClaimRefs(meta, evidence);

const slug = meta.slug;
const runDate = meta.runDate;
const companyName = meta.company.name;

// ---------------------------------------------------------------------------
// chapter → 91 chapter object
// ---------------------------------------------------------------------------
function paragraphBlock(section) {
  return {
    type: 'paragraph',
    body: section.body,
    claimRefs: section.claimRefs ?? [],
  };
}

function calloutBlock(callout) {
  // Chapter callouts and report callout blocks share a single calloutType
  // vocabulary: strength | risk | recommendation | insight | assumption.
  return {
    type: 'callout',
    title: callout.title,
    body: callout.body,
    calloutType: callout.calloutType ?? 'insight',
    claimRefs: callout.claimRefs ?? [],
  };
}

function tableRefBlock(table) {
  return {
    type: 'table',
    tableRef: table.id,
    claimRefs: table.claimRefs ?? [],
  };
}

function figureRefBlock(figure) {
  return {
    type: 'figure',
    figureRef: figure.id,
    claimRefs: figure.claimRefs ?? [],
  };
}

function buildChapter({ spec, doc }) {
  // Chapter numbering matches the configured source order: the first analysis
  // chapter is numbered 1, with no cover placeholder.
  const reportChapterNumber = spec.order;
  const tables = doc.tables ?? [];
  const figures = doc.figures ?? [];
  const callouts = doc.callouts ?? [];
  const tablesById = new Map(tables.filter((t) => t?.id).map((t) => [t.id, t]));
  const figuresById = new Map(figures.filter((f) => f?.id).map((f) => [f.id, f]));
  // Sections may declare tableRefs[] / figureRefs[] to anchor specific
  // exhibits inside their prose. Each id may appear in at most one section
  // across the chapter (validated by check-chapter); anything left over
  // lands in the trailing Exhibits section so legacy chapters that author
  // no per-section refs still render every artifact.
  const placedTables = new Set();
  const placedFigures = new Set();
  const sections = (doc.sections ?? []).map((section, index) => {
    const blocks = [paragraphBlock(section)];
    for (const ref of section.tableRefs ?? []) {
      const table = tablesById.get(ref);
      if (!table) abort({ message: `${spec.file}: section "${section.title ?? `#${index + 1}`}" references missing table id ${ref}`, dimension: 'artifactRefs', code: 'buildReport.sectionTableRefMissing', fix: `Either add a table with id=${ref} to ${spec.file}, or remove ${ref} from sections[${index}].tableRefs.`, path: `${spec.file}.sections[${index}].tableRefs` });
      if (placedTables.has(ref)) abort({ message: `${spec.file}: section "${section.title ?? `#${index + 1}`}" repeats tableRef ${ref} (already anchored to an earlier section)`, dimension: 'artifactRefs', code: 'buildReport.sectionTableRefDuplicate', fix: `Each table may be anchored in at most one section; remove ${ref} from sections[${index}].tableRefs.`, path: `${spec.file}.sections[${index}].tableRefs` });
      placedTables.add(ref);
      blocks.push(tableRefBlock(table));
    }
    for (const ref of section.figureRefs ?? []) {
      const figure = figuresById.get(ref);
      if (!figure) abort({ message: `${spec.file}: section "${section.title ?? `#${index + 1}`}" references missing figure id ${ref}`, dimension: 'artifactRefs', code: 'buildReport.sectionFigureRefMissing', fix: `Either add a figure with id=${ref} to ${spec.file}, or remove ${ref} from sections[${index}].figureRefs.`, path: `${spec.file}.sections[${index}].figureRefs` });
      if (placedFigures.has(ref)) abort({ message: `${spec.file}: section "${section.title ?? `#${index + 1}`}" repeats figureRef ${ref} (already anchored to an earlier section)`, dimension: 'artifactRefs', code: 'buildReport.sectionFigureRefDuplicate', fix: `Each figure may be anchored in at most one section; remove ${ref} from sections[${index}].figureRefs.`, path: `${spec.file}.sections[${index}].figureRefs` });
      placedFigures.add(ref);
      blocks.push(figureRefBlock(figure));
    }
    return {
      number: `${reportChapterNumber}.${index + 1}`,
      title: section.title,
      blocks,
    };
  });
  const trailingTables = tables.filter((t) => !t?.id || !placedTables.has(t.id));
  const trailingFigures = figures.filter((f) => !f?.id || !placedFigures.has(f.id));
  if (callouts.length || trailingTables.length || trailingFigures.length) {
    sections.push({
      number: `${reportChapterNumber}.${sections.length + 1}`,
      title: 'Exhibits',
      blocks: [
        ...callouts.map(calloutBlock),
        ...trailingTables.map(tableRefBlock),
        ...trailingFigures.map(figureRefBlock),
      ],
    });
  }
  return {
    number: reportChapterNumber,
    title: spec.title,
    sections,
  };
}

// ---------------------------------------------------------------------------
// global tables / figures / bibliography
// ---------------------------------------------------------------------------
function dropLocalEvidenceFields(item) {
  // Chapter tables/figures may carry localEvidence-only fields; the consolidated
  // report should expose only the schema-defined ones.
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'localEvidence'));
}

function collectGlobalArtifacts(field) {
  const seen = new Set();
  const out = [];
  for (const { doc } of chapterDocs) {
    for (const item of doc[field] ?? []) {
      if (!item?.id) continue;
      if (seen.has(item.id)) abort({ message: `duplicate ${field} id ${item.id} across chapters`, dimension: 'duplicateIds', code: 'buildReport.duplicateArtifactId', fix: `Renumber the duplicate ${field.slice(0, -1)} id ${item.id} so it uses its chapter's letter and is unique within that chapter.`, path: field });
      seen.add(item.id);
      out.push(dropLocalEvidenceFields(item));
    }
  }
  return out;
}

const tables = collectGlobalArtifacts('tables');
const figures = collectGlobalArtifacts('figures');
const sourceRefs = (evidence.sources ?? []).map((source) => source.id).filter(Boolean);

function buildRevision(value) {
  const revision = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    status: revision.status ?? 'current',
    refreshOfRunId: revision.refreshOfRunId ?? null,
    supersededByRunId: revision.supersededByRunId ?? null,
    refreshReason: revision.refreshReason ?? null,
  };
}

const revision = buildRevision(meta.revision);

const companyDefaults = {
  website: null,
  sector: null,
  stage: null,
  headquarters: null,
  shortDescription: null,
};
const company = {
  name: companyName,
  ...companyDefaults,
  ...(meta.company ?? {}),
};

// ---------------------------------------------------------------------------
// build full-report.yaml
// ---------------------------------------------------------------------------
const fullReport = {
  schemaVersion: SCHEMA_VERSION,
  artifact: 'full-report',
  slug,
  runDate,
  company,
  revision,
  subtitle: meta.subtitle ?? null,
  coverageNotes: meta.coverageNotes ?? null,
  coverFacts: meta.coverFacts ?? [],
  companyProfile: meta.companyProfile,
  chapters: chapterDocs.map(buildChapter),
  tables,
  figures,
  appendices: meta.appendices ?? [],
  bibliography: { sourceRefs },
  disclaimer: meta.disclaimer ?? DEFAULT_DISCLAIMER,
};

// ---------------------------------------------------------------------------
// build summary-card.yaml
// ---------------------------------------------------------------------------
const sourceStats = computeSourceStats(evidence, chapterDocs, runDate);

const summaryCard = {
  schemaVersion: SCHEMA_VERSION,
  artifact: 'summary-card',
  slug,
  runDate,
  company,
  revision,
  summary: {
    headline: meta.summary.headline,
    overallScore: meta.summary.overallScore,
    recommendation: meta.summary.recommendation,
    confidence: meta.summary.confidence,
    riskRating: meta.summary.riskRating,
    valuationStance: meta.summary.valuationStance,
    keyMetrics: meta.summary.keyMetrics ?? {},
    topStrengths: meta.summary.topStrengths,
    topRisks: meta.summary.topRisks,
    unresolvedGaps: meta.summary.unresolvedGaps,
  },
  sourceStats: {
    sourcesRetained: sourceRefs.length,
    claimsReviewed: (evidence.claims ?? []).length,
    domainCount: sourceStats.domainCount,
    adverseSourceCount: sourceStats.adverseSourceCount,
    // Unanswered-question breakdown:
    //  - openQuestionCount: every question whose status != answered
    //  - documentedGapQuestionCount: open AND referenced by some
    //    evidenceGap.relatedQuestionRefs (i.e. closed out as a known gap)
    //  - blockingQuestionCount: open AND not referenced by any evidenceGap
    //    (the chapter gate forbids this; should be 0 after a clean finalize-report)
    openQuestionCount: sourceStats.openQuestionCount,
    documentedGapQuestionCount: sourceStats.documentedGapQuestionCount,
    blockingQuestionCount: sourceStats.blockingQuestionCount,
    averageSourceAgeDays: sourceStats.averageSourceAgeDays,
  },
};

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
const fullReportPath = join(reportFolder, fullReportFile);
const summaryCardPath = join(reportFolder, summaryCardFile);

if (args.check) {
  for (const [file, expected] of [[fullReportFile, fullReport], [summaryCardFile, summaryCard]]) {
    if (!isDeepStrictEqual(readRequiredYaml(file, 'assembled artifact'), expected)) {
      abort({ message: `${file} does not match its authored inputs`, code: 'buildReport.assemblyMismatch',
        path: file, fix: 'Run unchanged finalization to rebuild published artifacts from the corrected authored inputs.' });
    }
  }
}
if (args.dryRun || args.check) {
  if (outputFormat === 'text') {
    if (args.check) console.log('[build-report] ✓ assembled artifacts match authored inputs');
    else {
      console.log(`[build-report] dry-run: would write ${fullReportPath}`);
      console.log(`[build-report] dry-run: would write ${summaryCardPath}`);
    }
    console.log(`[build-report] chapters=${chapterDocs.length} tables=${tables.length} figures=${figures.length} sources=${sourceRefs.length}`);
  } else {
    const envelope = validationEnvelope({
      ok: true,
      validator: 'build-report',
      reportFolder,
      summary: { stage: 'build-report', ...(args.check ? { check: true } : { dryRun: true }), fullReportPath, summaryCardPath, chapters: chapterDocs.length, tables: tables.length, figures: figures.length, sources: sourceRefs.length },
    });
    if (outputFormat === 'json') console.log(JSON.stringify(envelope, null, 2));
    else console.log(formatValidationCompact(envelope));
  }
  process.exit(EXIT.ok);
}

writeYaml(fullReportPath, fullReport);
writeYaml(summaryCardPath, summaryCard);
if (outputFormat === 'text') {
  console.log(`[build-report] ✓ wrote ${fullReportFile} (${tables.length} tables, ${figures.length} figures) and ${summaryCardFile}`);
} else {
  const envelope = validationEnvelope({
    ok: true,
    validator: 'build-report',
    reportFolder,
    summary: { stage: 'build-report', fullReportPath, summaryCardPath, chapters: chapterDocs.length, tables: tables.length, figures: figures.length, sources: sourceRefs.length },
  });
  if (outputFormat === 'json') console.log(JSON.stringify(envelope, null, 2));
  else console.log(formatValidationCompact(envelope));
}

function computeSourceStats(evidenceLedger, chapters, runDateStr) {
  const sources = evidenceLedger.sources ?? [];
  const matrix = evidenceLedger.coverageMatrix ?? {};
  const domainCount = matrix.totalDistinctDomains ?? 0;
  const adverseSourceCount = matrix.byStance?.adverse ?? sources.filter((s) => s?.stance === 'adverse').length;
  let openQuestionCount = 0;
  let documentedGapQuestionCount = 0;
  let blockingQuestionCount = 0;
  // evidenceGap.relatedQuestionRefs are Q<L>### ids local to the same chapter
  // (each chapter has its own letter L), so the open-vs-documented match is
  // done per-chapter rather than globally.
  for (const { doc } of chapters) {
    const local = doc.localEvidence ?? {};
    const gapRefs = new Set();
    for (const gap of local.evidenceGaps ?? []) {
      for (const ref of gap?.relatedQuestionRefs ?? []) gapRefs.add(ref);
    }
    for (const q of local.researchQuestions ?? []) {
      if (!q?.status || q.status === 'answered') continue;
      openQuestionCount += 1;
      if (q.id && gapRefs.has(q.id)) documentedGapQuestionCount += 1;
      else blockingQuestionCount += 1;
    }
  }
  const anchor = parseDate(runDateStr);
  const ages = [];
  for (const s of sources) {
    const d = parseDate(s?.date);
    if (anchor && d) {
      const days = Math.max(0, Math.round((anchor.valueOf() - d.valueOf()) / 86400000));
      ages.push(days);
    }
  }
  const averageSourceAgeDays = ages.length ? Math.round(ages.reduce((sum, n) => sum + n, 0) / ages.length) : null;
  return {
    domainCount,
    adverseSourceCount,
    openQuestionCount,
    documentedGapQuestionCount,
    blockingQuestionCount,
    averageSourceAgeDays,
  };
}
} // end main

main();
