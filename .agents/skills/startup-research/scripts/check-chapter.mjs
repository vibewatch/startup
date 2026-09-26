#!/usr/bin/env node
// Chapter-scoped readiness check for one configured analysis artifact.
// Always runs the pre-ledger checks (localEvidence quotas, claimRef
// resolution); the post-ledger phase is handled by check-report.mjs.
//
// `--format json` emits structured failures keyed by dimension so the agent's
// retry loop can target only the failing facets. Each failure carries:
//   - dimension   (stable enum, switch on this)
//   - message     (human-readable problem)
//   - fix         (one-line action — same data as the SKILL.md retry table)
//   - actual / required / id / tableId / claimId / etc. (when applicable)
// The top-level report also surfaces objectFailures[] (failures grouped by
// the object they touch — e.g. all complaints about T102 in one entry) and
// globalHints[] (when the same dimension fails on many objects, hinting at a
// chapter-wide root cause).
//
// `--format compact` emits one line per finding (no truncation, no preamble);
// the first line is `STATUS: OK` or `STATUS: FAIL` followed by stable labels
// such as `failedDimensions`, `retryOrder`, `suppressed`, `GLOBAL`, `FAIL`,
// and `WARN`. Use it for human-readable shell loops where the structured
// fields are not needed. Note: SKILL.md's chapter retry loop recommends
// `--format json` because `issues[].fix`, `objectFailures[]`, `globalHints[]`,
// `retryOrder[]`, and `suppressedDimensions[]` drive root-cause-first repair.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { canonicalSourceUrl, collectClaimRefs, companySlugFromRunId, EXIT, getAnalysisArtifacts, loadWorkflowConfig, registrableDomain, runDateFromRunId, tryReadYaml } from './utils.mjs';
import { validateFigureShape } from '../../../../website/src/lib/figures.mjs';
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
  CASCADE_SUPPRESSORS,
  DUPLICATE_TITLE_THRESHOLD,
  ENUMERATION_COVERAGE,
  FIX_HINTS,
  jaccardTokenSimilarity,
  KNOWN_DIMENSIONS,
  paywallWarningThreshold,
  PRIMARY_TIER_TYPES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  RETRY_PRECEDENCE,
  tokenizeTitle,
  WARNING_DIMENSIONS,
  formatEnumChoices,
  makeIdPattern,
  resolveFixHint,
} from './validation-catalog.mjs';
import { validationEnvelope } from './contracts/validation-result.mjs';
import { checkDistinctChapterSources } from './source-quote-checks.mjs';

function parseArgs(argv) {
  const args = { folder: null, chapter: null, strict: false, format: 'text' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') args.strict = true;
    else if (arg === '--format') {
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) {
        console.error(`[check:chapter] --format requires a value (text|json|compact)`);
        process.exit(EXIT.failure);
      }
      args.format = next;
    } else if (arg.startsWith('-')) {
      console.error(`[check:chapter] unknown flag: ${arg}`);
      console.error('[check:chapter] usage: node .agents/skills/startup-research/scripts/check-chapter.mjs <report-folder> <chapter-artifact.yaml> [--strict] [--format text|json|compact]');
      process.exit(EXIT.failure);
    } else if (!args.folder) args.folder = arg;
    else if (!args.chapter) args.chapter = arg;
    else {
      console.error(`[check:chapter] unexpected positional argument: ${arg}`);
      process.exit(EXIT.failure);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.folder || !args.chapter) {
  console.error('[check:chapter] usage: node .agents/skills/startup-research/scripts/check-chapter.mjs <report-folder> <chapter-artifact.yaml> [--strict] [--format text|json|compact]');
  process.exit(EXIT.failure);
}
if (!['text', 'json', 'compact'].includes(args.format)) {
  console.error(`[check:chapter] invalid --format value: ${args.format}; expected text, json, or compact`);
  process.exit(EXIT.failure);
}

const reportFolder = resolve(args.folder);

// Load the workflow config snapshot bound to this report folder when present
// (finalize-report writes one for every finalized report); otherwise fall
// back to the head config. Means editing the head workflow-config.yaml
// never retroactively re-judges old reports.
let ANALYSIS_ARTIFACTS;
// Lowercased substring tokens that mark a search query as volatile-fact-shaped.
// Sourced from agentPolicy.volatileFactQueryTokens; consumed by
// checkSearchQueryFreshness() to decide which queries must include a year
// token derived from doc.runDate.
let VOLATILE_FACT_QUERY_TOKENS;
// Authoritative report-level paywall ceiling, sourced from
// reportGate.maxPaywallPercent. The chapter early-warning threshold is
// derived from this via paywallWarningThreshold(); checkSources() consumes
// both so the warning text and the report-level fail message stay in sync.
let REPORT_PAYWALL_CEILING;
try {
  const config = loadWorkflowConfig({ reportFolder });
  ANALYSIS_ARTIFACTS = getAnalysisArtifacts(config);
  VOLATILE_FACT_QUERY_TOKENS = (config.agentPolicy?.volatileFactQueryTokens ?? [])
    .map((token) => String(token).toLowerCase())
    .filter((token) => token.length > 0);
  REPORT_PAYWALL_CEILING = config.reportGate?.maxPaywallPercent ?? 0.3;
} catch (err) {
  console.error(`[check:chapter] failed to load workflow config: ${err.message}`);
  console.error('[check:chapter] run `node .agents/skills/startup-research/scripts/check-workflow-config.mjs` to diagnose workflow-config.yaml.');
  process.exit(EXIT.failure);
}

const spec = ANALYSIS_ARTIFACTS.find((item) => item.file === args.chapter);
if (!spec) {
  console.error(`[check:chapter] unknown chapter artifact: ${args.chapter}`);
  console.error(`[check:chapter] expected one of: ${ANALYSIS_ARTIFACTS.map((item) => item.file).join(', ')}`);
  process.exit(EXIT.failure);
}

// Per-chapter id patterns: every id in this chapter must carry the chapter's
// own letter (e.g. for company-overview whose `letter:` is `O`, valid ids are
// SO###, CO###, TO###, FO###, QO###). Catches the common mistake of pasting
// an id from another chapter into this chapter's localEvidence/artifacts.
const ID_PATTERN_CHAPTER_TABLE = makeIdPattern('T', spec.letter);
const ID_PATTERN_CHAPTER_FIGURE = makeIdPattern('F', spec.letter);
const ID_PATTERN_CHAPTER_RESEARCH_QUESTION = makeIdPattern('Q', spec.letter);
const failures = [];
const warnings = [];

// FIX_HINTS, CASCADE_SUPPRESSORS, RETRY_PRECEDENCE, and resolveFixHint live
// in validation-catalog.mjs so the chapter runtime context can ship the same
// catalog to the agent before it writes anything (single source of truth).

function fail(dimension, message, extra = {}) {
  const entry = { dimension, file: spec.file, message, ...extra };
  const fix = resolveFixHint(dimension, extra);
  if (fix) entry.fix = fix;
  failures.push(entry);
}

function warn(dimension, message, extra = {}) {
  const entry = { dimension, file: spec.file, message, ...extra };
  const fix = resolveFixHint(dimension, extra);
  if (fix) entry.fix = fix;
  warnings.push(entry);
}

function loadYamlFile(file) {
  const path = join(reportFolder, file);
  if (!existsSync(path)) {
    fail('missingArtifact', `${file}: missing`);
    return null;
  }
  const result = tryReadYaml(path);
  if (!result.ok) {
    fail('yamlParse', `${file}: YAML parse failed: ${result.error}`);
    return null;
  }
  return result.value;
}

function figureTypeSet(doc) {
  return new Set((doc?.figures ?? []).map((figure) => figure?.type).filter(Boolean));
}

function figureDataPointCount(figure) {
  const data = figure?.data ?? {};
  return Math.max(
    data.items?.length ?? 0,
    data.nodes?.length ?? 0,
    data.edges?.length ?? 0,
    data.layers?.length ?? 0,
    data.series?.length ?? 0,
    data.columns?.length ?? 0,
    data.rows?.length ?? 0,
    data.points?.length ?? 0,
  );
}

function detailStats(doc) {
  const sectionWords = (doc.sections ?? []).map((section) => String(section?.body ?? '').trim().split(/\s+/).filter(Boolean).length);
  const tableRows = (doc.tables ?? []).map((table) => table?.rows?.length ?? 0);
  const figureDataPoints = (doc.figures ?? []).map(figureDataPointCount);
  return {
    minSectionWords: sectionWords.length ? Math.min(...sectionWords) : 0,
    sectionWordsTotal: sectionWords.reduce((sum, count) => sum + count, 0),
    tableRowsTotal: tableRows.reduce((sum, count) => sum + count, 0),
    figureDataPointsTotal: figureDataPoints.reduce((sum, count) => sum + count, 0),
  };
}

function checkDepthFloor(file, doc, floor) {
  const stats = detailStats(doc);
  if (stats.minSectionWords < floor.minSectionBodyWords) {
    fail('depthSection', `${file}: thin section prose (${stats.minSectionWords} words in shortest section); expected every section body to have at least ${floor.minSectionBodyWords}`, { actual: stats.minSectionWords, required: floor.minSectionBodyWords });
  }
  if (stats.sectionWordsTotal < floor.minSectionWordsTotal) {
    fail('depthSectionTotal', `${file}: thin section prose (${stats.sectionWordsTotal} total section words); expected at least ${floor.minSectionWordsTotal}`, { actual: stats.sectionWordsTotal, required: floor.minSectionWordsTotal });
  }
  if (stats.tableRowsTotal < floor.minTableRowsTotal) {
    fail('depthTableRows', `${file}: thin table analysis (${stats.tableRowsTotal} total table rows); expected at least ${floor.minTableRowsTotal}`, { actual: stats.tableRowsTotal, required: floor.minTableRowsTotal });
  }
  if (stats.figureDataPointsTotal < floor.minFigureDataPointsTotal) {
    fail('depthFigureData', `${file}: thin figure data (${stats.figureDataPointsTotal} total figure data points); expected at least ${floor.minFigureDataPointsTotal}`, { actual: stats.figureDataPointsTotal, required: floor.minFigureDataPointsTotal });
  }
}

function displayTitle(item) {
  return item?.title ?? item?.label ?? item?.name ?? item?.id ?? '';
}

function collectEmbeddedClaimRefs(value, refs = new Set()) {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectEmbeddedClaimRefs(item, refs);
    return refs;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'claimRefs' && Array.isArray(child)) {
      for (const ref of child) if (typeof ref === 'string') refs.add(ref);
    } else {
      collectEmbeddedClaimRefs(child, refs);
    }
  }
  return refs;
}

