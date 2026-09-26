#!/usr/bin/env node
// Schema and renderer-contract checks for a single finalized v2 report folder.
// Batch-mode sweeps across every report live in check-reports.mjs, which
// imports checkRun() from this file.
//
// Usage:
//   node .agents/skills/startup-research/scripts/check-report.mjs <report-folder>
//   node .agents/skills/startup-research/scripts/check-report.mjs <report-folder> --contract
//
// `<report-folder>` may be an absolute path, a path relative to the repo
// root, or a bare run id (e.g. `20260505063138-cyberhaven`) which is
// resolved against ./reports/. Exits 0 on success, non-zero on failures.
//
// Invoked automatically as the last step of finalize-report.mjs in full gate
// mode. `--contract` keeps schema / renderer / reference checks but skips
// current content-quality gates (source diversity and adverse-source
// distribution), which makes it suitable for re-checking historical reports
// after renderer or schema-contract changes.
//
// Chapter content readiness is checked by the other startup-research scripts.
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  collectClaimRefs,
  companySlugFromRunId,
  FINAL_ARTIFACTS,
  getAnalysisArtifacts,
  getCoreArtifacts,
  hasText,
  isFinalizedReportFolder,
  isRunId,
  isSelfPublishedReportUrl,
  loadWorkflowConfig,
  REVISION_STATUSES,
  runDateFromRunId,
  tryReadYaml,
} from './utils.mjs';
import {
  checkArtifactRefs,
  checkAuthoringInstructions,
  checkCalloutSchema,
  checkClaimSchema,
  checkDocumentHeadSchema,
  checkFigureDeep,
  checkSourceSchema,
  checkTableSchema,
  checkUniqueIds,
} from './artifact-checks.mjs';
import {
  BLOCK_TYPES,
  CALLOUT_TYPES,
  CARD_CONFIDENCES,
  CARD_RECOMMENDATIONS,
  CARD_RISK_RATINGS,
  CARD_VALUATION_STANCES,
  ID_PATTERN_CLAIM,
  ID_PATTERN_FIGURE,
  ID_PATTERN_SOURCE,
  ID_PATTERN_TABLE,
  formatEnumChoices,
} from './validation-catalog.mjs';
import { formatValidationCompact, formatValidationText, validationEnvelope, validationIssue } from './contracts/validation-result.mjs';
const REPORTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../reports');
// These bindings are rebound per-report inside checkRun() so each report is
// validated against its own .workflow-snapshot.yaml (when present), not the
// current head workflow-config.yaml. The initial values come from the head
// config so anything imported/used at module top still has sane defaults.
let WORKFLOW_CONFIG = loadWorkflowConfig();
let ANALYSIS_ARTIFACTS = getAnalysisArtifacts(WORKFLOW_CONFIG);
let CORE_ARTIFACTS = getCoreArtifacts(WORKFLOW_CONFIG);
let ANALYSIS_FILES = ANALYSIS_ARTIFACTS.map((item) => item.file);
let REQUIRED_ENGLISH_FILES = CORE_ARTIFACTS.map((item) => item.file);
let ARTIFACT_BY_FILE = new Map(CORE_ARTIFACTS.map((item) => [item.file, item]));
const EVIDENCE_FILE = FINAL_ARTIFACTS.evidence.file;
const FULL_REPORT_FILE = FINAL_ARTIFACTS.fullReport.file;
const SUMMARY_CARD_FILE = FINAL_ARTIFACTS.summaryCard.file;

// Per-call failure collector. checkRun() swaps in a fresh array for each
// report it processes and returns the captured failures, so callers (single
// folder mode and runAll) don't share state and don't need a manual reset.
//
// Each entry is `{ message, dimension?, code?, fix?, path? }`. fail() accepts
// either `(message)` (defaults to the generic reportContract / reportGate
// dimension) or `(message, opts)` where opts carries the precise
// dimension/code/fix. failureEnvelope() projects each entry onto a
// validationIssue, falling back to the generic dimension only when no
// specific tag was attached.
let currentFailures = [];
const fail = (message, opts = {}) => currentFailures.push({ message, ...opts });

// ---------------------------------------------------------------------------
// ledger schema
// ---------------------------------------------------------------------------

function checkLedgerSources(run, sources) {
  // Schema rules live in artifact-checks.mjs so check-chapter and check-report
  // can never drift. We just route the per-source errors into our flat
  // failure list with the same path prefix this checker has always used,
  // preserving the per-error dimension (sourceShape/...) so the JSON envelope
  // surfaces the real triage signal.
  for (const source of sources) {
    const path = `${run}/${EVIDENCE_FILE}: source ${source?.id ?? '?'}`;
    const { errors } = checkSourceSchema(source, { path });
    for (const err of errors) fail(err.message, err);
  }
}

function checkLedgerCoverage(run, coverage) {
  const path = `${run}/${EVIDENCE_FILE}: coverage`;
  if (coverage?.evidenceQuality === undefined) fail(`${path} missing evidenceQuality`, { path, dimension: 'reportContract', code: 'reportContract.coverageMissingEvidenceQuality', fix: 'Re-run build-evidence-ledger.mjs so evidence.yaml.coverage.evidenceQuality is populated.' });
}

function checkLedgerClaims(run, claims) {
  for (const claim of claims) {
    const path = `${run}/${EVIDENCE_FILE}: claim ${claim?.id ?? '?'}`;
    const { errors } = checkClaimSchema(claim, { path });
    for (const err of errors) fail(err.message, err);
  }
}

// ---------------------------------------------------------------------------
// chapter / appendix block schema
// ---------------------------------------------------------------------------

