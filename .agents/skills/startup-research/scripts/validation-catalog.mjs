// Single source of truth for the report-v2 vocabularies, the check-chapter
// failure dimensions, and the cross-script bookkeeping that ties them
// together (FIX_HINTS, RETRY_PRECEDENCE, CASCADE_SUPPRESSORS).
//
// Three consumer roles:
//   - artifact-checks.mjs imports the field-level enum Sets to validate
//     individual sources, claims, callouts, and enumeration tables.
//   - check-chapter.mjs imports the same enum Sets plus the FIX_HINTS table
//     and the precedence/suppressor metadata to drive its retry loop.
//   - build-rules-doc.mjs imports `dimensionCatalog()` and projects the retry
//     catalog into references/rules.md; enum vocabularies are projected into
//     references/contracts.md next to the fields that use them via the
//     `.describe()` annotations on the Zod schemas (no aggregate VOCABULARIES
//     bundle is exported because nothing consumes it programmatically).
//
// Add a new enum or dimension here exactly once; every consumer reads from
// this file.

import { INLINE_CLAIM_REF_SOURCE } from '../../../../website/src/lib/claim-refs.mjs';

// ---------------------------------------------------------------------------
// Field-level vocabularies
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = new Set([
  'official', 'filing', 'regulatory', 'news', 'analyst-market-data',
  'technical-docs', 'customer-proof', 'partner-proof', 'developer-signal',
  'review', 'legal', 'other',
]);
export const SOURCE_STANCES = new Set(['confirming', 'adverse', 'neutral', 'unknown']);
export const SOURCE_ACCESS_STATUSES = new Set(['ok', 'paywall', 'js-only', 'broken', 'rate-limited']);
export const SOURCE_REPUTATION_TIERS = new Set(['high', 'medium', 'low']);
export const SOURCE_INDEPENDENCE = new Set(['company', 'partner', 'customer', 'competitor', 'independent', 'unknown']);

export const CLAIM_TYPES = new Set([
  'observed', 'company-claimed', 'third-party-reported',
  'estimated', 'inferred', 'open-question', 'conflicting',
]);
export const CLAIM_CONFIDENCES = new Set(['high', 'medium', 'low']);
export const CLAIM_FRESHNESS = new Set(['current', 'recent', 'historical', 'unknown']);

export const QUESTION_TYPES = new Set([
  'enumeration', 'quantification', 'verification', 'adverse', 'freshness', 'comparison', 'mechanism',
]);
export const QUESTION_STATUSES = new Set(['answered', 'partial', 'unresolved']);

export const CALLOUT_TYPES = new Set(['strength', 'risk', 'recommendation', 'insight', 'assumption']);
export const ENUMERATION_COVERAGE = new Set(['exhaustive', 'partial', 'sample']);
export const EVIDENCE_GAP_TYPES = new Set(['missing-source', 'conflicting-data', 'private-evidence-only', 'enumeration-incomplete', 'stale', 'access-blocked']);
export const EVIDENCE_GAP_SEVERITIES = new Set(['blocking', 'material', 'minor']);
export const EVIDENCE_QUALITIES = new Set(['high', 'medium', 'low', 'unknown']);
export const TONE_VALUES = new Set(['positive', 'neutral', 'warning', 'negative', 'low', 'medium', 'high', 'critical', 'risk', 'opportunity', 'adverse']);
export const BLOCK_TYPES = new Set(['paragraph', 'callout', 'table', 'figure', 'list', 'equation']);

// Derived classifications (not a single field's enum, but used by checks).
// PRIMARY_TIER_TYPES qualifies a source as "primary tier" for high-confidence
// corroboration. RESTRICTED_ACCESS_STATUSES is the cascade-noise complement
// of accessStatus=ok.
export const PRIMARY_TIER_TYPES = new Set(['filing', 'regulatory', 'legal', 'official']);
export const RESTRICTED_ACCESS_STATUSES = new Set(['paywall', 'js-only', 'broken', 'rate-limited']);

// Summary-card (report-meta.yaml) enums — same pattern as chapter-level vocab,
// so they appear in the runtime context for agent visibility.
export const CARD_RECOMMENDATIONS = new Set(['strong-buy', 'buy', 'track', 'research-more', 'avoid']);
export const CARD_CONFIDENCES = new Set(['high', 'medium', 'low']);
export const CARD_RISK_RATINGS = new Set(['low', 'medium', 'high', 'critical', 'unknown']);
export const CARD_VALUATION_STANCES = new Set(['attractive', 'fair', 'stretched', 'expensive', 'unknown']);

// ---------------------------------------------------------------------------
// ID pattern matching
// ---------------------------------------------------------------------------

// Entity ID patterns. Each ID encodes (Type, ChapterLetter, Sequence) so that
// chapters can generate IDs independently (no global renumbering needed) and
// every reference is human-traceable to its origin chapter.
//
// Format: <Type><ChapterLetter><Seq3>
//   Type:           S (Source) | C (Claim) | T (Table) | F (Figure) | Q (Question)
//   ChapterLetter:  Single uppercase letter declared in workflow-config.yaml `letter:` field.
//                   Reserved type letters (S, C, T, F, Q) cannot be used.
//   Seq3:           Zero-padded 3-digit sequence within the chapter (001..999).
//
// Examples: SA001 (source #1 in chapter A), CB045 (claim #45 in chapter B),
// TC008 (table #8 in chapter C), FD002 (figure #2 in chapter D),
// QE003 (question #3 in chapter E).
export const ID_PATTERN_SOURCE = /^S[A-Z]\d{3}$/;
export const ID_PATTERN_CLAIM = /^C[A-Z]\d{3}$/;
export const ID_PATTERN_FIGURE = /^F[A-Z]\d{3}$/;
export const ID_PATTERN_TABLE = /^T[A-Z]\d{3}$/;

// Inline claim-ref pattern used in section bodies, list items, table cells,
// and callout text. Capture group 1 is the bare claim id without brackets.
// Source string lives in website/src/lib/claim-refs.mjs so the renderer and
// the validators share one regex; if the claim-id format changes, both sides
// update from one file.
export const INLINE_CLAIM_REF_PATTERN = new RegExp(INLINE_CLAIM_REF_SOURCE, 'g');