function checkTableFigureOverlap(file, doc) {
  // Flags only genuine table↔figure duplicates: figures whose claimRefs are
  // a non-empty subset of the table's (i.e. the figure adds NO new claim) and
  // whose title tokens overlap the table's title meaningfully.
  //
  // History: previous rule also fired on (a) title token jaccard >= 0.75 alone
  // (sibling artifacts on the same topic but different lens — e.g. "Revenue
  // by region table" vs "Revenue by region map"), and (b) >= 75% claim
  // overlap on the smaller side, which falsely flagged paired views
  // intentionally summarizing top-N from a longer table. RUN-1 §7 / RUN-2 §B2
  // showed both producing +37/-37 cosmetic rewrites instead of catching real
  // duplication. The current rule fires only when the figure literally
  // re-renders a slice of the same claim set with no distinguishing claim;
  // the singleton guard (figureRefs >= 3) suppresses noise from one-row
  // figures that happen to share their backing claim with a tiny table.
  for (const table of doc.tables ?? []) {
    const tableTitle = displayTitle(table);
    const tableRefs = collectEmbeddedClaimRefs(table);
    if (tableRefs.size === 0) continue;
    for (const figure of doc.figures ?? []) {
      const figureTitle = displayTitle(figure);
      const figureRefs = collectEmbeddedClaimRefs(figure);
      if (figureRefs.size < 3) continue;
      const figureSubsetOfTable = [...figureRefs].every((ref) => tableRefs.has(ref));
      if (!figureSubsetOfTable) continue;
      const titleSimilarity = jaccardTokenSimilarity(
        tokenizeTitle(tableTitle),
        tokenizeTitle(figureTitle),
      );
      if (titleSimilarity < DUPLICATE_TITLE_THRESHOLD) continue;
      const sharedRefs = figureRefs.size; // by construction (subset)
      fail(
        'duplicateAnalysis',
        `${file}: figure ${figure.id ?? figureTitle} adds no claim that table ${table.id ?? tableTitle} does not already cover (${sharedRefs}/${figureRefs.size} of the figure's claimRefs are also on the table; title overlap ${(titleSimilarity * 100).toFixed(0)}%)`,
        { tableId: table.id, figureId: figure.id, sharedRefs, figureRefs: figureRefs.size },
      );
    }
  }
}

function loadEarlierChapterUrls(reportFolder, currentSpec, allSpecs) {
  const urls = new Set();
  const earlier = allSpecs.filter((s) => s.order < currentSpec.order);
  for (const s of earlier) {
    const path = join(reportFolder, s.file);
    if (!existsSync(path)) continue;
    const result = tryReadYaml(path);
    if (!result.ok) continue;
    for (const source of result.value?.localEvidence?.sources ?? []) {
      const key = canonicalSourceUrl(source?.url);
      if (key) urls.add(key);
    }
  }
  return urls;
}

// Failed attempts belong in the audit trail, but do not verify a citation.
// Return null for a missing trail so the caller can distinguish it from a
// trail that contains no successful retrievals.
function loadFetchTrailUrls(reportFolder) {
  const candidates = [];
  if (process.env.STARTUP_FETCH_LOG_PATH) candidates.push(resolve(process.env.STARTUP_FETCH_LOG_PATH));
  const runId = basename(reportFolder);
  candidates.push(resolve('.research-cache', runId, '_fetch-log.jsonl'));
  candidates.push(resolve('.research-cache', '_fetch-log.jsonl'));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let text;
    try { text = readFileSync(path, 'utf8'); }
    catch { continue; }
    const urls = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch { continue; }
      if (entry?.ok !== true || !Number.isInteger(entry.status)
          || entry.status < 200 || entry.status >= 300 || entry.error) continue;
      const u1 = canonicalSourceUrl(entry?.url);
      if (u1) urls.add(u1);
      const u2 = canonicalSourceUrl(entry?.finalUrl);
      if (u2) urls.add(u2);
    }
    return { urls, path };
  }
  return null;
}

// Build a map { localClaimId -> chapterFile } across every OTHER chapter that
// already exists on disk (earlier or later — agents sometimes patch chapter N
// after writing N+1). Used by checkLocalEvidence to distinguish the
// crossChapterRefLeak failure ("this id is defined elsewhere — restate it
// here as a new local claim") from the generic claimRefs failure ("this id
// does not exist anywhere"). Returns the FIRST chapter where the id is found
// so the fix message can name a concrete file.
function loadOtherChapterClaimIds(reportFolder, currentSpec, allSpecs) {
  const claimIdToFile = new Map();
  const others = allSpecs.filter((s) => s.file !== currentSpec.file);
  for (const s of others) {
    const path = join(reportFolder, s.file);
    if (!existsSync(path)) continue;
    const result = tryReadYaml(path);
    if (!result.ok) continue;
    for (const claim of result.value?.localEvidence?.claims ?? []) {
      const id = claim?.id;
      if (typeof id === 'string' && !claimIdToFile.has(id)) claimIdToFile.set(id, s.file);
    }
  }
  return claimIdToFile;
}

function checkSearchQueries(file, doc) {
  const queries = doc.localEvidence?.searchQueries;
  if (!Array.isArray(queries)) {
    fail('searchQueriesMissing', `${file}: localEvidence.searchQueries[] is required (use [] only when researchQuestions is also empty)`);
    return;
  }
  const questionsCount = (doc.localEvidence?.researchQuestions ?? []).length;
  if (questionsCount > 0 && queries.length === 0) {
    fail('searchQueriesMissing', `${file}: ${questionsCount} researchQuestions but searchQueries is empty (every chapter must record the queries it actually ran)`);
  }
  for (const [index, q] of queries.entries()) {
    if (typeof q !== 'object' || q === null || typeof q.query !== 'string' || !q.query.trim()) {
      fail('searchQueriesMissing', `${file}: localEvidence.searchQueries[${index}] must have a non-empty query string`);
    }
  }
}