function collectBlocks(value, location, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBlocks(item, `${location}.${index}`, out));
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type !== undefined) out.push([location, value]);
  for (const [key, child] of Object.entries(value)) collectBlocks(child, `${location}.${key}`, out);
}

function checkReportBlocks(run, reportDoc) {
  const blocks = [];
  collectBlocks(reportDoc?.chapters ?? [], 'chapters', blocks);
  collectBlocks(reportDoc?.appendices ?? [], 'appendices', blocks);

  for (const [location, block] of blocks) {
    const path = `${run}/${FULL_REPORT_FILE}:${location}`;
    if (!BLOCK_TYPES.has(block.type)) {
      fail(`${path} block.type="${block.type}" must be one of ${formatEnumChoices(BLOCK_TYPES)}`, { path, dimension: 'documentHead', code: 'reportBlock.invalidType', fix: `Set block.type to one of ${formatEnumChoices(BLOCK_TYPES)}.` });
      continue;
    }
    if (block.type === 'paragraph' && !hasText(block.body)) fail(`${path} paragraph block requires body`, { path, dimension: 'documentHead', code: 'reportBlock.paragraphBody', fix: 'Add a non-empty body string to the paragraph block.' });
    if (block.type === 'list' && (!Array.isArray(block.items) || block.items.length === 0)) {
      fail(`${path} list block requires non-empty items`, { path, dimension: 'documentHead', code: 'reportBlock.listItems', fix: 'Add at least one item to the list block.' });
    }
    if (block.type === 'equation' && !hasText(block.equation)) fail(`${path} equation block requires equation`, { path, dimension: 'documentHead', code: 'reportBlock.equation', fix: 'Add a non-empty equation string to the equation block.' });
    if (block.type === 'callout') {
      if (!hasText(block.body)) fail(`${path} callout block requires body`, { path, dimension: 'calloutShape', code: 'reportBlock.calloutBody', fix: 'Add a non-empty body string to the callout block.' });
      if (block.calloutType != null && !CALLOUT_TYPES.has(block.calloutType)) {
        fail(`${path} callout block calloutType="${block.calloutType}" must be one of ${formatEnumChoices(CALLOUT_TYPES)}`, { path, dimension: 'calloutShape', code: 'reportBlock.calloutType', fix: `Set callout.calloutType to one of ${formatEnumChoices(CALLOUT_TYPES)} (or omit it).` });
      }
    }
    if (block.type === 'table' && !hasText(block.tableRef)) fail(`${path} table block requires tableRef`, { path, dimension: 'artifactRefs', code: 'reportBlock.tableRef', fix: 'Set block.tableRef to a top-level tables[].id.' });
    if (block.type === 'figure' && !hasText(block.figureRef)) fail(`${path} figure block requires figureRef`, { path, dimension: 'artifactRefs', code: 'reportBlock.figureRef', fix: 'Set block.figureRef to a top-level figures[].id.' });
  }
}

function checkCallouts(run, file, doc) {
  if (!ANALYSIS_FILES.includes(file)) return;
  for (const [index, callout] of (doc?.callouts ?? []).entries()) {
    const path = `${run}/${file}: callout ${index + 1}`;
    const { errors } = checkCalloutSchema(callout, { path });
    for (const err of errors) fail(err.message, err);
  }
}

// ---------------------------------------------------------------------------
// figure schema
// ---------------------------------------------------------------------------

function checkFigure(path, figure) {
  // All figure deep-schema rules now live in artifact-checks.mjs so the
  // chapter-time gate and post-finalize gate enforce the same contract.
  const { errors } = checkFigureDeep(figure, { path });
  for (const err of errors) fail(err.message, err);
}

// ---------------------------------------------------------------------------
// table schema
// ---------------------------------------------------------------------------

function checkTables(run, file, doc) {
  for (const table of doc?.tables ?? []) {
    const path = `${run}/${file}: table ${table?.id ?? '?'}`;
    const { errors } = checkTableSchema(table, { path });
    for (const err of errors) fail(err.message, err);
  }
}

// ---------------------------------------------------------------------------
// table/figure ref usage
// ---------------------------------------------------------------------------

function checkRefs(run, reportDoc) {
  // Run on the assembled full-report: walk chapters + appendices and verify
  // every figureRef/tableRef resolves to a top-level figure/table id, with
  // each id referenced exactly once (each artifact has exactly one home).
  const figureIds = new Set((reportDoc?.figures ?? []).map((figure) => figure.id));
  const tableIds = new Set((reportDoc?.tables ?? []).map((table) => table.id));
  const path = `${run}/${FULL_REPORT_FILE}`;
  const { errors: chapterErrors } = checkArtifactRefs(reportDoc?.chapters ?? [], { path, figureIds, tableIds, requireUniqueHome: true });
  for (const err of chapterErrors) fail(err.message, err);
  const { errors: appendixErrors } = checkArtifactRefs(reportDoc?.appendices ?? [], { path, figureIds, tableIds, requireUniqueHome: true });
  for (const err of appendixErrors) fail(err.message, err);
}