// Type letters that are reserved as ID prefixes; chapter letters cannot use
// these to avoid visual ambiguity in compact IDs (e.g. "CC001" would parse
// as Claim/Chapter-C/#1 — technically unambiguous but confusing).
export const RESERVED_TYPE_LETTERS = new Set(['S', 'C', 'T', 'F', 'Q']);

// Build a regex that matches one specific (typeLetter, chapterLetter)
// combination, e.g. /^SO\d{3}$/. Used by check-chapter to enforce that every
// id in a chapter file carries the chapter's own letter (so an id from
// another chapter cannot accidentally pass the generic format check).
export function makeIdPattern(typeLetter, chapterLetter) {
  if (!/^[SCTFQ]$/.test(typeLetter)) throw new Error(`makeIdPattern: invalid type letter "${typeLetter}"`);
  if (!/^[A-Z]$/.test(chapterLetter)) throw new Error(`makeIdPattern: invalid chapter letter "${chapterLetter}"`);
  return new RegExp(`^${typeLetter}${chapterLetter}\\d{3}$`);
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// Format an enum Set/array as a pipe-separated string for error messages.
// Usage: formatEnumChoices(SOURCE_TYPES) → "filing|legal|official|..."
export function formatEnumChoices(enumSet) {
  return [...enumSet].join('|');
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

// Source freshness classification thresholds (in months from anchor date).
// Baked here so build-evidence-ledger.mjs, load-chapter-runtime-context, and agent all see the same
// policy. These represent maximum age for classification: if a source is
// within N months of the anchor date, it counts as current/recent.
export const FRESHNESS_THRESHOLDS = {
  current: 24,   // current: ≤24 months
  recent: 60,    // recent: ≤60 months; ≥24 → historical
};

// Title tokenization stop words: ignored when comparing table/figure titles
// to detect cross-artifact and cross-chapter duplicates. Shared by
// check-chapter.mjs (per-chapter duplicateAnalysis) and
// check-cross-chapter.mjs (report-level cross-chapter duplicates).
export const TITLE_TOKEN_STOP_WORDS = new Set([
  'table', 'figure', 'fig', 'chart', 'graph', 'matrix', 'map',
  'kpi', 'kpis', 'scorecard', 'analysis', 'overview', 'summary',
]);

// Minimum token length for title tokenization. Tokens shorter than this are
// ignored during duplicate detection and similarity comparisons. Shared by
// check-chapter.mjs and check-cross-chapter.mjs.
export const MIN_TITLE_TOKEN_LENGTH = 4;

// Single source of truth for title/structure token normalization. Lowercase,
// split on non-alphanumeric, drop short and stop-word tokens. Used for
// duplicate-artifact detection (per-chapter duplicateAnalysis and the
// cross-chapter duplicateAnalysisCrossChapter check) so the two validators
// can never silently drift apart.
export function tokenizeTitle(value) {
  return new Set(String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TITLE_TOKEN_LENGTH && !TITLE_TOKEN_STOP_WORDS.has(token)));
}

// Jaccard similarity over two pre-tokenized Sets (Set<string>). Returns 0
// for empty inputs so partial-data callers don't have to special-case.
// Pairs with tokenizeTitle(); pre-tokenizing avoids re-splitting strings
// in O(n^2) similarity loops.
export function jaccardTokenSimilarity(setA, setB) {
  if (!setA?.size || !setB?.size) return 0;
  const intersection = [...setA].filter((token) => setB.has(token)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// Evidence quality tier thresholds. Used by build-evidence-ledger.mjs to classify the
// overall quality of consolidated evidence based on source diversity,
// reputation distribution, and claim corroboration patterns.
export const EVIDENCE_QUALITY_TIERS = {
  high: {
    minSources: 30,
    minClaims: 50,
    minIndependentShare: 0.2,
    minHighReputationShare: 0.35,
    minMultiSourceShare: 0.2,
  },
  medium: {
    minSources: 10,
    minClaims: 20,
    minIndependentShare: 0.1,
    minHighReputationShare: 0.25,
    requireBoth: false, // true=AND, false=OR
  },
};

// Registrable domain extraction: maximum number of domain parts to keep
// when parsing URLs. For example, www.example.co.uk has 4 parts; with
// maxParts=2, returns example.co.uk (handles multi-part TLDs).
export const REGISTRABLE_DOMAIN_MAX_PARTS = 2;

// Multi-part TLDs that don't fit the typical 2-level domain pattern.
// Used by registrableDomain() in utils.mjs and normalizedDomain() in build-evidence-ledger.mjs
// to correctly extract the registrable domain for diverse gTLDs.
export const MULTI_PART_TLDS = new Set(['co.uk', 'co.jp', 'com.cn', 'com.hk', 'com.au', 'com.br', 'gov.uk', 'gov.cn']);

// Key-fact pattern matching: regex patterns that identify identity facts
// (founders, founding date, funding, valuation, headcount, customers) in
// claim statements. Used by check-cross-chapter.mjs keyFactDrift check to ensure
// these canonical facts reference company-overview claims instead of being
// duplicated in later chapters.
export const KEY_FACT_TOPICS = [
  /founded|founding date|incorporation/,
  /founder|cofounder|co-founder/,
  /headquarter|hq location|principal office/,
  /total raised|cumulative funding|capital raised/,
  /latest valuation|post-money valuation|secondary valuation/,
  /headcount|employees|fte|full[- ]?time/,
  /customer count|paid customers|paying users/,
];

// Paywall risk warning buffer. The chapter-level early-warning threshold is
// derived from the report-level ceiling (`reportGate.maxPaywallPercent` in
// workflow-config.yaml) minus this buffer, so the warning fires before
// chapters aggregate to a level that would breach the report ceiling.
// Used by paywallWarningThreshold() below.
export const PAYWALL_RISK_WARNING_BUFFER = 0.05;

// Derive the chapter-level paywall warning threshold from the authoritative
// report-level ceiling. Single source of truth: workflow-config.yaml
// `reportGate.maxPaywallPercent`. Floors at 0 so a misconfigured
// reportCeiling <= buffer doesn't yield a negative threshold (which would
// fire the warning on every chapter).
export function paywallWarningThreshold(reportCeiling) {
  const ceiling = Number.isFinite(reportCeiling) ? reportCeiling : 0.3;
  return Math.max(0, ceiling - PAYWALL_RISK_WARNING_BUFFER);
}

// Duplicate title similarity threshold. When a figure's and table's
// normalized titles have Jaccard overlap >= this value, and the figure's
// claimRefs are a subset of the table's, duplicateAnalysis check fires.
// Used by check-chapter.mjs checkDuplicateAnalysis().
export const DUPLICATE_TITLE_THRESHOLD = 0.5;

// Warning-class dimensions that may legitimately appear in
// `acknowledgedWarnings[].dimension`. Only these are non-blocking by design:
// agents may opt out of them in --strict mode with a 30+ char rationale.
// Failure-class dimensions are excluded; SKILL.md is explicit that
// acknowledgedWarnings must never be used to silence real failures, and
// check-chapter emits a non-blocking `acknowledgedWarnings` warning when an
// ack targets a failure dimension. Adding any dimension here makes it acknowledgeable; verify the underlying check is
// emitted via warn() in check-chapter.mjs (or strict-promoted there) before
// extending the set.
export const WARNING_DIMENSIONS = new Set([
  'paywallRisk',
  'sectionsMax',
  'tablesMax',
  'figuresMax',
  'figureType',
  'tableNotes',
  'unsectionedExhibits',
  'unverifiedSource',
  'fetchTrailMissing',
]);

// Derived once for messaging consistency. Sorted so the printed order is
// stable across reports and any new warning-class dimension shows up
// automatically wherever this list is referenced.
const WARNING_DIMENSIONS_LIST_TEXT = [...WARNING_DIMENSIONS].sort().join(', ');

// ---------------------------------------------------------------------------
// Per-dimension fix hints
// ---------------------------------------------------------------------------
//
// Per-dimension one-line action hints. Same data the SKILL.md retry table
// expressed in prose; baking it into each failure removes the agent's need
// to cross-reference SKILL.md when triaging. Keep entries action-oriented
// and short (<= 120 chars). Add a new entry whenever you add a new
// dimension.
//
// Each entry is `string | (extra) => string`. Functions receive the full
// `extra` object passed to `fail(dim, msg, extra)` (e.g. `{ actual,
// required, id, tableId }`) so they can echo the concrete fix value back at
// the agent ("Set slug: to \"revolut\".") instead of the agent re-deriving
// it from the surrounding message.
export const FIX_HINTS = {
  missingArtifact: 'Create the chapter YAML at the expected path.',
  missingChapter: ({ chapter } = {}) =>
    chapter ? `Author the missing chapter file ${chapter} (run check-chapter on it once it exists).` : 'Author the missing chapter file flagged in the message before re-running finalize.',
  yamlParse: 'Fix the YAML syntax error reported in the message.',
  localEvidenceMissing: 'Add the entire localEvidence block (researchQuestions, searchQueries, sources, claims, evidenceGaps).',
  researchQuestionShape: ({ id, actual } = {}) =>
    actual !== undefined
      ? `Fix ${id ?? 'the question'}: invalid value "${actual}". Use a value from the allowed enum shown in the message.`
      : 'Fix the question object: id Q<ChapterLetter>### (e.g. QO001), >=20-char text, valid type, non-empty targets[], valid status.',
  researchQuestionTargets: ({ id } = {}) =>
    `Point ${id ?? 'the question'}.targets[] entries at a real contentRequirements/<index>, plannedTables/<slug>, or plannedFigures/<slug>.`,
  researchQuestionTypeMix: ({ actual, required } = {}) =>
    required != null ? `Add questions of types you have not used yet so distinct types reach ${required} (currently ${actual}).` : 'Add questions of types you have not used yet to reach minQuestionTypeSpread.',
  researchQuestionAdverse: ({ actual, required } = {}) =>
    required != null ? `Add ${Math.max(required - (actual ?? 0), 1)} more type:adverse question(s) (currently ${actual}, need ${required}).` : 'Add type:adverse questions until you reach minAdverseQuestions.',
  researchQuestionAnswerCoverage: ({ actual, required } = {}) =>
    required != null ? `Raise answered/total ratio to ${required} (currently ${Number(actual).toFixed(2)}) by answering more questions or removing speculative ones.` : 'Convert questions from unresolved/partial to answered by adding the missing claim and citing it via claim.answersQuestionRefs.',
  researchQuestionClosure: ({ id } = {}) =>
    `Add an evidenceGap whose relatedQuestionRefs[] includes ${id ?? 'the still-open question'}.`,
  searchQueriesMissing: 'Append the actual queries you ran into localEvidence.searchQueries[] ({query, engine, hits, retainedSourceRefs}).',
  searchQueryFreshness: ({ query, runYear, trailingYear, hasTrailingYear, matchedToken } = {}) => {
    if (!query || !runYear) {
      return 'For volatile-fact queries (funding/ARR/headcount/customers/leadership/regulatory/launches), plan source discovery with year/month tokens derived from runDate before searching; the runDate year is required and the prior year may only supplement explicit trailing-window searches. The searchQueryFreshness validator fails stale query logs and cannot be acknowledged away.';
    }
    const currentExample = `"${query} ${runYear}"`;
    const trailingExample = hasTrailingYear ? `keep the existing ${trailingYear} token and add ${runYear}` : `"${query} ${trailingYear} ${runYear}"`;
    return `Re-plan and re-issue the source-discovery query with date tokens derived from runDate: ${currentExample}; for trailing windows, ${trailingExample}. The volatile-fact token "${matchedToken}" triggered this check; the runDate year ${runYear} is required, while ${trailingYear} is only an optional trailing-window supplement. If the query is genuinely historical, rephrase it so it no longer matches a volatile-fact token. This is a hard gate and cannot be acknowledged away.`;
  },
  sourceShape: ({ id } = {}) =>
    id ? `Fill the missing required field on source ${id} (see message for which one).` : 'Fill accessStatus and stance (and other required fields) on each source.',
  sourceDomains: ({ actual, required } = {}) =>
    required != null ? `Add sources from ${Math.max(required - (actual ?? 0), 1)} more registrable domain(s) (currently ${actual}, need ${required}). Same dimension also fires at report scope from check-report when totalDistinctDomains across the entire ledger falls below reportGate.minDistinctDomains; add new domains in any chapter, not necessarily the one being checked.` : 'Add sources from new registrable domains; do not duplicate publishers. Same dimension also fires at report scope (check-report) against reportGate.minDistinctDomains across the consolidated ledger.',
  sourceTypeSpread: ({ actual, required } = {}) =>
    required != null ? `Add sources with ${Math.max(required - (actual ?? 0), 1)} more sourceType value(s) you have not used yet (currently ${actual}, need ${required}).` : 'Add sources with sourceType values you have not used yet.',
  sourceStanceSpread: ({ actual, required } = {}) =>
    required != null ? `Add ${Math.max(required - (actual ?? 0), 1)} more stance:adverse source(s) (currently ${actual}, need ${required}). Mark a regulator complaint, short report, FT Alphaville-style critique, FOS/CFPB filing, or skeptical analyst note as stance: adverse — do not invent sources. Same dimension also fires at report scope from check-report when no chapter contributes an adverse-stance source; the risks chapter is the canonical owner.` : 'Add at least one source with stance: adverse (regulator complaint, short report, skeptical analyst note, FT Alphaville-style critique, FOS/CFPB record). Mark a genuinely critical existing source as stance: adverse instead of inventing one. Same dimension also fires at report scope (check-report) when the entire report has no adverse-stance source; the risks chapter is the canonical owner.',
  sourceIndependence: 'At report scope, replace company-authored sources with independent reporting, customer evidence, benchmarks, or regulatory records until both configured source-mix thresholds pass.',
  assignedSourcePool: 'Replace every cross-pool URL with a successful prefetched source from this chapter’s assigned worker pool; sibling reservations are not reusable.',
  requiredSourceTypes: ({ missing } = {}) =>
    missing ? `Pull at least one source with sourceType: ${missing}.` : 'Pull at least one source of each missing type listed in gate.requiredSourceTypes.',
  netNewSources: ({ actual, required } = {}) =>
    required != null ? `Add ${Math.max(required - (actual ?? 0), 1)} more URL(s) not seen in earlier chapters (currently ${actual}, need ${required}).` : 'Run new searches to add URLs not seen in earlier chapters; reusing the global pool will not satisfy this gate.',
  paywallRisk: 'At chapter scope (warning, ack-able): swap restricted (paywall|js-only|broken|rate-limited) sources for ok ones to stay under the report-level 30% ceiling. At report scope (failure from check-report, NOT ack-able): the per-report restricted share already exceeds the 30% ceiling and must be brought back below it before finalize-report can pass.',
  researchQuestions: 'Add more researchQuestion entries until you hit the per-chapter floor.',
  sources: 'Use one source ID per canonical URL. Meet the per-chapter floor with distinct relevant sources, not duplicate IDs or tracking-URL variants.',
  claims: 'Add more claims until you hit the per-chapter floor.',
  highConfidenceCorroboration: ({ claimId, actual, required } = {}) =>
    required != null && actual != null
      ? `On claim ${claimId}: either downgrade confidence:high to medium, or add ${Math.max(required - actual, 1)} more sourceRef(s) including a primary-tier one (filing|regulatory|legal|official or reputationTier:high).`
      : claimId
        ? `On claim ${claimId}: either downgrade confidence:high to medium, or add a primary-tier sourceRef (filing|regulatory|legal|official or reputationTier:high).`
        : 'Either downgrade confidence:high to medium, or ensure the claim has at least gate.minHighConfidenceCorroboration sourceRefs with at least one primary-tier source (filing|regulatory|legal|official or reputationTier:high).',
  claimAnswerRefs: ({ claimId, ref } = {}) =>
    claimId ? `On claim ${claimId}: remove answersQuestionRefs entry ${ref ?? ''}, or add the missing Q<ChapterLetter>### locally.` : 'Resolve dangling answersQuestionRefs entries; do not duplicate evidence.',
  claimContradictRefs: ({ claimId, ref } = {}) =>
    claimId ? `On claim ${claimId}: remove contradictsClaimRefs entry ${ref ?? ''}, or add the missing C<ChapterLetter>### locally (type:conflicting requires non-empty contradictsClaimRefs).` : 'Resolve dangling contradictsClaimRefs entries; type:conflicting requires non-empty contradictsClaimRefs.',
  claimRefs: ({ unresolvedRef } = {}) =>
    unresolvedRef ? `Resolve claimRef ${unresolvedRef}: it is not in this chapter's localEvidence.claims[]. Either remove the ref, or add a localEvidence.claims entry with that id and real sourceRefs.` : 'Resolve dangling claimRefs across sections, tables, figures, and callouts.',
  crossChapterRefLeak: ({ unresolvedRef, foundIn } = {}) =>
    unresolvedRef && foundIn
      ? `Local ${unresolvedRef} is defined in ${foundIn}, NOT in this chapter. S/C/T/F/Q ids carry the owning chapter's letter (e.g. CO045 = chapter O claim 45) and cannot be reused outside that chapter. Restate the fact as a new local claim here (with this chapter's letter), give it its own sourceRefs[], and reference that new id. Ledger consolidation will dedupe equivalent claims at the end.`
      : `Local ${unresolvedRef ?? 'C<L>###'} appears to come from another chapter. Chapter-letter ids cannot be reused across chapters — restate the underlying fact as a new local claim here with its own sourceRefs[].`,
  enumerationScope: ({ tableId, actual } = {}) =>
    actual !== undefined
      ? `On table ${tableId}: enumerationScope.coverage "${actual}" invalid; use exhaustive | partial | sample.`
      : tableId
        ? `Add enumerationScope { coverage: exhaustive|partial|sample, basis: "..." (>=20 chars) } to table ${tableId}.`
        : 'Add enumerationScope { coverage, basis(>=20 chars) } to the matching enumeration table.',
  enumerationRows: ({ tableId, actual, required } = {}) =>
    required != null ? `On table ${tableId}: add ${Math.max(required - (actual ?? 0), 1)} more rows (currently ${actual}, need ${required}) or set enumerationScope.coverage to partial/sample with rationale.` : 'Add rows to reach expectedMinRows or set coverage to partial/sample with rationale.',
  enumerationCoverageGap: ({ tableId } = {}) =>
    tableId ? `Open an evidenceGap whose topic mentions ${tableId} or whose relatedTableRefs[] includes ${tableId}.` : 'Open an evidenceGap whose topic mentions the table or whose relatedTableRefs[] cites it.',
  enumerationTableCorroboration: ({ tableId, actual, required } = {}) =>
    required != null ? `On table ${tableId}: extend the table's claimRefs[] so the underlying sources span ${Math.max(required - (actual ?? 0), 1)} more registrable domain(s) (currently ${actual}, need ${required}). Check is table-level (claimRefs live on the table, not per row).` : "Extend the enumeration table's table-level claimRefs[] so the underlying sources span more registrable domains (table-level, not per-row).",
  claimShape: ({ id } = {}) =>
    id ? `Fix claim ${id}: required fields (statement, type, topic, sourceRefs, confidence, freshness), valid enum values, non-empty sourceRefs unless type is open-question, and contradictsClaimRefs when type is conflicting.` : 'Fix the claim object: required fields (statement, type, topic, sourceRefs, confidence, freshness), valid enum values, non-empty sourceRefs unless type is open-question, and contradictsClaimRefs when type is conflicting.',
  calloutShape: 'Fix the callout: required title, body, claimRefs[], and optional calloutType in (strength|risk|recommendation|insight|assumption).',
  tableShape: ({ tableId } = {}) =>
    tableId ? `Fix table ${tableId}: non-empty columns, every row has the same number of cells as columns, enumerationScope { coverage, basis(>=20 chars) } when present.` : 'Fix the table: non-empty columns, every row has the same number of cells as columns, enumerationScope { coverage, basis(>=20 chars) } when present.',
  tableNotes: ({ tableId } = {}) =>
    tableId ? `On table ${tableId}: write a one-line notes string covering data source / estimation / partial coverage / what null means. If the table is a pure factual snapshot with no caveat, add an acknowledgedWarnings entry for dimension "tableNotes".` : 'Write tables[].notes (one line: data source / estimation / partial coverage / what null means), or acknowledge dimension "tableNotes" for pure factual snapshot tables.',
  documentHead: 'Fix the chapter document head: schemaVersion=report-v2, artifact matches the chapter key, slug, runDate=YYYY-MM-DD, company.name, and chapter.number matching the chapter order.',
  slugConsistency: ({ required } = {}) =>
    required ? `Set slug: to "${required}".` : 'Set slug: to the company slug only (the report folder basename with the leading <timestamp>- stripped).',
  runDateConsistency: ({ required, actual } = {}) =>
    required ? `Set runDate: to "${required}" (UTC YYYY-MM-DD derived from the report folder runId timestamp prefix; got "${actual ?? ''}"). Use runtimeContext.run.runDate from load-chapter-runtime-context.mjs --report-folder; never format a date from the model clock.` : 'Set runDate: to the UTC YYYY-MM-DD derived from the report folder runId timestamp prefix (use runtimeContext.run.runDate from the chapter-runtime-context loader; never format a date from the model clock).',
  duplicateIds: ({ id } = {}) =>
    id ? `Renumber ${id}: ids must match T<ChapterLetter>### / F<ChapterLetter>### (e.g. TO001 / FO001) and be unique within the chapter.` : 'Renumber the duplicate or malformed table/figure id; ids must match T<ChapterLetter>### / F<ChapterLetter>### (e.g. TO001 / FO001) and be unique within the chapter.',
  artifactRefs: "Resolve the dangling figureRef/tableRef: it must point at an id that exists in this chapter's figures[] / tables[].",
  unsectionedExhibits: ({ id, kind } = {}) =>
    id && kind
      ? `${kind} ${id} has no section home: add ${id} to the appropriate section's ${kind === 'table' ? 'tableRefs' : 'figureRefs'}[] (the section whose prose introduces or relies on it). The trailing Exhibits section is a fallback for genuinely cross-cutting artifacts, not the default. Acknowledge dimension "unsectionedExhibits" only when the artifact is intentionally orphaned.`
      : 'Add each table/figure to the section.tableRefs[] / section.figureRefs[] of the section that introduces or relies on it. The trailing Exhibits section is a fallback for cross-cutting artifacts, not the default landing place. Acknowledge dimension "unsectionedExhibits" only when an exhibit is intentionally orphaned.',
  sectionsMin: ({ actual, required } = {}) =>
    required != null ? `Add ${Math.max(required - (actual ?? 0), 1)} more section(s) (currently ${actual}, need ${required}).` : 'Add the missing section(s) to reach minSections.',
  artifactsMin: ({ actual, required } = {}) =>
    required != null ? `Add ${Math.max(required - (actual ?? 0), 1)} more table or figure (currently ${actual}, need ${required}); a planned figure may be substituted with an extra table when data shape does not fit.` : 'Add the missing table or figure (or substitute a planned figure with an extra table when data shape does not fit).',
  depthSection: ({ actual, required } = {}) =>
    required != null ? `Expand the shortest section's body by ~${Math.max(required - (actual ?? 0), 1)} more words (currently ${actual}, need ${required} per section).` : 'Expand the prose of the shortest section(s) only; leave the others untouched.',
  depthSectionTotal: ({ actual, required } = {}) =>
    required != null ? `Expand prose by ~${Math.max(required - (actual ?? 0), 1)} more words across short sections (currently ${actual} total, need ${required}).` : 'Expand prose across short sections to reach minSectionWordsTotal.',
  depthTableRows: ({ actual, required } = {}) =>
    required != null ? `Add ~${Math.max(required - (actual ?? 0), 1)} more rows across existing tables (currently ${actual} total, need ${required}).` : 'Add rows to existing tables to reach minTableRowsTotal.',
  depthFigureData: ({ actual, required } = {}) =>
    required != null ? `Add ~${Math.max(required - (actual ?? 0), 1)} more data points across existing figures (currently ${actual} total, need ${required}).` : 'Add data points to existing figures to reach minFigureDataPointsTotal.',
  contentRequirementCoverage: ({ actual, required } = {}) =>
    required != null ? `Add researchQuestions whose targets[] cover the un-targeted contentRequirements (current coverage ${Number(actual).toFixed(2)}, need ${required}).` : 'Add researchQuestions whose targets[] cover the un-targeted contentRequirements.',
  figureShape: ({ figureId } = {}) =>
    figureId ? `Fix figure ${figureId} data to satisfy its type contract (e.g. dag needs edges, range needs numeric low/high, matrix needs columns and rows).` : 'Fix the figure data to satisfy its type contract (e.g. dag needs edges, range needs numeric low/high, matrix needs columns and rows).',
  duplicateAnalysis: ({ tableId, figureId, sharedRefs, figureRefs } = {}) =>
    tableId && figureId
      ? `Figure ${figureId} re-renders the same claims as table ${tableId} (${sharedRefs}/${figureRefs} of the figure's claimRefs are also on the table). Either give the figure at least one claimRef the table does not have (a distinct slice/lens), rename it to reflect that lens, or merge it into the table.`
      : 'Either give the figure at least one claimRef the table does not have (a distinct slice/lens), rename it to reflect that lens, or merge it into the table.',
  figureType: 'Render at least one of the planned figure types, or add an acknowledgedWarnings entry for dimension "figureType" with a >=30-char reason when the substitution is intentional.',
  sectionsMax: 'Reduce or merge sections; the chapter looks over-fragmented.',
  tablesMax: 'Reduce or merge tables; the chapter looks over-fragmented.',
  figuresMax: 'Reduce or merge figures; the chapter looks over-fragmented.',
  unverifiedSource: ({ id, url } = {}) =>
    id || url
      ? `Source ${id ?? ''}${url ? ` (${url})` : ''} has no successful fetch-url retrieval recorded for this run; retrieve usable content with .agents/skills/fetch-url/scripts/fetch.mjs (or remove the citation if the source cannot be retrieved).`
      : 'One or more cited sources have no successful fetch-url retrieval recorded for this run; retrieve usable content so accessStatus, sourceType, and stance are based on the actual page rather than a failed attempt or a guess.',
  fetchTrailMissing: 'Set STARTUP_FETCH_LOG_PATH=.research-cache/<runId>/_fetch-log.jsonl in your shell BEFORE running fetch-url so check-chapter can audit cited URLs against actual retrievals; the default gate warns and --strict fails when the trail is missing.',
  displayCompleteness: 'Populate the report-meta field that drives the display surface (companyProfile.<field>, coverFacts items, claimRefs); when a field is genuinely unavailable, leave it null only for fields that document a null path. check-report-meta emits this only as a warning and has no acknowledgedWarnings opt-out.',
  metricDrift: ({ metric } = {}) =>
    metric ? `Reconcile metric "${metric}" across chapters: pick the canonical numeric value (usually from the chapter that owns the topic) and update the other chapters' tables/figures/coverFacts to match, or restate them as a clearly different lens (e.g. "Q4 ARR" vs "FY ARR") so they no longer normalize to the same metric label.` : 'Reconcile the conflicting metric values across chapters: pick the canonical numeric value and update the other chapters to match, or restate them as a clearly different lens so they no longer normalize to the same label.',
  metricDriftSmall: ({ metric } = {}) =>
    metric ? `(advisory; non-blocking outside --strict) Metric "${metric}" varies slightly across chapters but stays within tolerance; harmonize the value or document the rounding source so the next refresh does not drift further.` : '(advisory; non-blocking outside --strict) Slight metric drift across chapters within tolerance; harmonize values or document the rounding source.',
  keyFactDrift: ({ canonicalId, claimId } = {}) =>
    canonicalId && claimId ? `Drop the parallel claim ${claimId} and reference the canonical company-overview claim ${canonicalId} instead (mint a local claim that cites the same sources rather than restating the fact).` : 'Reference the canonical company-overview claim instead of restating the key fact as a new local claim.',
  duplicateAnalysisCrossChapter: ({ a, b } = {}) =>
    a && b ? `${a.id ?? '?'} in ${a.chapter} duplicates ${b.id ?? '?'} in ${b.chapter}: merge into the chapter that owns the topic, or sharpen one to answer a distinct question (different lens, different time slice, or different cohort) so titles and structure no longer overlap.` : 'Merge the duplicated artifact into the chapter that owns the topic, or sharpen one to a distinct lens.',
  duplicateLocalClaim: ({ claimId } = {}) =>
    claimId ? `(advisory; non-blocking outside --strict) Local claim id ${claimId} appears in multiple chapter ledgers; remove the duplicate and reference the original via cross-chapter consolidation, or renumber so each chapter ledger owns its own ids.` : '(advisory; non-blocking outside --strict) Remove duplicated local claim ids across chapter ledgers; each chapter has its own C### namespace.',
  reportContract: 'Re-run the upstream assembler the message names (usually build-evidence-ledger.mjs then build-report.mjs) so the consolidated artifact (evidence.yaml.coverageMatrix, summary-card.sourceStats, full-report references) matches the current chapter sources. The dimension fires from check-report against shape contracts the assemblers own — fixing chapters then re-running finalize-report is usually enough.',
  reportMetaShape: 'Edit report-meta.yaml to match the report-meta shape in references/contracts.md (or summary-card.yaml when the message names that file). check-report-meta is the focused validator for this dimension; check-report and build-report also surface it when an assembler refuses to project a malformed field. Run check-report-meta directly with --format json for the per-issue fix.',
  revisionGraph: 'Do NOT hand-edit revision: in report-meta.yaml — link-refresh.mjs (run automatically by finalize-report --refresh in the prepare-refresh and link-refresh steps) writes every revision field on both runs. If the graph is inconsistent, re-run finalize-report.mjs --refresh on the affected report and let link-refresh resync; for one-off cases the message names the exact field (status / refreshOfRunId / supersededByRunId / refreshReason) that is wrong.',
  workflowConfigShape: 'Edit `.agents/skills/startup-research/workflow-config.yaml` to satisfy the schema in `scripts/contracts/workflow-config.schema.mjs` (chapter count, finalArtifacts list, agentPolicy.volatileFacts / volatileFactQueryTokens / finalResponseFields, etc.). This is a meta-validator on the skill’s own config and is repo-maintainer facing — report agents do not author this file.',
  usage: 'Fix the CLI invocation per the message: pass exactly one report folder argument plus the optional flags listed in the script header (e.g. --format text|json|compact, --strict, --refresh).',
  acknowledgedWarnings: ({ ackDimension } = {}) =>
    ackDimension
      ? `acknowledgedWarnings entry targets dimension "${ackDimension}", which is not a warning-class dimension. Only warnings (${WARNING_DIMENSIONS_LIST_TEXT}) may be acknowledged; failures must be fixed. Each acknowledgedWarnings entry also requires a >=30-char reason. Remove the entry or rewrite the chapter so the underlying failure clears on its own.`
      : `Each acknowledgedWarnings entry must (1) target a warning-class dimension (${WARNING_DIMENSIONS_LIST_TEXT}) and (2) carry a >=30-char reason. Failure-class dimensions cannot be acknowledged.`,
};

// Full catalog of dimensions that any validator may emit (warning-class +
// failure-class + cross-chapter + finalize-step). Every entry has a fix
// hint by convention, so FIX_HINTS keys are the source of truth. Used by
// check-chapter to distinguish a typoed dimension in acknowledgedWarnings
// (no such dimension) from a real failure-class dimension (cannot be
// acknowledged) — the two cases need different remediation messages.
export const KNOWN_DIMENSIONS = new Set(Object.keys(FIX_HINTS));

// ---------------------------------------------------------------------------
// Cascade suppressors
// ---------------------------------------------------------------------------
//
// When an upstream dimension fires, every downstream dimension in this set
// is almost always a cascading false positive. Suppressing them keeps retry
// noise down so the agent can fix the root cause first and re-run.
//   yamlParse -> document failed to parse; loadYamlFile returns null and
//   short-circuits the rest of check-chapter, so this entry is mostly
//   defensive (kept so dimensionCatalog() reflects the intent for any
//   future caller that does not short-circuit).
//   localEvidenceMissing -> nothing inside localEvidence is checkable; every
//   source/claim/researchQuestion/enumeration failure is downstream noise.
export const CASCADE_SUPPRESSORS = {
  yamlParse: new Set([
    'documentHead', 'slugConsistency', 'runDateConsistency',
    'researchQuestions', 'researchQuestionShape', 'researchQuestionTargets',
    'researchQuestionTypeMix', 'researchQuestionAdverse',
    'researchQuestionAnswerCoverage', 'researchQuestionClosure',
    'searchQueriesMissing', 'searchQueryFreshness',
    'sources', 'sourceShape', 'sourceDomains', 'sourceTypeSpread',
    'requiredSourceTypes', 'netNewSources', 'paywallRisk',
    'sourceStanceSpread',
    'claims', 'claimShape', 'claimAnswerRefs', 'claimContradictRefs', 'claimRefs',
    'crossChapterRefLeak',
    'highConfidenceCorroboration',
    'enumerationScope', 'enumerationRows', 'enumerationCoverageGap',
    'enumerationTableCorroboration',
    'contentRequirementCoverage',
    'tableShape', 'figureShape', 'duplicateIds', 'artifactRefs', 'unsectionedExhibits',
    'calloutShape', 'duplicateAnalysis', 'figureType',
    'sectionsMin', 'sectionsMax', 'artifactsMin',
    'tablesMax', 'figuresMax',
    'depthSection', 'depthSectionTotal', 'depthTableRows', 'depthFigureData',
  ]),
  localEvidenceMissing: new Set([
    'researchQuestions', 'researchQuestionShape', 'researchQuestionTargets',
    'researchQuestionTypeMix', 'researchQuestionAdverse',
    'researchQuestionAnswerCoverage', 'researchQuestionClosure',
    'searchQueriesMissing', 'searchQueryFreshness',
    'sources', 'sourceShape', 'sourceDomains', 'sourceTypeSpread',
    'requiredSourceTypes', 'netNewSources', 'paywallRisk',
    'sourceStanceSpread',
    'claims', 'claimShape', 'claimAnswerRefs', 'claimContradictRefs', 'claimRefs',
    'crossChapterRefLeak',
    'highConfidenceCorroboration',
    'enumerationScope', 'enumerationRows', 'enumerationCoverageGap',
    'enumerationTableCorroboration',
    'contentRequirementCoverage',
  ]),
  // documentHead suppresses runDateConsistency and the freshness validator
  // because both depend on a parseable doc.runDate; if the head failed,
  // every downstream date check is noise.
  documentHead: new Set([
    'runDateConsistency',
    'searchQueryFreshness',
  ]),
  // runDateConsistency suppresses the freshness validator: searchQueryFreshness
  // checks that volatile-fact queries contain the runDate year as a literal
  // 4-digit token, but if doc.runDate disagrees with the runId-derived
  // canonical date, that comparison runs against the wrong year. Fix runDate
  // first; the freshness check re-emits cleanly afterwards.
  runDateConsistency: new Set([
    'searchQueryFreshness',
  ]),
};

// ---------------------------------------------------------------------------
// Retry precedence
// ---------------------------------------------------------------------------
//
// Causal precedence for retry ordering (root cause first). When multiple
// dimensions fail, fix in this order; downstream dimensions often clear
// once upstream is repaired.
export const RETRY_PRECEDENCE = [
  'missingArtifact', 'yamlParse', 'documentHead', 'slugConsistency', 'runDateConsistency', 'localEvidenceMissing',
  'researchQuestionShape', 'researchQuestionTargets', 'researchQuestionTypeMix', 'researchQuestionAdverse',
  'searchQueriesMissing',
  'sourceShape', 'assignedSourcePool', 'sourceDomains', 'sourceTypeSpread', 'sourceStanceSpread', 'sourceIndependence', 'requiredSourceTypes', 'netNewSources',
  'paywallRisk',
  'researchQuestions', 'sources', 'claims',
  'claimShape',
  'highConfidenceCorroboration',
  'researchQuestionAnswerCoverage', 'researchQuestionClosure',
  'claimAnswerRefs', 'claimContradictRefs', 'crossChapterRefLeak', 'claimRefs',
  'enumerationScope', 'enumerationRows', 'enumerationCoverageGap', 'enumerationTableCorroboration',
  'tableShape', 'figureShape', 'figureType',
  'duplicateIds', 'artifactRefs', 'unsectionedExhibits', 'duplicateAnalysis',
  'calloutShape',
  'sectionsMin', 'sectionsMax', 'artifactsMin', 'tablesMax', 'figuresMax',
  'depthSection', 'depthSectionTotal', 'depthTableRows', 'depthFigureData',
  'contentRequirementCoverage', 'searchQueryFreshness', 'unverifiedSource', 'fetchTrailMissing',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolves a fix hint to a string, calling the function form with `extra`
// when present so dynamic fixes can echo concrete target values back at the
// agent. Returns undefined for unknown dimensions.
export function resolveFixHint(dimension, extra) {
  const hint = FIX_HINTS[dimension];
  if (typeof hint === 'function') {
    try { return hint(extra); }
    catch { return undefined; }
  }
  return hint;
}

// JSON-friendly dimension index shipped in the chapter runtime context. Each
// entry pairs a dimension with its precedence rank, the suppressors that
// could mask it, and a baseline fix string (function fixes are called with
// {} so the agent sees the generic form before it has concrete extras).
//
// `acknowledgedWarnings` is intentionally excluded: it is a meta-warning
// emitted by check-chapter when an ack entry targets a non-warning-class
// dimension, NOT a validation dimension agents can fail or fix. Its
// semantics live in the `### acknowledgedWarnings opt-out` prose section of
// rules.md, generated separately by build-rules-doc.mjs. Keeping it in
// FIX_HINTS lets resolveFixHint() still attach a friendly hint to the
// runtime warning.
const CATALOG_EXCLUDED_DIMENSIONS = new Set(['acknowledgedWarnings']);

// Class membership for the four `precedence: —` cohorts used by
// build-rules-doc.mjs to group the dimensions table by class instead of by
// FIX_HINTS insertion order. Failure-class chapter dimensions (those with a
// numeric precedenceRank) are reported as 'chapter-failure' and sort first
// by their rank. WARNING_DIMENSIONS members are 'chapter-warning'.
// Cross-chapter dimensions split by emit severity in check-cross-chapter.mjs:
// the failure set blocks finalize-report; the warning set is non-blocking
// outside `--strict` (and finalize-report does not pass --strict here).
// Membership for the other buckets is enumerated explicitly so a new
// dimension cannot silently land in the wrong group.
const CROSS_CHAPTER_FAILURE_DIMENSIONS = new Set([
  'duplicateAnalysisCrossChapter',
  'keyFactDrift',
  'metricDrift',
  'missingChapter',
]);
const CROSS_CHAPTER_WARNING_DIMENSIONS = new Set([
  'duplicateLocalClaim',
  'metricDriftSmall',
]);
const FINALIZE_STEP_DIMENSIONS = new Set([
  'reportContract',
  'reportMetaShape',
  'revisionGraph',
  'workflowConfigShape',
  'usage',
]);
const REPORT_META_WARNING_DIMENSIONS = new Set([
  'displayCompleteness',
]);

export function classifyDimension(dimension, precedenceRank) {
  if (WARNING_DIMENSIONS.has(dimension)) return 'chapter-warning';
  if (CROSS_CHAPTER_FAILURE_DIMENSIONS.has(dimension)) return 'cross-chapter-failure';
  if (CROSS_CHAPTER_WARNING_DIMENSIONS.has(dimension)) return 'cross-chapter-warning';
  if (FINALIZE_STEP_DIMENSIONS.has(dimension)) return 'finalize-step';
  if (REPORT_META_WARNING_DIMENSIONS.has(dimension)) return 'report-meta-warning';
  if (precedenceRank != null) return 'chapter-failure';
  return 'chapter-failure';
}

// Stable display order for grouped tables: chapter-failure first (by rank),
// then chapter-warning, then cross-chapter (failure before warning), then
// finalize-step, then report-meta-warning. Within each non-failure group,
// sort alphabetically (or by rank for the chapter classes) for deterministic
// output.
const CLASS_ORDER = [
  'chapter-failure',
  'chapter-warning',
  'cross-chapter-failure',
  'cross-chapter-warning',
  'finalize-step',
  'report-meta-warning',
];

export function dimensionCatalog() {
  const rankByDim = new Map(RETRY_PRECEDENCE.map((dim, i) => [dim, i]));
  const suppressedByMap = new Map();
  for (const [upstream, downstream] of Object.entries(CASCADE_SUPPRESSORS)) {
    for (const dim of downstream) {
      if (!suppressedByMap.has(dim)) suppressedByMap.set(dim, []);
      suppressedByMap.get(dim).push(upstream);
    }
  }
  return Object.keys(FIX_HINTS)
    .filter((dimension) => !CATALOG_EXCLUDED_DIMENSIONS.has(dimension))
    .map((dimension) => {
      const precedenceRank = rankByDim.get(dimension) ?? null;
      return {
        dimension,
        precedenceRank,
        dimensionClass: classifyDimension(dimension, precedenceRank),
        defaultFix: resolveFixHint(dimension, {}) ?? null,
        suppressedBy: suppressedByMap.get(dimension) ?? [],
      };
    })
    .sort((a, b) => {
      const classDelta = CLASS_ORDER.indexOf(a.dimensionClass) - CLASS_ORDER.indexOf(b.dimensionClass);
      if (classDelta !== 0) return classDelta;
      // chapter-failure and chapter-warning share RETRY_PRECEDENCE indices,
      // so sort both by rank (rank-less entries like tableNotes fall to the
      // end via the 999 sentinel). Other buckets have no rank: alphabetical.
      if (a.dimensionClass === 'chapter-failure' || a.dimensionClass === 'chapter-warning') {
        const rankDelta = (a.precedenceRank ?? 999) - (b.precedenceRank ?? 999);
        if (rankDelta !== 0) return rankDelta;
        return a.dimension.localeCompare(b.dimension);
      }
      return a.dimension.localeCompare(b.dimension);
    });
}