// Per-query freshness anchor: every query whose lowercased text contains a
// volatileFactQueryTokens substring must contain the runDate's year as a
// literal 4-digit token. The prior year may also appear for trailing windows,
// but it does not replace the runDate year. This pushes the search engine
// toward fresh sources for the volatile facts the agent is supposed to
// re-fetch every run (rules.md → researchRules). This is a hard gate: if the
// query log shows stale planning, the agent must re-plan/re-search instead of
// acknowledging the warning away.
//
// Skipped when:
//   - searchQueries is not an array (searchQueriesMissing already fired);
//   - doc.runDate is missing/malformed (documentHead already fires);
//   - VOLATILE_FACT_QUERY_TOKENS is empty (workflow-config drift; the
//     check-workflow-config gate also flags this).
// Cascade-suppressed by yamlParse and localEvidenceMissing.
function checkSearchQueryFreshness(file, doc) {
  if (!Array.isArray(VOLATILE_FACT_QUERY_TOKENS) || VOLATILE_FACT_QUERY_TOKENS.length === 0) return;
  const queries = doc?.localEvidence?.searchQueries;
  if (!Array.isArray(queries) || queries.length === 0) return;
  const yearMatch = typeof doc?.runDate === 'string' ? doc.runDate.match(/^(\d{4})-\d{2}-\d{2}$/) : null;
  if (!yearMatch) return;
  const runYear = Number.parseInt(yearMatch[1], 10);
  const trailingYear = runYear - 1;
  const runYearRegex = new RegExp(`\\b${runYear}\\b`);
  const trailingYearRegex = new RegExp(`\\b${trailingYear}\\b`);
  for (const [index, qe] of queries.entries()) {
    const text = typeof qe?.query === 'string' ? qe.query.trim() : '';
    if (!text) continue;
    const lower = text.toLowerCase();
    const matchedToken = VOLATILE_FACT_QUERY_TOKENS.find((token) => {
      // Word-ish substring: the token is treated as a literal substring.
      // Cheap and good enough for this list ("raise", "ipo", "ceo"); the
      // alternative \\b-based regex is fragile around punctuation like
      // "S-1" and adds no precision the agent can act on.
      return lower.includes(token);
    });
    if (!matchedToken) continue;
    if (runYearRegex.test(text)) continue;
    fail(
      'searchQueryFreshness',
      `${file}: localEvidence.searchQueries[${index}].query "${text}" matches volatile-fact token "${matchedToken}" but does not contain runDate year ${runYear}; volatile-fact queries must include the runDate year as a literal token. The prior year ${trailingYear} is allowed only as an additional trailing-window token, not as a substitute.`,
      { index, query: text, runYear, trailingYear, hasTrailingYear: trailingYearRegex.test(text), matchedToken },
    );
  }
}

function checkSources(file, doc, gate, earlierUrls) {
  const sources = doc.localEvidence?.sources ?? [];
  let shapeFails = 0;
  const domains = new Set();
  const types = new Set();
  let netNew = 0;
  let adverseCount = 0;
  let restrictedCount = 0;
  for (const source of sources) {
    const path = `${file}: source ${source?.id ?? '?'}`;
    // Full schema validation via the shared helper (required fields, enum
    // values, date format, topic shape). Each violation becomes a
    // sourceShape failure with the same message check-report would emit.
    const { errors } = checkSourceSchema(source, { path });
    for (const err of errors) {
      fail('sourceShape', err.message, { id: source?.id, ...err });
      shapeFails += 1;
    }
    if (source?.accessStatus && source.accessStatus !== 'ok') restrictedCount += 1;
    if (source?.stance === 'adverse') adverseCount += 1;
    if (source?.sourceType) types.add(source.sourceType);
    const domain = registrableDomain(source?.url);
    if (domain) domains.add(domain);
    const canonical = canonicalSourceUrl(source?.url);
    if (canonical && !earlierUrls.has(canonical)) netNew += 1;
  }
  if (shapeFails > 0) return; // skip diversity checks until shape is fixed

  if (sources.length === 0) return; // count check handled by checkLocalEvidence
  if (domains.size < gate.minSourceDomains) {
    fail('sourceDomains', `${file}: ${domains.size} distinct registrable domains across sources, expected at least ${gate.minSourceDomains}`, { actual: domains.size, required: gate.minSourceDomains });
  }
  if (types.size < gate.minSourceTypeSpread) {
    fail('sourceTypeSpread', `${file}: ${types.size} distinct sourceType values, expected at least ${gate.minSourceTypeSpread}`, { actual: types.size, required: gate.minSourceTypeSpread });
  }
  // Per-chapter adverse-stance requirement. Driven by gate.minAdverseSources,
  // which load-chapter-runtime-context.mjs derives from
  // workflow-config.adverseDistribution.requireAtLeastOneAdverseSource so the
  // runtime context the agent receives and the check it must clear share one source of
  // truth. Catches the RUN-2 failure pattern (every fintech report failed at
  // finalize because ch1 / ch6 / ch8 only carried neutral/confirming sources).
  const minAdverseSources = gate.minAdverseSources ?? 0;
  if (minAdverseSources > 0 && adverseCount < minAdverseSources) {
    fail('sourceStanceSpread', `${file}: ${adverseCount} stance:adverse sources, expected at least ${minAdverseSources}`, { actual: adverseCount, required: minAdverseSources, chapterKey: spec.key });
  }
  for (const required of gate.requiredSourceTypes ?? []) {
    if (!types.has(required)) {
      fail('requiredSourceTypes', `${file}: missing required sourceType "${required}" (chapter requires ${(gate.requiredSourceTypes ?? []).join(', ')})`, { missing: required });
    }
  }
  if (netNew < gate.minNetNewSources) {
    fail('netNewSources', `${file}: only ${netNew} sources are new vs earlier chapters, expected at least ${gate.minNetNewSources} (per-chapter research must add fresh sources, not reuse the global pool)`, { actual: netNew, required: gate.minNetNewSources });
  }
  // Soft early-warning: if a single chapter's restricted-access share exceeds
  // the warning threshold (derived from the report-level paywall ceiling
  // minus a buffer), the report-level ceiling becomes hard to clear without
  // swapping sources. Advisory only — does not fail unless --strict is set
  // and the dimension is not in acknowledgedWarnings.
  const warningThreshold = paywallWarningThreshold(REPORT_PAYWALL_CEILING);
  const restrictedPct = restrictedCount / sources.length;
  if (restrictedPct > warningThreshold) {
    const warnPctLabel = (warningThreshold * 100).toFixed(0);
    const ceilingPctLabel = (REPORT_PAYWALL_CEILING * 100).toFixed(0);
    warn('paywallRisk', `${file}: ${restrictedCount}/${sources.length} sources have restricted accessStatus (paywall|js-only|broken|rate-limited) = ${(restrictedPct * 100).toFixed(0)}% (>${warnPctLabel}%). Risk of breaching the report-level ${ceilingPctLabel}% ceiling once chapters aggregate; swap restricted sources for ok ones where possible.`, { actual: +restrictedPct.toFixed(3), warningThreshold: +warningThreshold.toFixed(3), reportCeiling: +REPORT_PAYWALL_CEILING.toFixed(3) });
  }
  // adverse-source bookkeeping is informational; the binding constraint is on adverse questions (P1) and on risks chapter sourceType requirements above.
}

function checkHighConfidenceCorroboration(file, doc, gate) {
  const sourceById = new Map((doc.localEvidence?.sources ?? []).map((s) => [s?.id, s]));
  const min = gate.minHighConfidenceCorroboration;
  for (const claim of doc.localEvidence?.claims ?? []) {
    if (claim?.confidence !== 'high') continue;
    const refs = claim.sourceRefs ?? [];
    if (refs.length < min) {
      fail('highConfidenceCorroboration', `${file}: claim ${claim.id} has confidence=high but only ${refs.length} sourceRefs (need >= ${min})`, { claimId: claim.id, actual: refs.length, required: min });
      continue;
    }
    const hasPrimary = refs.some((ref) => {
      const s = sourceById.get(ref);
      return s && (PRIMARY_TIER_TYPES.has(s.sourceType) || s.reputationTier === 'high');
    });
    if (!hasPrimary) {
      fail('highConfidenceCorroboration', `${file}: claim ${claim.id} has confidence=high but no sourceRef is primary tier (filing/regulatory/legal/official) or reputationTier=high`, { claimId: claim.id });
    }
  }
}