// Symmetric, post-finalize gate for the chapter-level unsectionedExhibits
// warning. The chapter-time check fires per-id during check-chapter, so the
// finalize sweep already catches anything reachable from that path. This
// gate reads the assembled full-report and the chapter YAMLs together so a
// hand-edit between the strict chapter sweep and the assemble step (which
// `build-report` would happily roll into the trailing Exhibits section)
// still surfaces. Honors per-chapter acknowledgedWarnings so an intentional
// "cross-cutting Exhibits" chapter stays valid.
function checkUnsectionedExhibitsInReport(run, reportDoc, parsed) {
  const chapters = reportDoc?.chapters ?? [];
  for (const [index, chapter] of chapters.entries()) {
    const spec = ANALYSIS_ARTIFACTS[index];
    if (!spec) continue;
    const chapterDoc = parsed.get(spec.file);
    const acks = Array.isArray(chapterDoc?.acknowledgedWarnings) ? chapterDoc.acknowledgedWarnings : [];
    const acked = acks.some((ack) => ack?.dimension === 'unsectionedExhibits' && typeof ack?.reason === 'string' && ack.reason.trim().length >= 30);
    if (acked) continue;
    const orphanIds = [];
    for (const section of chapter?.sections ?? []) {
      if (section?.title !== 'Exhibits') continue;
      for (const block of section?.blocks ?? []) {
        if (block?.type === 'table' && hasText(block?.tableRef)) orphanIds.push(`table ${block.tableRef}`);
        if (block?.type === 'figure' && hasText(block?.figureRef)) orphanIds.push(`figure ${block.figureRef}`);
      }
    }
    if (orphanIds.length > 0) {
      fail(`${run}/${FULL_REPORT_FILE}: chapter ${chapter.number} ("${chapter.title}", ${spec.file}) has ${orphanIds.length} orphan exhibit(s) in the trailing Exhibits section: ${orphanIds.join(', ')}. Anchor each id in a section.tableRefs[]/figureRefs[] and re-run finalize-report.mjs, or add an acknowledgedWarnings entry for "unsectionedExhibits" if these exhibits are intentionally cross-cutting.`, {
        path: `${run}/${spec.file}`,
        dimension: 'unsectionedExhibits',
        code: 'reportRefs.unsectionedExhibits',
        fix: `Edit ${spec.file}: add each orphan id to the tableRefs[]/figureRefs[] of the section whose prose introduces it, then re-run finalize-report.mjs. Use acknowledgedWarnings only when the chapter genuinely needs cross-cutting Exhibits (rare).`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// per-run pipeline
// ---------------------------------------------------------------------------

function parseRunArtifacts(run, dir) {
  const parsed = new Map();
  const canonicalSlug = companySlugFromRunId(run);
  const canonicalRunDate = runDateFromRunId(run);
  for (const file of REQUIRED_ENGLISH_FILES.filter((name) => name.endsWith('.yaml'))) {
    const result = tryReadYaml(join(dir, file));
    if (!result.ok) {
      fail(`${run}/${file}: YAML parse failed: ${result.error}`, { path: `${run}/${file}`, dimension: 'yamlParse', code: 'yamlParse', fix: `Fix YAML syntax in ${file}.` });
      continue;
    }
    parsed.set(file, result.value);
    const expected = ARTIFACT_BY_FILE.get(file);
    const { errors } = checkDocumentHeadSchema(result.value, { path: `${run}/${file}`, expected });
    for (const err of errors) fail(err.message, err);
    if (result.value?.slug && result.value.slug !== canonicalSlug) {
      fail(`${run}/${file}: slug "${result.value.slug}" does not match folder slug "${canonicalSlug}"`, { path: `${run}/${file}`, dimension: 'slugConsistency', code: 'slugFolderMismatch', fix: `Set slug: to "${canonicalSlug}".` });
    }
    if (typeof result.value?.runDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.value.runDate) && result.value.runDate !== canonicalRunDate) {
      fail(`${run}/${file}: runDate "${result.value.runDate}" does not match the runId-derived runDate "${canonicalRunDate}"`, { path: `${run}/${file}`, dimension: 'runDateConsistency', code: 'runDateFolderMismatch', fix: `Set runDate: to "${canonicalRunDate}" (UTC YYYY-MM-DD from the report folder runId timestamp prefix; use runtimeContext.run.runDate).` });
    }
  }
  return parsed;
}

function checkLedgerCrossReferences(run, ledger, parsed, { contentGates }) {
  if (!ledger) return;
  const claimIds = new Set((ledger.claims ?? []).map((claim) => claim.id));
  const sourceIds = new Set((ledger.sources ?? []).map((source) => source.id));
  checkLedgerCoverage(run, ledger.coverage ?? {});
  checkLedgerSources(run, ledger.sources ?? []);
  checkLedgerClaims(run, ledger.claims ?? []);
  for (const err of checkUniqueIds(ledger.sources, { label: 'source', pattern: ID_PATTERN_SOURCE, path: run }).errors) fail(err.message, { ...err, dimension: err.dimension ?? 'duplicateIds' });
  for (const err of checkUniqueIds(ledger.claims, { label: 'claim', pattern: ID_PATTERN_CLAIM, path: run }).errors) fail(err.message, { ...err, dimension: err.dimension ?? 'duplicateIds' });
  for (const claim of ledger.claims ?? []) {
    for (const ref of claim.sourceRefs ?? []) {
      if (!sourceIds.has(ref)) fail(`${run}: claim ${claim.id} references missing source ${ref}`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'claimRefs', code: 'ledgerClaimSourceRef', fix: `Resolve sourceRef ${ref} on claim ${claim.id} (rebuild the ledger after the chapter sources are corrected).` });
    }
  }
  for (const [file, doc] of parsed) {
    if (file === EVIDENCE_FILE) continue;
    for (const ref of collectClaimRefs(doc)) {
      if (!claimIds.has(ref)) fail(`${run}/${file}: missing claimRef ${ref}`, { path: `${run}/${file}`, dimension: 'claimRefs', code: 'ledgerClaimRefMissing', fix: `Resolve claimRef ${ref}: it must exist in evidence.yaml after build-evidence-ledger.` });
    }
  }
  if (contentGates) checkReportLevelDiversity(run, ledger);
}

function checkReportLevelDiversity(run, ledger) {
  for (const source of ledger.sources ?? []) {
    if (!isSelfPublishedReportUrl(source?.url)) continue;
    const path = `${run}/${EVIDENCE_FILE}: source ${source.id}`;
    fail(`${path} cites this site's own published report as evidence: ${source.url}`, {
      path,
      dimension: 'sourceIndependence',
      code: 'circularReportSource',
      fix: 'Remove the self-published source from its chapter and re-check every dependent claim against original external evidence; rebuild the ledger. Do not relabel circular evidence as independent.',
    });
  }
  const gate = WORKFLOW_CONFIG.reportGate ?? {
    minDistinctDomains: 30,
    requireAdverseSource: true,
    maxPaywallPercent: 0.3,
  };

  const matrix = ledger.coverageMatrix;
  if (!matrix) {
    fail(`${run}/${EVIDENCE_FILE}: coverageMatrix missing — re-run build-evidence-ledger.mjs`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'reportContract', code: 'coverageMatrixMissing', fix: 'Re-run build-evidence-ledger.mjs so evidence.yaml carries coverageMatrix.' });
    return;
  }

  // Report-wide floors: at least minDistinctDomains distinct domains;
  // at least one adverse-stance source (if requireAdverseSource is true);
  // not more than maxPaywallPercent of paywall/broken sources.
  const minDistinctDomains = gate.minDistinctDomains ?? 30;
  if ((matrix.totalDistinctDomains ?? 0) < minDistinctDomains) {
    fail(`${run}/${EVIDENCE_FILE}: report-wide totalDistinctDomains=${matrix.totalDistinctDomains ?? 0}, expected at least ${minDistinctDomains}`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceDomains', code: 'reportDomainFloor', fix: `Add sources from new registrable domains until totalDistinctDomains ≥ ${minDistinctDomains}.` });
  }

  if (gate.requireAdverseSource ?? true) {
    const adverseTotal = matrix.byStance?.adverse ?? 0;
    if (adverseTotal === 0) {
      fail(`${run}/${EVIDENCE_FILE}: no adverse-stance sources across the entire report (risks chapter must contribute at least one)`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceStanceSpread', code: 'reportNoAdverseSource', fix: 'Add at least one adverse-stance source to the risks chapter (regulator complaint, short report, skeptical analyst note, FOS/CFPB filing, FT Alphaville-style critique).' });
    }
  }

  const totalSources = (ledger.sources ?? []).length;
  if (totalSources > 0) {
    if (Number.isFinite(gate.minIndependentSourceShare)) {
      const independentTotal = (ledger.sources ?? []).filter((source) => source?.independence === 'independent').length;
      const independentShare = independentTotal / totalSources;
      if (independentShare < gate.minIndependentSourceShare) {
        fail(`${run}/${EVIDENCE_FILE}: ${independentTotal}/${totalSources} sources are independent (${Math.round(independentShare * 100)}%, min ${Math.round(gate.minIndependentSourceShare * 100)}%); replace company-controlled sources with independent evidence`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceIndependence', code: 'reportIndependentSourceFloor', fix: `Retain independent reporting, customer evidence, benchmarks, or regulatory sources until the independent share is ≥ ${Math.round(gate.minIndependentSourceShare * 100)}%.` });
      }
    }
    if (Number.isFinite(gate.maxCompanyControlledSourceShare)) {
      const companyTotal = (ledger.sources ?? []).filter((source) => source?.independence === 'company').length;
      const companyShare = companyTotal / totalSources;
      if (companyShare > gate.maxCompanyControlledSourceShare) {
        fail(`${run}/${EVIDENCE_FILE}: ${companyTotal}/${totalSources} sources are company-controlled (${Math.round(companyShare * 100)}%, max ${Math.round(gate.maxCompanyControlledSourceShare * 100)}%); independent corroboration is too thin`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceIndependence', code: 'reportCompanyControlledCeiling', fix: `Replace company-authored sources with independent evidence until the company-controlled share is ≤ ${Math.round(gate.maxCompanyControlledSourceShare * 100)}%.` });
      }
    }
    const maxPaywallPercent = gate.maxPaywallPercent ?? 0.3;
    const blockedTotal = (matrix.byAccessStatus?.broken ?? 0) + (matrix.byAccessStatus?.paywall ?? 0) + (matrix.byAccessStatus?.['rate-limited'] ?? 0);
    if (blockedTotal / totalSources > maxPaywallPercent) {
      const pct = (blockedTotal / totalSources * 100).toFixed(0);
      fail(`${run}/${EVIDENCE_FILE}: ${blockedTotal}/${totalSources} sources are paywall/broken/rate-limited (${pct}%, max ${Math.round(maxPaywallPercent * 100)}%); replace blocked sources with accessible alternatives`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'paywallRisk', code: 'reportPaywallCeiling', fix: `Swap restricted (paywall|js-only|broken|rate-limited) sources for ok ones until the share is ≤ ${Math.round(maxPaywallPercent * 100)}%.` });
    }
  }
}

// Adverse-evidence distribution gate. Per-chapter gates already require
// adverse *questions*; this checks that adverse *sources* are spread across
// the report instead of concentrating in one chapter (typically risks).
// Driven entirely by workflow-config.adverseDistribution; absent config = no
// check. Reads each chapter's localEvidence.sources directly so the check
// works whether or not coverageMatrix.byChapter exposes a stance breakdown.
function checkAdverseDistribution(run, parsed) {
  const config = WORKFLOW_CONFIG.adverseDistribution;
  if (!config) return;
  const chapterByFile = new Map(WORKFLOW_CONFIG.chapters.map((ch) => [ch.file, ch]));
  const adverseByKey = new Map();
  for (const [file, doc] of parsed) {
    const chapter = chapterByFile.get(file);
    if (!chapter) continue;
    const sources = doc?.localEvidence?.sources ?? [];
    const adverse = sources.filter((s) => s?.stance === 'adverse').length;
    adverseByKey.set(chapter.key, adverse);
  }
  for (const requiredKey of config.requireAtLeastOneAdverseSource ?? []) {
    if ((adverseByKey.get(requiredKey) ?? 0) < 1) {
      fail(`${run}/${EVIDENCE_FILE}: chapter "${requiredKey}" has 0 adverse-stance sources; adverseDistribution.requireAtLeastOneAdverseSource requires at least one`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceStanceSpread', code: 'adverseDistributionPerChapter', fix: `Add at least one adverse-stance source to the ${requiredKey} chapter.` });
    }
  }
  const threshold = config.warnIfChaptersWithAdverseSourceAtMost;
  if (Number.isInteger(threshold)) {
    const chaptersWithAdverse = [...adverseByKey.values()].filter((n) => n > 0).length;
    if (chaptersWithAdverse <= threshold) {
      // Concentration is a fail, not a warn: reports that pass with adverse
      // evidence in only 1-2 chapters look "green" but are structurally
      // unbalanced. The threshold is operator-tunable in workflow-config.yaml.
      fail(`${run}/${EVIDENCE_FILE}: adverse-stance sources appear in only ${chaptersWithAdverse} chapter(s) (<= ${threshold}); spread adverse evidence across more chapters`, { path: `${run}/${EVIDENCE_FILE}`, dimension: 'sourceStanceSpread', code: 'adverseDistributionConcentration', fix: `Spread adverse-stance sources across more chapters (currently ${chaptersWithAdverse}, must exceed ${threshold}).` });
    }
  }
}

function checkCardConsistency(run, card, reportDoc, ledger) {
  const cardPath = `${run}/${SUMMARY_CARD_FILE}`;
  const summary = card?.summary;
  if (!summary || typeof summary !== 'object') {
    fail(`${cardPath}: summary block is required`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.summaryMissing', fix: 'Add the summary: block to summary-card.yaml (it mirrors report-meta.summary).' });
  } else {
    if (typeof summary.overallScore !== 'number' || summary.overallScore < 0 || summary.overallScore > 10) {
      fail(`${cardPath}: summary.overallScore must be a number between 0 and 10 (got ${JSON.stringify(summary.overallScore)})`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.overallScore', fix: 'Set summary.overallScore to a number between 0 and 10 in report-meta.yaml.' });
    }
    if (!hasText(summary.headline)) fail(`${cardPath}: summary.headline is required`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.headline', fix: 'Add a non-empty summary.headline to report-meta.yaml.' });
    if (!CARD_RECOMMENDATIONS.has(summary.recommendation)) fail(`${cardPath}: summary.recommendation="${summary.recommendation}" must be one of ${formatEnumChoices(CARD_RECOMMENDATIONS)}`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.recommendation', fix: `Set summary.recommendation to one of ${formatEnumChoices(CARD_RECOMMENDATIONS)} in report-meta.yaml.` });
    if (!CARD_CONFIDENCES.has(summary.confidence)) fail(`${cardPath}: summary.confidence="${summary.confidence}" must be one of ${formatEnumChoices(CARD_CONFIDENCES)}`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.confidence', fix: `Set summary.confidence to one of ${formatEnumChoices(CARD_CONFIDENCES)} in report-meta.yaml.` });
    if (!CARD_RISK_RATINGS.has(summary.riskRating)) fail(`${cardPath}: summary.riskRating="${summary.riskRating}" must be one of ${formatEnumChoices(CARD_RISK_RATINGS)}`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.riskRating', fix: `Set summary.riskRating to one of ${formatEnumChoices(CARD_RISK_RATINGS)} in report-meta.yaml.` });
    if (!CARD_VALUATION_STANCES.has(summary.valuationStance)) fail(`${cardPath}: summary.valuationStance="${summary.valuationStance}" must be one of ${formatEnumChoices(CARD_VALUATION_STANCES)}`, { path: cardPath, dimension: 'reportMetaShape', code: 'card.valuationStance', fix: `Set summary.valuationStance to one of ${formatEnumChoices(CARD_VALUATION_STANCES)} in report-meta.yaml.` });
    for (const field of ['topStrengths', 'topRisks', 'unresolvedGaps']) {
      if (!Array.isArray(summary[field])) fail(`${cardPath}: summary.${field} must be an array`, { path: cardPath, dimension: 'reportMetaShape', code: `card.${field}`, fix: `Set summary.${field} to an array in report-meta.yaml.` });
    }
  }
  if (card?.sourceStats?.claimsReviewed !== undefined && ledger?.claims && card.sourceStats.claimsReviewed > ledger.claims.length) {
    fail(`${cardPath}: claimsReviewed exceeds ledger claims`, { path: cardPath, dimension: 'reportContract', code: 'card.claimsReviewedOverflow', fix: 'Re-run build-report.mjs after build-evidence-ledger.mjs so sourceStats is recomputed from the current ledger.' });
  }
  for (const field of ['sourcesRetained', 'claimsReviewed', 'domainCount', 'adverseSourceCount', 'openQuestionCount', 'documentedGapQuestionCount', 'blockingQuestionCount']) {
    if (typeof card?.sourceStats?.[field] !== 'number') fail(`${cardPath}: sourceStats.${field} is required and must be a number`, { path: cardPath, dimension: 'reportContract', code: 'card.sourceStatsMissing', fix: 'Re-run build-report.mjs to repopulate summary-card.sourceStats.' });
  }
  // Invariant: every open question must be closed out by an evidenceGap
  // (the chapter gate enforces this). A nonzero blockingQuestionCount means
  // a chapter slipped through with an undocumented unanswered question.
  if (typeof card?.sourceStats?.blockingQuestionCount === 'number' && card.sourceStats.blockingQuestionCount > 0) {
    fail(`${cardPath}: sourceStats.blockingQuestionCount=${card.sourceStats.blockingQuestionCount} > 0; every open question must be referenced by some evidenceGap.relatedQuestionRefs`, { path: cardPath, dimension: 'researchQuestionClosure', code: 'card.blockingQuestion', fix: 'Add an evidenceGap entry whose relatedQuestionRefs[] cites every open question, then re-run finalize-report.' });
  }
  if (card?.sourceStats && card.sourceStats.averageSourceAgeDays != null && typeof card.sourceStats.averageSourceAgeDays !== 'number') {
    fail(`${cardPath}: sourceStats.averageSourceAgeDays must be a number or null`, { path: cardPath, dimension: 'reportContract', code: 'card.averageSourceAge', fix: 'Re-run build-report.mjs to recompute sourceStats.averageSourceAgeDays.' });
  }
  // The full-report figure/table arrays carry the authoritative counts; the
  // card no longer mirrors them (cf. schema simplification).
  void reportDoc;
}

function checkReportConsistency(run, reportDoc) {
  const reportPath = `${run}/${FULL_REPORT_FILE}`;
  if (!reportDoc?.companyProfile || typeof reportDoc.companyProfile !== 'object') {
    fail(`${reportPath}: missing companyProfile object`, { path: reportPath, dimension: 'displayCompleteness', code: 'report.companyProfileMissing', fix: 'Add a companyProfile block to report-meta.yaml (summary, foundedDate, founders, ...).' });
  } else if (typeof reportDoc.companyProfile.summary !== 'string' || !reportDoc.companyProfile.summary.trim()) {
    fail(`${reportPath}: companyProfile.summary is required`, { path: reportPath, dimension: 'displayCompleteness', code: 'report.companyProfileSummary', fix: 'Add a non-empty companyProfile.summary string to report-meta.yaml.' });
  }
}

function checkCrossArtifactIdentity(run, parsed) {
  const docs = [...parsed.values()];
  const names = new Set(docs.map((doc) => doc?.company?.name).filter(Boolean));
  if (names.size > 1) fail(`${run}: company.name is inconsistent across artifacts (found: ${[...names].map((n) => `"${n}"`).join(', ')})`, { path: run, dimension: 'documentHead', code: 'crossArtifact.companyName', fix: 'Make company.name identical across every chapter, evidence.yaml, full-report.yaml, and summary-card.yaml.' });
  const slugs = new Set(docs.map((doc) => doc?.slug).filter(Boolean));
  if (slugs.size > 1) fail(`${run}: slug is inconsistent across artifacts (found: ${[...slugs].map((s) => `"${s}"`).join(', ')})`, { path: run, dimension: 'slugConsistency', code: 'crossArtifact.slug', fix: 'Make slug identical across every chapter, evidence.yaml, full-report.yaml, and summary-card.yaml.' });
}

const REVISION_RELATION_FIELDS = ['refreshOfRunId', 'supersededByRunId'];

function revisionComparable(doc) {
  const revision = doc?.revision && typeof doc.revision === 'object' && !Array.isArray(doc.revision) ? doc.revision : {};
  return {
    status: revision.status ?? 'current',
    refreshOfRunId: revision.refreshOfRunId ?? null,
    supersededByRunId: revision.supersededByRunId ?? null,
    refreshReason: revision.refreshReason ?? null,
  };
}

function checkRevisionShape(run, file, doc) {
  if (doc?.revision === undefined) return;
  const path = `${run}/${file}: revision`;
  const revision = doc.revision;
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    fail(`${path} must be an object when present`, { path, dimension: 'revisionGraph', code: 'revision.shape', fix: 'Set revision: to an object (or omit it). link-refresh.mjs writes the canonical shape.' });
    return;
  }
  const status = revision.status ?? 'current';
  if (!REVISION_STATUSES.has(status)) fail(`${path}.status="${status}" must be one of ${formatEnumChoices(REVISION_STATUSES)}`, { path, dimension: 'revisionGraph', code: 'revision.status', fix: `Set revision.status to one of ${formatEnumChoices(REVISION_STATUSES)} (link-refresh.mjs writes this automatically).` });
  if (revision.refreshReason != null && typeof revision.refreshReason !== 'string') {
    fail(`${path}.refreshReason must be a string or null`, { path, dimension: 'revisionGraph', code: 'revision.refreshReason', fix: 'Set revision.refreshReason to a string (or null when not a refresh).' });
  }
  for (const field of REVISION_RELATION_FIELDS) {
    const value = revision[field];
    if (value == null) continue;
    if (typeof value !== 'string' || !value.trim()) {
      fail(`${path}.${field} must be a non-empty runId string or null`, { path, dimension: 'revisionGraph', code: `revision.${field}`, fix: `Set revision.${field} to a finalized report's runId (or null).` });
      continue;
    }
    if (!isRunId(value)) fail(`${path}.${field}=${value} is not a valid report run id`, { path, dimension: 'revisionGraph', code: `revision.${field}.format`, fix: `Set revision.${field} to a YYYYMMDDhhmmss-<slug> runId.` });
    if (value === run) fail(`${path}.${field} cannot reference the same report run`, { path, dimension: 'revisionGraph', code: `revision.${field}.selfRef`, fix: `Point revision.${field} at a different report's runId.` });
    const targetDir = join(REPORTS_DIR, value);
    if (!isFinalizedReportFolder(targetDir)) fail(`${path}.${field} references a missing or unfinalized report: ${value}`, { path, dimension: 'revisionGraph', code: `revision.${field}.targetMissing`, fix: `Verify ${value} exists under reports/ and is finalized; otherwise pick a valid finalized runId.` });
  }
  if (status === 'current' && hasText(revision.supersededByRunId)) {
    fail(`${path}: current reports must not set supersededByRunId`, { path, dimension: 'revisionGraph', code: 'revision.currentHasSupersededBy', fix: 'Clear revision.supersededByRunId on current reports (link-refresh.mjs sets it only on superseded reports).' });
  }
  if (status === 'superseded' && !hasText(revision.supersededByRunId)) {
    fail(`${path}: superseded reports must set supersededByRunId`, { path, dimension: 'revisionGraph', code: 'revision.supersededMissingTarget', fix: 'Set revision.supersededByRunId on superseded reports (link-refresh.mjs writes it).' });
  }
  if (hasText(revision.refreshOfRunId) && revision.refreshOfRunId === revision.supersededByRunId) {
    fail(`${path}: refreshOfRunId and supersededByRunId cannot point to the same run`, { path, dimension: 'revisionGraph', code: 'revision.relationCollision', fix: 'Distinct refreshOfRunId / supersededByRunId; a report cannot supersede the same run it refreshes.' });
  }
  if (status === 'superseded' && hasText(revision.supersededByRunId)) {
    const target = tryReadYaml(join(REPORTS_DIR, revision.supersededByRunId, SUMMARY_CARD_FILE));
    const targetRefreshOf = target.ok ? target.value?.revision?.refreshOfRunId : null;
    if (target.ok && targetRefreshOf !== run) {
      fail(`${path}: supersededByRunId=${revision.supersededByRunId} must point to a report whose revision.refreshOfRunId is ${run}`, { path, dimension: 'revisionGraph', code: 'revision.backPointer', fix: 'Re-run finalize-report.mjs --refresh on the new report so link-refresh.mjs writes consistent back-pointers.' });
    }
  }
}

function checkRevisionConsistency(run, parsed) {
  const reportDoc = parsed.get(FULL_REPORT_FILE);
  const card = parsed.get(SUMMARY_CARD_FILE);
  checkRevisionShape(run, FULL_REPORT_FILE, reportDoc);
  checkRevisionShape(run, SUMMARY_CARD_FILE, card);
  const reportRevision = revisionComparable(reportDoc);
  const cardRevision = revisionComparable(card);
  if (JSON.stringify(reportRevision) !== JSON.stringify(cardRevision)) {
    fail(`${run}: revision is inconsistent between ${FULL_REPORT_FILE} and ${SUMMARY_CARD_FILE}`, { path: run, dimension: 'revisionGraph', code: 'revision.crossArtifactDrift', fix: `Re-run build-report.mjs (or finalize-report.mjs) so revision is rewritten consistently into both ${FULL_REPORT_FILE} and ${SUMMARY_CARD_FILE}.` });
  }
}

function checkRun(run, { contentGates = true } = {}) {
  const dir = join(REPORTS_DIR, run);
  currentFailures = [];
  if (!existsSync(join(dir, SUMMARY_CARD_FILE))) return { checked: false, failures: [] };

  // Per-report snapshot: load the workflow-config.yaml that was frozen with
  // this report at finalize time so changing the head config never
  // retroactively re-judges old reports. Falls back to the head config when
  // no snapshot exists (e.g. a half-built folder before finalize-report).
  WORKFLOW_CONFIG = loadWorkflowConfig({ reportFolder: dir });
  ANALYSIS_ARTIFACTS = getAnalysisArtifacts(WORKFLOW_CONFIG);
  CORE_ARTIFACTS = getCoreArtifacts(WORKFLOW_CONFIG);
  ANALYSIS_FILES = ANALYSIS_ARTIFACTS.map((item) => item.file);
  REQUIRED_ENGLISH_FILES = CORE_ARTIFACTS.map((item) => item.file);
  ARTIFACT_BY_FILE = new Map(CORE_ARTIFACTS.map((item) => [item.file, item]));

  const beforeMissing = currentFailures.length;
  for (const file of REQUIRED_ENGLISH_FILES) {
    if (!existsSync(join(dir, file))) fail(`${run}/${file}: missing required v2 artifact`, { path: `${run}/${file}`, dimension: 'missingArtifact', code: 'report.missingArtifact', fix: 'Re-run finalize-report.mjs after every configured chapter passes check-chapter --strict.' });
  }
  if (currentFailures.length > beforeMissing) return { checked: true, failures: [...currentFailures] };

  const parsed = parseRunArtifacts(run, dir);
  const ledger = parsed.get(EVIDENCE_FILE);
  const reportDoc = parsed.get(FULL_REPORT_FILE);
  const card = parsed.get(SUMMARY_CARD_FILE);

  checkCrossArtifactIdentity(run, parsed);
  checkRevisionConsistency(run, parsed);
  checkLedgerCrossReferences(run, ledger, parsed, { contentGates });
  if (contentGates) checkAdverseDistribution(run, parsed);
  if (contentGates) {
    for (const [file, doc] of parsed) {
      for (const err of checkAuthoringInstructions(doc, { path: `${run}/${file}` }).errors) fail(err.message, err);
    }
  }

  if (reportDoc) {
    checkReportBlocks(run, reportDoc);
    for (const err of checkUniqueIds(reportDoc.figures, { label: 'figure', pattern: ID_PATTERN_FIGURE, path: run }).errors) fail(err.message, { ...err, dimension: err.dimension ?? 'duplicateIds' });
    for (const err of checkUniqueIds(reportDoc.tables, { label: 'table', pattern: ID_PATTERN_TABLE, path: run }).errors) fail(err.message, { ...err, dimension: err.dimension ?? 'duplicateIds' });
    checkRefs(run, reportDoc);
    checkUnsectionedExhibitsInReport(run, reportDoc, parsed);
    checkReportConsistency(run, reportDoc);
  }

  for (const [file, doc] of parsed) checkTables(run, file, doc);
  for (const [file, doc] of parsed) checkCallouts(run, file, doc);
  for (const [file, doc] of parsed) {
    for (const figure of doc?.figures ?? []) checkFigure(`${run}/${file}`, figure);
  }

  checkCardConsistency(run, card, reportDoc, ledger);
  return { checked: true, failures: [...currentFailures] };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function resolveReportDir(arg) {
  // Bare run id like `20260505063138-cyberhaven` resolves under ./reports/.
  if (!arg.includes('/') && !isAbsolute(arg)) return join(REPORTS_DIR, arg);
  return resolve(arg);
}

function usage() {
  console.error('Usage: node .agents/skills/startup-research/scripts/check-report.mjs <report-folder> [--contract] [--format text|json|compact]');
  process.exit(EXIT.failure);
}

function parseArgs(argv) {
  const args = { folder: null, contract: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--contract') args.contract = true;
    else if (arg === '--format') args.format = argv[++i] ?? 'text';
    else if (arg === '-h' || arg === '--help') usage();
    else if (arg.startsWith('-')) usage();
    else if (!args.folder) args.folder = arg;
    else usage();
  }
  if (!args.folder) usage();
  if (!['text', 'json', 'compact'].includes(args.format)) usage();
  return args;
}

function failureEnvelope(run, args, runFailures, checked) {
  const fallbackDimension = args.contract ? 'reportContract' : 'reportGate';
  return validationEnvelope({
    ok: false,
    validator: 'check-report',
    artifact: run,
    issues: runFailures.map((entry) => validationIssue({
      path: entry.path ?? String(entry.message).split(':')[0] ?? run,
      message: entry.message,
      dimension: entry.dimension ?? fallbackDimension,
      code: entry.code ?? 'checkReport.failure',
      fix: entry.fix ?? 'Fix the reported artifact, then rerun check-report.mjs.',
    })),
    summary: { mode: args.contract ? 'contract' : 'full', checked },
  });
}

function emitSingle(args, run, runFailures, checked) {
  if (runFailures.length) {
    const result = failureEnvelope(run, args, runFailures, checked);
    if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
    else if (args.format === 'compact') console.log(formatValidationCompact(result));
    else console.error(formatValidationText(result, { failureMessage: '[check:report] failures' }));
    return EXIT.failure;
  }
  if (!checked) {
    const result = validationEnvelope({
      ok: false,
      validator: 'check-report',
      artifact: run,
      issues: [validationIssue({
        path: `${run}/${SUMMARY_CARD_FILE}`,
        message: `${run}: not a finalized v2 report (no ${SUMMARY_CARD_FILE})`,
        dimension: 'missingArtifact',
        code: 'checkReport.notFinalized',
        fix: 'Run finalize-report.mjs after every configured chapter passes check-chapter.',
      })],
    });
    if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
    else if (args.format === 'compact') console.log(formatValidationCompact(result));
    else console.error(formatValidationText(result, { failureMessage: '[check:report] failures' }));
    return EXIT.failure;
  }
  const mode = args.contract ? 'contract verified' : 'verified';
  const result = validationEnvelope({ ok: true, validator: 'check-report', artifact: run, summary: { mode } });
  if (args.format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (args.format === 'compact') console.log(formatValidationCompact(result));
  else console.log(`[check:report] ✓ ${run} ${mode}.`);
  return EXIT.ok;
}

// Exposed for check-reports.mjs (the batch-mode wrapper).
export { checkRun };

// Only run the CLI when this file is executed directly (not when imported
// by check-reports.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const folderArg = args.folder;
    const dir = resolveReportDir(folderArg);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`[check:report] not a directory: ${dir}`);
      process.exit(EXIT.notFound);
    }
    const run = basename(dir);
    // checkRun() resolves the folder via REPORTS_DIR; reject anything outside
    // it instead of silently misbehaving.
    if (resolve(REPORTS_DIR, run) !== dir) {
      console.error(`[check:report] folder must live under ${REPORTS_DIR}; got ${dir}`);
      process.exit(EXIT.failure);
    }

    const { checked, failures: runFailures } = checkRun(run, { contentGates: !args.contract });
    process.exit(emitSingle(args, run, runFailures, checked));
  } catch (err) {
    console.error(`[check:report] fatal error: ${err.message}`);
    process.exit(EXIT.failure);
  }
}