function checkEnumerationTables(file, doc, gate, plannedTablesByName) {
  const enumerationPlans = [...plannedTablesByName.values()].filter((plan) => plan.enumeration === true);
  if (enumerationPlans.length === 0) return;
  const sourceById = new Map((doc.localEvidence?.sources ?? []).map((s) => [s?.id, s]));
  const claimById = new Map((doc.localEvidence?.claims ?? []).map((c) => [c?.id, c]));
  for (const plan of enumerationPlans) {
    const planSlug = titleSlug(plan.name);
    const table = (doc.tables ?? []).find((t) => titleSlug(t?.title) === planSlug);
    if (!table) {
      fail('enumerationScope', `${file}: planned enumeration table "${plan.name}" not present in tables[] (slug=${planSlug})`, { planned: plan.name });
      continue;
    }
    const scope = table.enumerationScope;
    if (!scope || typeof scope !== 'object') {
      fail('enumerationScope', `${file}: table ${table.id} ("${table.title}") is an enumeration table; enumerationScope { coverage, basis } is required`, { tableId: table.id });
      continue;
    }
    if (!ENUMERATION_COVERAGE.has(scope.coverage)) {
      fail('enumerationScope', `${file}: table ${table.id} enumerationScope.coverage must be one of ${formatEnumChoices(ENUMERATION_COVERAGE)}`, { tableId: table.id, actual: scope.coverage });
    }
    if (typeof scope.basis !== 'string' || scope.basis.trim().length < 20) {
      fail('enumerationScope', `${file}: table ${table.id} enumerationScope.basis must be at least 20 chars (explain how completeness was verified)`, { tableId: table.id });
    } else {
      // Defend against pathological strings that pass the char count but
      // carry no meaning (e.g. 20 spaces, "aaaaaaaaaaaaaaaaaaaa", or the
      // same word repeated). Require at least 4 distinct alphanumeric
      // word tokens of >= 3 chars — a brief verifiable phrase like
      // "Verified against SEC EDGAR 2024 filings" clears it; a wall of
      // identical characters does not.
      const distinctBasisTokens = new Set(String(scope.basis).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
      if (distinctBasisTokens.size < 4) {
        fail('enumerationScope', `${file}: table ${table.id} enumerationScope.basis has only ${distinctBasisTokens.size} distinct alphanumeric word(s) of >=3 chars; rewrite the basis as a verifiable sentence (cite the source list, registry, or filter that establishes completeness)`, { tableId: table.id, distinctTokens: distinctBasisTokens.size, required: 4 });
      }
    }
    const rowCount = Array.isArray(table.rows) ? table.rows.length : 0;
    if (rowCount < (plan.expectedMinRows ?? 0) && scope.coverage === 'exhaustive') {
      fail('enumerationRows', `${file}: table ${table.id} ("${table.title}") has ${rowCount} rows < expectedMinRows ${plan.expectedMinRows} for an exhaustive enumeration; either add rows or set coverage to partial/sample with rationale`, { tableId: table.id, actual: rowCount, required: plan.expectedMinRows });
    }
    if (scope.coverage !== 'exhaustive') {
      const titleKey = String(table.title ?? '').toLowerCase();
      const referenced = (doc.localEvidence?.evidenceGaps ?? []).some((gap) => {
        const topic = String(gap?.topic ?? '').toLowerCase();
        return topic.includes(titleKey.slice(0, 30)) || (gap?.relatedTableRefs ?? []).includes(table.id);
      });
      if (!referenced) {
        fail('enumerationCoverageGap', `${file}: table ${table.id} coverage=${scope.coverage} requires an evidenceGap entry whose topic mentions the table or whose relatedTableRefs[] includes ${table.id}`, { tableId: table.id, coverage: scope.coverage });
      }
    }
    // Table-level corroboration: the enumeration table's table-level
    // claimRefs must reference sources spanning at least
    // gate.minSourcesPerEnumerationRow distinct registrable domains. The
    // YAML schema attaches claimRefs to the table, not to individual rows,
    // so this check is necessarily table-level.
    const tableClaimRefs = new Set(table.claimRefs ?? []);
    const tableDomains = new Set();
    for (const ref of tableClaimRefs) {
      const claim = claimById.get(ref);
      if (!claim) continue;
      for (const sref of claim.sourceRefs ?? []) {
        const s = sourceById.get(sref);
        const dom = registrableDomain(s?.url);
        if (dom) tableDomains.add(dom);
      }
    }
    if (rowCount > 0 && tableDomains.size < gate.minSourcesPerEnumerationRow) {
      fail('enumerationTableCorroboration', `${file}: table ${table.id} table-level claimRefs reference sources from only ${tableDomains.size} distinct registrable domain(s) (need >= ${gate.minSourcesPerEnumerationRow}); enumeration tables must be cross-checked across independent domains`, { tableId: table.id, actual: tableDomains.size, required: gate.minSourcesPerEnumerationRow });
    }
  }
}

function checkResearchQuestions(file, doc, gate, plannedTablesByName, plannedFiguresByName, contentRequirementsCount) {
  const questions = doc.localEvidence?.researchQuestions ?? [];
  const seenIds = new Set();
  const typeCounts = new Map();
  let answeredCount = 0;
  const targetedReqIndices = new Set();

  for (const [index, question] of questions.entries()) {
    if (typeof question !== 'object' || question === null) {
      fail('researchQuestionShape', `${file}: localEvidence.researchQuestions[${index}] must be an object with id/question/type/targets/status`);
      continue;
    }
    if (!ID_PATTERN_CHAPTER_RESEARCH_QUESTION.test(String(question.id ?? ''))) {
      fail('researchQuestionShape', `${file}: localEvidence.researchQuestions[${index}].id must match Q${spec.letter}### (chapter '${spec.key}' uses letter '${spec.letter}')`, { id: question.id });
      continue;
    }
    if (seenIds.has(question.id)) {
      fail('researchQuestionShape', `${file}: duplicate researchQuestions id ${question.id}`, { id: question.id });
    }
    seenIds.add(question.id);
    if (typeof question.question !== 'string' || question.question.trim().length < 20) {
      fail('researchQuestionShape', `${file}: ${question.id} question text must be at least 20 chars`, { id: question.id });
    }
    if (!QUESTION_TYPES.has(question.type)) {
      fail('researchQuestionShape', `${file}: ${question.id} type must be one of ${formatEnumChoices(QUESTION_TYPES)}`, { id: question.id, actual: question.type });
    } else {
      typeCounts.set(question.type, (typeCounts.get(question.type) ?? 0) + 1);
    }
    if (!QUESTION_STATUSES.has(question.status)) {
      fail('researchQuestionShape', `${file}: ${question.id} status must be one of ${formatEnumChoices(QUESTION_STATUSES)}`, { id: question.id, actual: question.status });
    } else if (question.status === 'answered') {
      answeredCount += 1;
    } else if (!(doc.localEvidence?.evidenceGaps ?? []).some((gap) => (gap?.relatedQuestionRefs ?? []).includes(question.id))) {
      // Closure is gated on an explicit evidenceGap.relatedQuestionRefs[]
      // pointer; topic-string heuristics were unreliable (a full question
      // sentence rarely equals a short topic tag) and gave the impression
      // that fuzzy matching could substitute for a proper ref.
      fail('researchQuestionClosure', `${file}: ${question.id} status=${question.status} but no evidenceGap entry lists it under relatedQuestionRefs[]`, { id: question.id });
    }
    if (!Array.isArray(question.targets) || question.targets.length === 0) {
      fail('researchQuestionShape', `${file}: ${question.id} targets[] must be a non-empty array`, { id: question.id });
    } else {
      for (const target of question.targets) {
        const reqMatch = /^contentRequirements\/(\d+)$/.exec(String(target));
        if (reqMatch) {
          const idx = Number(reqMatch[1]);
          if (idx < 0 || idx >= contentRequirementsCount) {
            fail('researchQuestionTargets', `${file}: ${question.id} target "${target}" out of range (chapter has ${contentRequirementsCount} contentRequirements)`, { id: question.id });
          } else {
            targetedReqIndices.add(idx);
          }
          continue;
        }
        const tableMatch = /^plannedTables\/(.+)$/.exec(String(target));
        if (tableMatch) {
          if (!plannedTablesByName.has(tableMatch[1])) {
            fail('researchQuestionTargets', `${file}: ${question.id} target "${target}" does not match any plannedTables[].name (slug)`, { id: question.id });
          }
          continue;
        }
        const figureMatch = /^plannedFigures\/(.+)$/.exec(String(target));
        if (figureMatch) {
          if (!plannedFiguresByName.has(figureMatch[1])) {
            fail('researchQuestionTargets', `${file}: ${question.id} target "${target}" does not match any plannedFigures[].name (slug)`, { id: question.id });
          }
          continue;
        }
        fail('researchQuestionTargets', `${file}: ${question.id} target "${target}" must be contentRequirements/<index>, plannedTables/<slug>, or plannedFigures/<slug>`, { id: question.id });
      }
    }
  }

  if (questions.length === 0) return; // researchQuestions count check is handled by checkLocalEvidence

  const distinctTypes = typeCounts.size;
  if (distinctTypes < gate.minQuestionTypeSpread) {
    fail('researchQuestionTypeMix', `${file}: researchQuestions[] cover ${distinctTypes} distinct types, expected at least ${gate.minQuestionTypeSpread} (${formatEnumChoices(QUESTION_TYPES)})`, { actual: distinctTypes, required: gate.minQuestionTypeSpread });
  }
  const adverseCount = typeCounts.get('adverse') ?? 0;
  if (adverseCount < gate.minAdverseQuestions) {
    fail('researchQuestionAdverse', `${file}: only ${adverseCount} type=adverse questions, expected at least ${gate.minAdverseQuestions}`, { actual: adverseCount, required: gate.minAdverseQuestions });
  }
  const answerRate = answeredCount / questions.length;
  if (answerRate < gate.minQuestionAnswerRate) {
    fail('researchQuestionAnswerCoverage', `${file}: only ${answeredCount}/${questions.length} questions are status=answered (${answerRate.toFixed(2)}), expected ${gate.minQuestionAnswerRate}`, { actual: answerRate, required: gate.minQuestionAnswerRate });
  }
  if (contentRequirementsCount > 0) {
    const coverageRate = targetedReqIndices.size / contentRequirementsCount;
    if (coverageRate < gate.minContentRequirementCoverage) {
      fail('contentRequirementCoverage', `${file}: only ${targetedReqIndices.size}/${contentRequirementsCount} contentRequirements have a researchQuestion target (${coverageRate.toFixed(2)}), expected ${gate.minContentRequirementCoverage}`, { actual: coverageRate, required: gate.minContentRequirementCoverage });
    }
  }
}

function titleSlug(value) {
  // Title-slug used to match planned table/figure names (workflow-config.yaml) against
  // actual table/figure titles. Intentionally simpler than utils.slugify() —
  // no `&→and` substitution, no length cap, no fallback — because we are
  // comparing two human-authored title strings, not building a URL slug.
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function checkClaimAnswerRefs(file, doc) {
  const questionIds = new Set((doc.localEvidence?.researchQuestions ?? []).map((q) => q?.id).filter(Boolean));
  const localClaimIds = new Set((doc.localEvidence?.claims ?? []).map((claim) => claim?.id));
  for (const claim of doc.localEvidence?.claims ?? []) {
    for (const ref of claim?.answersQuestionRefs ?? []) {
      if (!questionIds.has(ref)) {
        fail('claimAnswerRefs', `${file}: claim ${claim.id} answersQuestionRefs references unknown question ${ref}`, { claimId: claim.id, ref });
      }
    }
    for (const ref of claim?.contradictsClaimRefs ?? []) {
      if (!localClaimIds.has(ref)) {
        fail('claimContradictRefs', `${file}: claim ${claim.id} contradictsClaimRefs references unknown local claim ${ref}`, { claimId: claim.id, ref });
      }
    }
    if (claim?.type === 'conflicting' && (!Array.isArray(claim.contradictsClaimRefs) || claim.contradictsClaimRefs.length === 0)) {
      fail('claimContradictRefs', `${file}: claim ${claim.id} has type=conflicting but no contradictsClaimRefs`, { claimId: claim.id });
    }
  }
}

function checkLocalEvidence(file, doc, counts, otherChapterClaimIds) {
  if (!doc.localEvidence) {
    fail('localEvidenceMissing', `${file}: missing localEvidence before ledger consolidation`);
    return;
  }
  const uniqueSources = new Set((doc.localEvidence.sources ?? []).map((source) => canonicalSourceUrl(source?.url)).filter(Boolean));
  for (const issue of checkDistinctChapterSources(doc.localEvidence.sources ?? [], file)) {
    fail('sources', issue.message, issue);
  }
  const minimums = [
    ['researchQuestions', 'researchQuestions', 'localEvidence.researchQuestions[]', spec.gate.minResearchQuestions],
    ['sources', 'sources', 'localEvidence.sources[]', spec.gate.minLocalSources],
    ['claims', 'claims', 'localEvidence.claims[]', spec.gate.minLocalClaims],
  ];
  for (const [key, dimension, path, min] of minimums) {
    const actual = key === 'sources' ? uniqueSources.size : counts[key];
    if (actual < min) {
      fail(dimension, `${file}: ${path} has ${actual}${key === 'sources' ? ' distinct canonical URLs' : ''}, expected at least ${min}`, { actual, required: min });
    }
  }
  const maximums = [
    ['researchQuestions', 'researchQuestions', 'localEvidence.researchQuestions[]', spec.gate.maxResearchQuestions],
    ['sources', 'sources', 'localEvidence.sources[]', spec.gate.maxLocalSources],
    ['claims', 'claims', 'localEvidence.claims[]', spec.gate.maxLocalClaims],
  ];
  for (const [key, dimension, path, max] of maximums) {
    if (typeof max === 'number' && counts[key] > max) {
      fail(dimension, `${file}: ${path} has ${counts[key]}, expected at most ${max} for this research profile`, { actual: counts[key], required: max });
    }
  }
  const localClaimIds = new Set((doc.localEvidence.claims ?? []).map((claim) => claim?.id));
  // Walk every claimRefs[] across sections / tables / figures / callouts. An
  // unresolved ref splits two ways:
  //   - foundIn another chapter -> crossChapterRefLeak (the agent copied an id
  //     from elsewhere). Each chapter has its own letter (workflow-config.yaml
  //     `letter:`); ids are formed as <Type><ChapterLetter><Seq3>, so an id
  //     whose letter does not match this chapter's letter is by construction
  //     foreign. The right fix is to restate the underlying fact as a new
  //     local claim here, not to copy the id.
  //   - not foundIn anywhere -> the original generic claimRefs failure.
  // Splitting the dimension makes the retry loop signal sharper: a brief
  // digest entry of `crossChapterRefLeak` is unambiguous.
  for (const ref of collectClaimRefs(doc)) {
    if (localClaimIds.has(ref)) continue;
    const foundIn = otherChapterClaimIds.get(ref);
    if (foundIn) {
      fail('crossChapterRefLeak', `${file}: claimRef ${ref} belongs to another chapter (${foundIn}); chapter-letter ids must not be copied across chapters`, { unresolvedRef: ref, foundIn });
    } else {
      fail('claimRefs', `${file}: claimRef ${ref} does not resolve to localEvidence.claims before consolidation`, { unresolvedRef: ref });
    }
  }
}

const doc = loadYamlFile(spec.file);
let counts = null;
if (doc) {
  // Document head: schemaVersion, artifact, slug, runDate, company.name,
  // chapter.number. Catches malformed runDate, wrong chapter.number, missing
  // company.name at chapter time instead of waiting for check-report.
  {
    const { errors } = checkDocumentHeadSchema(doc, { path: spec.file, expected: spec });
    for (const err of errors) fail('documentHead', err.message, err);
  }
  // Slug must equal the company slug, i.e. the report folder basename with
  // the leading <timestamp>- prefix stripped. create-report-run.mjs creates the
  // folder as `${timestamp}-${slugify(companyName)}`; the chapter `slug:`
  // field is the second half only. Catches the drift seen in RUN-1 where
  // every chapter accidentally carried the full `<timestamp>-<companySlug>`.
  {
    const canonical = companySlugFromRunId(basename(reportFolder));
    if (doc?.slug && doc.slug !== canonical) {
      fail('slugConsistency', `${spec.file}: slug "${doc.slug}" does not match folder slug "${canonical}"`, { actual: doc.slug, required: canonical });
    }
  }
  // runDate must equal the UTC YYYY-MM-DD derived from the runId timestamp
  // prefix. Without this, an agent that hand-formats a date from the model
  // clock can drift to the wrong year, which then becomes the freshness
  // anchor for searchQueryFreshness — silently bypassing the volatile-fact
  // gate. Skipped when documentHead already failed (doc.runDate missing or
  // malformed) so retry triage is not flooded with cascading noise.
  {
    const canonical = runDateFromRunId(basename(reportFolder));
    if (typeof doc?.runDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.runDate) && doc.runDate !== canonical) {
      fail('runDateConsistency', `${spec.file}: runDate "${doc.runDate}" does not match the runId-derived runDate "${canonical}" (UTC YYYY-MM-DD from the report folder timestamp prefix)`, { actual: doc.runDate, required: canonical });
    }
  }
  // Chapter-local table/figure id uniqueness (T<ChapterLetter>### /
  // F<ChapterLetter>###). Duplicate or
  // malformed ids would otherwise blow up at build-evidence-ledger/build-report time.
  {
    const { errors } = checkUniqueIds(doc.tables, { label: 'table', pattern: ID_PATTERN_CHAPTER_TABLE, path: spec.file });
    for (const err of errors) fail('duplicateIds', err.message, err);
  }
  {
    const { errors } = checkUniqueIds(doc.figures, { label: 'figure', pattern: ID_PATTERN_CHAPTER_FIGURE, path: spec.file });
    for (const err of errors) fail('duplicateIds', err.message, err);
  }
  // Chapter-local figureRef / tableRef resolution. The same check runs
  // again post-finalize against the assembled full-report (where ids are
  // global), but catching dangling refs here means the agent fixes them
  // without rebuilding the whole report.
  {
    const figureIds = new Set((doc.figures ?? []).map((f) => f?.id).filter(Boolean));
    const tableIds = new Set((doc.tables ?? []).map((t) => t?.id).filter(Boolean));
    const { errors } = checkArtifactRefs(doc, { path: spec.file, figureIds, tableIds });
    for (const err of errors) fail('artifactRefs', err.message, err);
    // Section-level tableRefs[] / figureRefs[] anchor exhibits inside a
    // section's prose. Each id must resolve to a local table/figure and
    // appear in at most one section across the chapter so build-report can
    // emit it exactly once (anything left over still falls through to the
    // trailing Exhibits section).
    const sectionTableHome = new Map();
    const sectionFigureHome = new Map();
    for (const section of doc.sections ?? []) {
      for (const ref of section?.tableRefs ?? []) {
        if (!tableIds.has(ref)) {
          fail('artifactRefs', `${spec.file}: section ${section.id} tableRefs entry ${ref} does not resolve to a local table`, { sectionId: section.id, ref });
          continue;
        }
        const prior = sectionTableHome.get(ref);
        if (prior && prior !== section.id) {
          fail('artifactRefs', `${spec.file}: table ${ref} is listed in section ${prior} and section ${section.id}; each table must have exactly one section home`, { ref, sections: [prior, section.id] });
        } else {
          sectionTableHome.set(ref, section.id);
        }
      }
      for (const ref of section?.figureRefs ?? []) {
        if (!figureIds.has(ref)) {
          fail('artifactRefs', `${spec.file}: section ${section.id} figureRefs entry ${ref} does not resolve to a local figure`, { sectionId: section.id, ref });
          continue;
        }
        const prior = sectionFigureHome.get(ref);
        if (prior && prior !== section.id) {
          fail('artifactRefs', `${spec.file}: figure ${ref} is listed in section ${prior} and section ${section.id}; each figure must have exactly one section home`, { ref, sections: [prior, section.id] });
        } else {
          sectionFigureHome.set(ref, section.id);
        }
      }
    }
    // Coverage check (warning, ack-eligible, --strict promotes to failure):
    // every table/figure should be claimed by some section so the renderer
    // can place it inline. Anything left over still falls through to the
    // trailing Exhibits section (build-report.mjs), but Exhibits is meant
    // for genuinely cross-cutting artifacts, not the default landing place
    // for forgotten ids.
    for (const table of doc.tables ?? []) {
      if (!table?.id) continue;
      if (sectionTableHome.has(table.id)) continue;
      warn('unsectionedExhibits', `${spec.file}: table ${table.id} is not referenced by any section.tableRefs[]; it falls through to the trailing Exhibits section. Add ${table.id} to the tableRefs[] of the section whose prose introduces or relies on it, or acknowledge dimension "unsectionedExhibits" if the table is intentionally orphaned.`, { id: table.id, kind: 'table' });
    }
    for (const figure of doc.figures ?? []) {
      if (!figure?.id) continue;
      if (sectionFigureHome.has(figure.id)) continue;
      warn('unsectionedExhibits', `${spec.file}: figure ${figure.id} is not referenced by any section.figureRefs[]; it falls through to the trailing Exhibits section. Add ${figure.id} to the figureRefs[] of the section whose prose introduces or relies on it, or acknowledge dimension "unsectionedExhibits" if the figure is intentionally orphaned.`, { id: figure.id, kind: 'figure' });
    }
  }

  counts = {
    sections: doc.sections?.length ?? 0,
    tables: doc.tables?.length ?? 0,
    figures: doc.figures?.length ?? 0,
    sources: doc.localEvidence?.sources?.length ?? 0,
    claims: doc.localEvidence?.claims?.length ?? 0,
    gaps: doc.localEvidence?.evidenceGaps?.length ?? 0,
    researchQuestions: doc.localEvidence?.researchQuestions?.length ?? 0,
  };

  const gate = spec.gate;
  // Tables and figures are interchangeable artifact slots: agents may swap a
  // planned figure for an additional table when the collected data does not
  // fit the planned figure type. Per-type ceilings remain soft warnings.
  // gate.minArtifacts is already the effective floor (max of defaultGate and
  // the chapter's planned table+figure count) — normalizeWorkflowConfig in
  // contracts/workflow-config.schema.mjs computes it once so the runtime
  // context the agent receives and the gate check-chapter enforces match.
  const totalArtifacts = counts.tables + counts.figures;
  if (counts.sections < gate.minSections) {
    fail('sectionsMin', `${spec.file}: ${counts.sections} sections, expected at least ${gate.minSections}`, { actual: counts.sections, required: gate.minSections });
  }
  if (totalArtifacts < gate.minArtifacts) {
    fail('artifactsMin', `${spec.file}: ${counts.tables} tables + ${counts.figures} figures = ${totalArtifacts} artifacts, expected at least ${gate.minArtifacts} (plannedTables=${spec.plannedTables.length}, plannedFigures=${spec.plannedFigures.length}; figures may be substituted with tables when data shape does not fit)`, { actual: totalArtifacts, required: gate.minArtifacts });
  }
  if (counts.sections > gate.maxSections) {
    warn('sectionsMax', `${spec.file}: ${counts.sections} sections exceeds target range maximum ${gate.maxSections}; verify the chapter is not over-fragmented or duplicative`, { actual: counts.sections, ceiling: gate.maxSections });
  }
  if (counts.tables > gate.maxTables) {
    warn('tablesMax', `${spec.file}: ${counts.tables} tables exceeds target range maximum ${gate.maxTables}; verify the chapter is not over-fragmented or duplicative`, { actual: counts.tables, ceiling: gate.maxTables });
  }
  if (counts.figures > gate.maxFigures) {
    warn('figuresMax', `${spec.file}: ${counts.figures} figures exceeds target range maximum ${gate.maxFigures}; verify the chapter is not over-fragmented or duplicative`, { actual: counts.figures, ceiling: gate.maxFigures });
  }

  for (const err of checkAuthoringInstructions(doc, { path: spec.file }).errors) {
    fail('authoringInstructions', err.message, err);
  }
  checkDepthFloor(spec.file, doc, gate.depthFloor);
  checkTableFigureOverlap(spec.file, doc);

  const types = figureTypeSet(doc);
  const plannedTypes = new Set((spec.plannedFigures ?? []).flatMap((figure) => figure.acceptedTypes ?? []));
  if (counts.figures > 0 && plannedTypes.size && ![...plannedTypes].some((type) => types.has(type))) {
    warn('figureType', `${spec.file}: no planned figure type rendered (planned: ${[...plannedTypes].join(', ')}); confirm the substitution is intentional`, { rendered: [...types], planned: [...plannedTypes] });
  }

  for (const figure of doc.figures ?? []) {
    // Light shape check (data field presence per type contract).
    const { errors: lightErrors } = validateFigureShape(figure);
    for (const message of lightErrors) {
      fail('figureShape', `${spec.file}: ${message}`, { figureId: figure?.id ?? null });
    }
    // Deep schema check (item labels, matrix alignment, numeric/range/cohort
    // value rules, quadrant coordinates). Same rules check-report enforces.
    const { errors: deepErrors } = checkFigureDeep(figure, { path: spec.file });
    for (const err of deepErrors) {
      fail('figureShape', err.message, { figureId: figure?.id ?? null, ...err });
    }
  }

  // Per-claim schema (required fields, enum values, contradictsClaimRefs
  // when type=conflicting, sourceRefs non-empty unless open-question).
  for (const claim of doc.localEvidence?.claims ?? []) {
    const path = `${spec.file}: claim ${claim?.id ?? '?'}`;
    const { errors } = checkClaimSchema(claim, { path });
    for (const err of errors) fail('claimShape', err.message, { id: claim?.id, ...err });
  }

  // Per-callout schema (title, body, claimRefs[], optional calloutType enum).
  for (const [index, callout] of (doc.callouts ?? []).entries()) {
    const path = `${spec.file}: callout ${index + 1}`;
    const { errors } = checkCalloutSchema(callout, { path });
    for (const err of errors) fail('calloutShape', err.message, { index, ...err });
  }

  // Per-table column/row alignment + enumerationScope shape. The deeper
  // enumeration-coverage rules (per-row corroboration, gap requirement) live
  // in checkEnumerationTables below, since they need source/claim context.
  for (const table of doc.tables ?? []) {
    const path = `${spec.file}: table ${table?.id ?? '?'}`;
    const { errors } = checkTableSchema(table, { path });
    for (const err of errors) fail('tableShape', err.message, { tableId: table?.id, ...err });
    // Soft warning: tables[].notes should be populated when the table
    // carries any caveat (estimates, partial coverage, derived cells,
    // unit/vintage convention). Pure factual snapshots may leave notes
    // null and acknowledge this dimension. Warn only — never fails.
    const notes = typeof table?.notes === 'string' ? table.notes.trim() : '';
    const hasRows = Array.isArray(table?.rows) && table.rows.length > 0;
    if (hasRows && !notes) {
      warn('tableNotes', `${path}: notes is empty; add a one-line caveat (data source / estimation / partial coverage / what null means) or acknowledge this dimension if the table is a pure factual snapshot.`, { tableId: table?.id });
    }
  }

  const otherChapterClaimIds = loadOtherChapterClaimIds(reportFolder, spec, ANALYSIS_ARTIFACTS);
  checkLocalEvidence(spec.file, doc, counts, otherChapterClaimIds);
  const plannedTablesByName = new Map((spec.plannedTables ?? []).map((item) => [titleSlug(item.name), item]));
  const plannedFiguresByName = new Map((spec.plannedFigures ?? []).map((item) => [titleSlug(item.name), item]));
  checkResearchQuestions(spec.file, doc, gate, plannedTablesByName, plannedFiguresByName, (spec.contentRequirements ?? []).length);
  checkClaimAnswerRefs(spec.file, doc);
  checkSearchQueries(spec.file, doc);
  checkSearchQueryFreshness(spec.file, doc);
  const earlierUrls = loadEarlierChapterUrls(reportFolder, spec, ANALYSIS_ARTIFACTS);
  checkSources(spec.file, doc, gate, earlierUrls);
  // Cross-check cited URLs against the fetch-url trail file. The trail is
  // written by the fetch-url skill when STARTUP_FETCH_LOG_PATH is set; see
  // loadFetchTrailUrls() above. We emit two warning-class signals:
  //   - unverifiedSource: no successful retrieval of a cited URL is recorded.
  //   - fetchTrailMissing: chapter cites sources but no trail file was found
  //     anywhere check-chapter looked. Without it source verification is
  //     silently disabled, which is the most dangerous failure mode for
  //     subagent-driven runs (cited URLs are silently treated as verified).
  // Both are warnings under the default gate so older reports without a
  // trail file still pass; --strict promotes them to failures.
  const trail = loadFetchTrailUrls(reportFolder);
  if (trail) {
    for (const source of doc.localEvidence?.sources ?? []) {
      const canonical = canonicalSourceUrl(source?.url);
      if (!canonical) continue;
      if (!trail.urls.has(canonical)) {
        warn(
          'unverifiedSource',
          `${spec.file}: source ${source?.id ?? '?'} cites ${source?.url ?? '(missing url)'} but no successful retrieval of that URL was found in the fetch-url trail (${trail.path}); failed or incomplete fetch records do not verify the citation.`,
          { id: source?.id, url: source?.url ?? null },
        );
      }
    }
  } else if ((doc.localEvidence?.sources ?? []).length > 0) {
    warn(
      'fetchTrailMissing',
      `${spec.file}: chapter cites ${counts.sources} source(s) but no fetch-url trail file was found at any candidate path (STARTUP_FETCH_LOG_PATH, .research-cache/${basename(reportFolder)}/_fetch-log.jsonl, .research-cache/_fetch-log.jsonl); source verification is disabled. Export STARTUP_FETCH_LOG_PATH=.research-cache/${basename(reportFolder)}/_fetch-log.jsonl in your shell BEFORE any fetch-url call so cited URLs can be audited.`,
      { runId: basename(reportFolder) },
    );
  }
  checkHighConfidenceCorroboration(spec.file, doc, gate);
  checkEnumerationTables(spec.file, doc, gate, plannedTablesByName);
}

// Acknowledged warnings: agent may opt out of --strict warnings by listing
// `acknowledgedWarnings: [{ dimension, reason }]` at the top level of the
// chapter YAML. Each acknowledged dimension must:
//   1. carry at least 30 chars of rationale (schema-enforced),
//   2. name a warning-class dimension from WARNING_DIMENSIONS — failure-class
//      dimensions cannot be acknowledged (SKILL.md is explicit: "Never use
//      this to silence real failures"). Acks against unknown or failure-class
//      dimensions surface as a non-blocking warning so agents catch the
//      misuse without breaking historical reports. Malformed entries
//      (missing fields or short reason) also warn rather than silently
//      drop, otherwise an agent could think a warning was acknowledged
//      when the ack never took effect.
const acks = Array.isArray(doc?.acknowledgedWarnings) ? doc.acknowledgedWarnings : [];
const ackByDim = new Map();
for (const [ackIndex, ack] of acks.entries()) {
  if (typeof ack?.dimension !== 'string' || ack.dimension.trim().length === 0) {
    warn(
      'acknowledgedWarnings',
      `acknowledgedWarnings[${ackIndex}] is missing a non-empty dimension string; the entry has no effect. Remove it or fill in dimension.`,
      { ackIndex },
    );
    continue;
  }
  if (typeof ack?.reason !== 'string' || ack.reason.trim().length < 30) {
    warn(
      'acknowledgedWarnings',
      `acknowledgedWarnings entry for dimension "${ack.dimension}" has reason of ${ack?.reason?.trim?.().length ?? 0} chars (need >= 30); the entry has no effect. Lengthen the reason or remove the entry.`,
      { ackDimension: ack.dimension, reasonLength: ack?.reason?.trim?.().length ?? 0 },
    );
    continue;
  }
  if (!WARNING_DIMENSIONS.has(ack.dimension)) {
    if (!KNOWN_DIMENSIONS.has(ack.dimension)) {
      warn(
        'acknowledgedWarnings',
        `acknowledgedWarnings entry targets dimension "${ack.dimension}", which is not a recognized validator dimension (likely a typo). Allowed warning-class dimensions are: ${[...WARNING_DIMENSIONS].sort().join(', ')}. Either correct the dimension name or remove the entry.`,
        { ackDimension: ack.dimension, reason: 'unknown' },
      );
    } else {
      warn(
        'acknowledgedWarnings',
        `acknowledgedWarnings entry targets dimension "${ack.dimension}", which is not a warning-class dimension; allowed dimensions are: ${[...WARNING_DIMENSIONS].sort().join(', ')}. Remove the entry or rewrite the chapter so the underlying failure clears on its own.`,
        { ackDimension: ack.dimension, reason: 'failure-class' },
      );
    }
    continue;
  }
  ackByDim.set(ack.dimension, ack);
}
const unackedWarningDims = [...new Set(warnings.map((w) => w.dimension))].filter((d) => !ackByDim.has(d));

const ok = failures.length === 0 && (!args.strict || unackedWarningDims.length === 0);

function sortByPrecedence(dimensions) {
  const rank = new Map(RETRY_PRECEDENCE.map((d, i) => [d, i]));
  return [...dimensions].sort((a, b) => (rank.get(a) ?? 999) - (rank.get(b) ?? 999));
}

// Apply CASCADE_SUPPRESSORS: when an upstream "root cause" dimension fired,
// drop downstream failures it would have caused (e.g. localEvidenceMissing
// makes every source/claim check fail trivially). Returns the trimmed list
// plus the set of dimensions that were suppressed (surfaced in the report
// so the agent knows what to expect after the root cause is fixed).
function applyCascadeSuppression(allFailures) {
  const firedDims = new Set(allFailures.map((entry) => entry.dimension));
  const suppressed = new Set();
  for (const upstream of Object.keys(CASCADE_SUPPRESSORS)) {
    if (!firedDims.has(upstream)) continue;
    for (const downstream of CASCADE_SUPPRESSORS[upstream]) {
      if (firedDims.has(downstream)) suppressed.add(downstream);
    }
  }
  if (suppressed.size === 0) return { failures: allFailures, suppressed: [] };
  return {
    failures: allFailures.filter((entry) => !suppressed.has(entry.dimension)),
    suppressed: [...suppressed],
  };
}

// Group failures by the object they touch (table id, figure id, claim id,
// question id, source id) so the agent sees "table T102 has 2 problems"
// instead of two unrelated entries. Failures without an object id are kept
// out of this grouping; they show up only in failures[]/failedDimensions[].
function aggregateByObject(failureList) {
  const buckets = new Map();
  for (const entry of failureList) {
    const objectId = entry.tableId
      || entry.figureId
      || entry.claimId
      || entry.id  // research questions, sources
      || null;
    if (!objectId) continue;
    if (!buckets.has(objectId)) buckets.set(objectId, { objectId, dimensions: [], fixes: [], messages: [] });
    const bucket = buckets.get(objectId);
    if (!bucket.dimensions.includes(entry.dimension)) bucket.dimensions.push(entry.dimension);
    if (entry.fix && !bucket.fixes.includes(entry.fix)) bucket.fixes.push(entry.fix);
    bucket.messages.push(entry.message);
  }
  // Stable order: most-broken objects first.
  return [...buckets.values()].sort((a, b) => b.dimensions.length - a.dimensions.length);
}

// When the same dimension fails on >=3 distinct objects, surface a single
// "global" hint at the top so the agent fixes the chapter-wide gap instead
// of patching each object one at a time.
function detectGlobalHints(failureList) {
  const dimToObjects = new Map();
  for (const entry of failureList) {
    const objectId = entry.tableId || entry.figureId || entry.claimId || entry.id || null;
    if (!objectId) continue;
    if (!dimToObjects.has(entry.dimension)) dimToObjects.set(entry.dimension, new Set());
    dimToObjects.get(entry.dimension).add(objectId);
  }
  const hints = [];
  for (const [dimension, objects] of dimToObjects) {
    if (objects.size >= 3) {
      // resolveFixHint() unwraps function-form FIX_HINTS to a string; pulling
      // FIX_HINTS[dimension] directly leaked the function source through the
      // compact format and silently dropped it from --format json (because
      // JSON.stringify drops functions).
      hints.push({
        dimension,
        affectedObjects: [...objects],
        fix: resolveFixHint(dimension, {}) ?? null,
        note: `${objects.size} distinct objects fail this dimension; treat as a chapter-wide gap rather than per-object patches.`,
      });
    }
  }
  return hints;
}

// Apply suppression once and reuse the trimmed list for both formats. The
// raw failures (pre-suppression) are still surfaced so the agent can audit
// what was hidden.
const { failures: visibleFailures, suppressed: suppressedDimensions } = applyCascadeSuppression(failures);
const objectFailures = aggregateByObject(visibleFailures);
const globalHints = detectGlobalHints(visibleFailures);
const failedDimensions = [...new Set(visibleFailures.map((entry) => entry.dimension))];
const retryOrder = sortByPrecedence(failedDimensions);

if (args.format === 'json') {
  // Wrap in the shared validation envelope so agents can parse JSON output
  // from every check-* validator with one schema. Each check-chapter "failure"
  // becomes an issue with its file path under `path` and dimension/fix/extras
  // preserved via spread.
  const issues = visibleFailures.map(({ file, message, dimension, fix, ...extra }) => ({
    path: file,
    message,
    dimension,
    code: dimension,
    fix,
    ...extra,
  }));
  const warningEntries = warnings.map(({ file, message, dimension, fix, ...extra }) => ({
    path: file,
    message,
    dimension,
    code: dimension,
    fix,
    ...extra,
  }));
  const envelope = validationEnvelope({
    ok,
    validator: 'check-chapter',
    artifact: spec.file,
    reportFolder,
    issues,
    warnings: warningEntries,
    counts,
    objectFailures,
    globalHints,
    retryOrder,
    suppressedDimensions,
    summary: {
      chapterKey: spec.key,
      strict: args.strict,
      failedDimensions,
      warningDimensions: [...new Set(warnings.map((entry) => entry.dimension))],
      acknowledgedWarnings: [...ackByDim.keys()],
      unackedWarningDimensions: unackedWarningDims,
    },
  });
  console.log(JSON.stringify(envelope, null, 2));
} else if (args.format === 'compact') {
  // Single-stream, lossless line format. Callers should keep the full output
  // and process exit code intact instead of piping through preview/filter tools
  // that truncate messages or drop the `fix` field. Lines are emitted in this
  // fixed order; absent sections print no lines (no empty headers).
  //   STATUS: OK | FAIL
  //   chapter: <file>  strict=<yes|no>
  //   counts: sections=N tables=N figures=N localSources=N localClaims=N researchQuestions=N gaps=N
  //   failedDimensions: dim1,dim2,...   (omitted when none)
  //   retryOrder: dim2,dim1,...         (root-cause sorted; omitted when none)
  //   warningDimensions: dimW1,...      (omitted when none)
  //   suppressed: dimS1,...             (omitted when none)
  //   GLOBAL [dim] N objects fail; <note> | fix: <text>     (one per hint)
  //   FAIL [dim] <full message> | fix: <full fix or "">     (one per failure)
  //   WARN [dim] <full message>                              (one per warning)
  const lines = [];
  lines.push(`STATUS: ${ok ? 'OK' : 'FAIL'}`);
  lines.push(`chapter: ${spec.file}  strict=${args.strict ? 'yes' : 'no'}`);
  if (counts) {
    lines.push(`counts: sections=${counts.sections} tables=${counts.tables} figures=${counts.figures} localSources=${counts.sources} localClaims=${counts.claims} researchQuestions=${counts.researchQuestions} gaps=${counts.gaps}`);
  }
  if (failedDimensions.length) lines.push(`failedDimensions: ${failedDimensions.join(',')}`);
  if (retryOrder.length) lines.push(`retryOrder: ${retryOrder.join(',')}`);
  const warningDimensions = [...new Set(warnings.map((entry) => entry.dimension))];
  if (warningDimensions.length) lines.push(`warningDimensions: ${warningDimensions.join(',')}`);
  if (suppressedDimensions.length) lines.push(`suppressed: ${suppressedDimensions.join(',')}`);
  for (const hint of globalHints) {
    lines.push(`GLOBAL [${hint.dimension}] ${hint.note}${hint.fix ? ` | fix: ${hint.fix}` : ''}`);
  }
  for (const entry of visibleFailures) {
    lines.push(`FAIL [${entry.dimension}] ${entry.message}${entry.fix ? ` | fix: ${entry.fix}` : ''}`);
  }
  for (const entry of warnings) {
    lines.push(`WARN [${entry.dimension}] ${entry.message}`);
  }
  console.log(lines.join('\n'));
} else {
  if (counts) {
    console.log(`[check:chapter] reportFolder=${reportFolder}`);
    console.log(`[check:chapter] artifact=${spec.file} strict=${args.strict ? 'yes' : 'no'}`);
    console.log(`[check:chapter] sections=${counts.sections} tables=${counts.tables} figures=${counts.figures} localSources=${counts.sources} localClaims=${counts.claims} researchQuestions=${counts.researchQuestions} gaps=${counts.gaps}`);
  }
  if (globalHints.length) {
    console.error('[check:chapter] global hints (chapter-wide root causes):\n' + globalHints.map((hint) => `  - [${hint.dimension}] ${hint.note} fix: ${hint.fix ?? ''}`).join('\n'));
  }
  if (warnings.length) {
    console.warn('[check:chapter] warnings:\n' + warnings.map((entry) => `  - [${entry.dimension}] ${entry.message}`).join('\n'));
  }
  if (visibleFailures.length) {
    console.error('[check:chapter] failures:\n' + visibleFailures.map((entry) => `  - [${entry.dimension}] ${entry.message}${entry.fix ? `\n      fix: ${entry.fix}` : ''}`).join('\n'));
  }
  if (suppressedDimensions.length) {
    console.error(`[check:chapter] suppressed cascaded dimensions (re-run after fixing root cause): ${suppressedDimensions.join(', ')}`);
  }
  if (ok) console.log('[check:chapter] ✓ chapter ready for next workflow stage.');
}

process.exit(ok ? EXIT.ok : EXIT.failure);
