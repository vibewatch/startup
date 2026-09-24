// Executable Zod schemas for report-v2 artifacts.
//
// Shape validation lives here. Semantic/gate checks (cross refs, source
// diversity, net-new URLs, renderer deep checks) remain in the checker scripts
// and reuse this module for common object contracts.

import { z } from 'zod';
import {
  BLOCK_TYPES,
  CALLOUT_TYPES,
  CARD_CONFIDENCES,
  CARD_RECOMMENDATIONS,
  CARD_RISK_RATINGS,
  CARD_VALUATION_STANCES,
  CLAIM_CONFIDENCES,
  CLAIM_FRESHNESS,
  CLAIM_TYPES,
  ENUMERATION_COVERAGE,
  EVIDENCE_GAP_SEVERITIES,
  EVIDENCE_GAP_TYPES,
  EVIDENCE_QUALITIES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  SOURCE_ACCESS_STATUSES,
  SOURCE_INDEPENDENCE,
  SOURCE_REPUTATION_TIERS,
  SOURCE_STANCES,
  SOURCE_TYPES,
} from '../validation-catalog.mjs';
import { zodIssues } from './validation-result.mjs';

export const SCHEMA_VERSION = 'report-v2';

const nonEmptyString = z.string().trim().min(1, 'must be a non-empty string');
const httpUrlString = nonEmptyString.refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');
const nullableString = z.string().nullable();

function labelType(schema, label) {
  schema._def.__typeLabel = label;
  return schema;
}

const dateLike = labelType(z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  z.date(),
]), 'YYYY-MM-DD');
const nullableDateLike = labelType(z.union([dateLike, z.null()]), 'YYYY-MM-DD');

function refType(pattern, kind, message) {
  const schema = z.string().regex(pattern, message);
  schema._def.__refKind = kind;
  return schema;
}

const claimRef = refType(/^C[A-Z]\d{3}$/, 'C<L>###', 'must be a claim id C<ChapterLetter>###');
const sourceRef = refType(/^S[A-Z]\d{3}$/, 'S<L>###', 'must be a source id S<ChapterLetter>###');
const questionRef = refType(/^Q[A-Z]\d{3}$/, 'Q<L>###', 'must be a research question id Q<ChapterLetter>###');
const tableRef = refType(/^T[A-Z]\d{3}$/, 'T<L>###', 'must be a table id T<ChapterLetter>###');
const figureRef = refType(/^F[A-Z]\d{3}$/, 'F<L>###', 'must be a figure id F<ChapterLetter>###');
const scalarTableCell = labelType(z.union([z.string(), z.number(), z.null()]), 'string|number|null');

function enumMember(values, label) {
  const arr = Array.from(values instanceof Set ? values : new Set(values));
  const set = new Set(arr);
  const schema = z.string().refine((value) => set.has(value), `${label} must be one of ${arr.join('|')}`);
  schema._def.__enumValues = arr;
  return schema;
}

export const RevisionSchema = z.object({
  status: z.enum(['current', 'superseded']).default('current').describe('current=this run is the live report; superseded=replaced by a newer refresh'),
  refreshOfRunId: nullableString.optional().describe('runId of the report this refresh replaces (set automatically by link-refresh.mjs)'),
  supersededByRunId: nullableString.optional().describe('runId of the newer refresh that replaced this report (set on the prior run after link-refresh)'),
  refreshReason: nullableString.optional().describe('the same --refresh-reason string passed to create-report-run and finalize-report'),
}).strict();

export const CompanyHeadSchema = z.object({
  name: nonEmptyString,
}).passthrough();

export const DocumentHeadSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  artifact: nonEmptyString.describe('use runtimeContext.chapter.key for chapter YAMLs (e.g. company-overview); literal "evidence" for evidence.yaml'),
  slug: nonEmptyString.describe('company slug (the report folder basename with the leading <timestamp>- stripped)'),
  runDate: dateLike.describe('canonical run date — derive from runtimeContext.run.runDate, not the model clock'),
  company: CompanyHeadSchema,
}).passthrough();

export const SourceSchema = z.object({
  id: z.string().optional().describe('S<ChapterLetter>### (e.g. SO001). Schema-optional so partial drafts validate, but in practice mandatory — every sourceRefs[] entry resolves against sources[].id, so a missing id makes the source unreferenceable and yields a dangling-reference error at build time.'),
  publisher: nonEmptyString.describe('publishing organization (e.g. "Securities and Exchange Commission", "Financial Times")'),
  title: nonEmptyString.describe('article / filing / page title'),
  url: httpUrlString.describe('canonical http(s) URL fetched via the fetch-url skill'),
  date: nullableDateLike.optional().describe('publication date YYYY-MM-DD if known'),
  accessDate: dateLike.describe('the date you fetched the URL'),
  accessStatus: enumMember(SOURCE_ACCESS_STATUSES, 'accessStatus').describe('how the fetch went. ok=normal page; paywall|js-only|broken|rate-limited count toward the report-level paywall ceiling.'),
  stance: enumMember(SOURCE_STANCES, 'stance').describe('source posture toward the company. adverse=skeptical/critical, confirming=positive, neutral=factual, unknown=cannot determine.'),
  sourceType: enumMember(SOURCE_TYPES, 'sourceType').describe('artifact category. filing|regulatory|legal|official are primary-tier (count toward gate.requiredSourceTypes and high-confidence corroboration).'),
  reputationTier: enumMember(SOURCE_REPUTATION_TIERS, 'reputationTier').describe('publisher reputation. high=SEC/FT/NYT/top analyst etc.; low=anonymous blogs, paid PR; medium otherwise.'),
  independence: enumMember(SOURCE_INDEPENDENCE, 'independence').describe('relationship to the company. company=issued by company itself; partner|customer|competitor as labelled; independent=arms-length third party.'),
  topics: z.array(nonEmptyString).min(1, 'topics must be a non-empty array').describe('free-form topic tags used for cross-chapter de-dupe and ledger consolidation. Quote bare numerics like years (- "2024") so YAML parses them as strings.'),
  keyQuote: nullableString.optional().describe('verbatim quote backing the strongest claim this source supports (recommended for adverse and high-confidence sources)'),
}).passthrough();

export const ClaimSchema = z.object({
  id: z.string().optional().describe('C<ChapterLetter>### (e.g. CO045). Schema-optional so partial drafts validate, but in practice mandatory — every claimRefs[] entry resolves against claims[].id, so a missing id makes the claim unreferenceable and yields a dangling-reference error at build time.'),
  statement: nonEmptyString.describe('single-fact statement (one sentence). Split compound facts into multiple atomic claims.'),
  type: enumMember(CLAIM_TYPES, 'type').describe('observed=directly seen by author, third-party-reported=cited from another source, company-claimed=company\'s own statement, inferred=derived, estimated=numerical estimate, conflicting=contradicted by another claim (requires contradictsClaimRefs), open-question=unverified hypothesis (sourceRefs may be empty).'),
  topic: nonEmptyString.describe('topic tag for grouping. Reuse topics across claims that cover the same angle.'),
  sourceRefs: z.array(sourceRef).describe('S<ChapterLetter>### ids that back this claim. Must be non-empty unless type=open-question.'),
  confidence: enumMember(CLAIM_CONFIDENCES, 'confidence').describe('high requires a primary-tier source (filing|regulatory|legal|official OR reputationTier=high); otherwise downgrade to medium.'),
  freshness: enumMember(CLAIM_FRESHNESS, 'freshness').describe('current=valid as of runDate, recent=within volatileFacts horizon, historical=stable fact, unknown=time horizon unclear.'),
  answersQuestionRefs: z.array(questionRef).optional().describe('Q<ChapterLetter>### ids this claim answers. Drives researchQuestionAnswerCoverage.'),
  contradictsClaimRefs: z.array(claimRef).optional().describe('C<ChapterLetter>### ids this claim contradicts. Required when type=conflicting.'),
}).passthrough().superRefine((claim, ctx) => {
  if (claim.type !== 'open-question' && claim.sourceRefs.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceRefs'], message: 'sourceRefs must be non-empty unless type is open-question' });
  }
  if (claim.type === 'conflicting' && !(claim.contradictsClaimRefs ?? []).length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contradictsClaimRefs'], message: 'type=conflicting requires non-empty contradictsClaimRefs' });
  }
});

export const ResearchQuestionSchema = z.object({
  id: refType(/^Q[A-Z]\d{3}$/, 'Q<L>###', 'id must match Q<ChapterLetter>###').describe('Q<ChapterLetter>### (e.g. QO001). Letter must match this chapter\'s letter.'),
  question: z.string().trim().min(20, 'question text must be at least 20 chars').describe('verifiable question (>=20 chars). Phrase as a question, not a topic.'),
  type: enumMember(QUESTION_TYPES, 'type').describe('drives minQuestionTypeSpread; balance across types'),
  targets: z.array(nonEmptyString).min(1, 'targets[] must be a non-empty array').describe('reference items in runtimeContext.chapter.contentRequirements/<index>, .plannedTables/<slug>, or .plannedFigures/<slug>'),
  status: enumMember(QUESTION_STATUSES, 'status').describe('answered=a claim cites this via answersQuestionRefs; partial=some evidence but unresolved; unresolved=open (must have an evidenceGap citing it).'),
}).passthrough();

export const SearchQuerySchema = z.object({
  query: nonEmptyString.describe('provenance/audit record of a source-discovery query you issued; not the search executor itself'),
  engine: nullableString.optional().describe('search engine identifier (google, bing, etc.)'),
  hits: z.number().nullable().optional().describe('count of returned results, if known'),
  retainedSourceRefs: z.array(sourceRef).default([]).describe('S<ChapterLetter>### ids retained from this query (subset of sources[])'),
}).passthrough();

export const EvidenceGapSchema = z.object({
  type: enumMember(EVIDENCE_GAP_TYPES, 'evidenceGap.type'),
  severity: enumMember(EVIDENCE_GAP_SEVERITIES, 'severity').describe('blocking=cannot ship without it; material=affects judgment; minor=nice to have.'),
  topic: nonEmptyString.describe('topic tag (reuse a topic from claims/sources where possible)'),
  missingEvidence: nonEmptyString.describe('describe what evidence would close the gap'),
  whyItMatters: nonEmptyString.describe('explain why it affects the analysis or judgment'),
  diligencePath: nonEmptyString.describe('concrete next step to acquire the evidence'),
  relatedQuestionRefs: z.array(questionRef).optional().describe('Q<ChapterLetter>### ids whose closure depends on this gap'),
  relatedTableRefs: z.array(tableRef).optional().describe('T<ChapterLetter>### ids whose enumeration this gap covers'),
}).passthrough();

export const LocalEvidenceSchema = z.object({
  searchQueries: z.array(SearchQuerySchema).describe('provenance/audit trail for source-discovery queries; plan and issue the searches before recording them here'),
  researchQuestions: z.array(ResearchQuestionSchema),
  sources: z.array(SourceSchema),
  claims: z.array(ClaimSchema),
  evidenceGaps: z.array(EvidenceGapSchema),
}).strict();

export const SectionSchema = z.object({
  id: nonEmptyString.describe('section id (kebab-case recommended; unique within the chapter)'),
  title: nonEmptyString,
  body: nonEmptyString.describe('section prose; expanded by the depthSection gate if too short'),
  claimRefs: z.array(claimRef).describe('C<ChapterLetter>### ids cited in this section\'s body'),
  tableRefs: z.array(tableRef).optional().describe('T<ChapterLetter>### ids of tables that belong inside this section (rendered after the prose, in listed order). Each table id may appear in at most one section across the chapter; unreferenced tables fall back to the trailing Exhibits section.'),
  figureRefs: z.array(figureRef).optional().describe('F<ChapterLetter>### ids of figures that belong inside this section (rendered after the prose and any sectioned tables, in listed order). Each figure id may appear in at most one section across the chapter; unreferenced figures fall back to the trailing Exhibits section.'),
}).passthrough();

// enumerationScope passthrough() lets reports keep optional descriptive
// fields (rationale, boundaryNote, relatedTableRefs, ...) without forcing
// the schema to enumerate every consumer. coverage and basis are required.
export const EnumerationScopeSchema = z.object({
  coverage: enumMember(ENUMERATION_COVERAGE, 'enumerationScope.coverage').describe('exhaustive=full population, partial=most, sample=representative subset'),
  basis: z.string().trim().min(20, 'enumerationScope.basis must be a non-empty string (>=20 chars)').describe('describe the enumeration boundary in 20+ chars (data source, time window, geography, segment)'),
}).passthrough();

export const TableSchema = z.object({
  id: z.string().optional().describe('T<ChapterLetter>### (e.g. TO008)'),
  title: nonEmptyString.optional(),
  columns: z.array(nonEmptyString).min(1, 'requires non-empty data.columns'),
  rows: z.array(z.array(scalarTableCell)).describe('every row must have the same cell count as columns'),
  notes: nullableString.optional().describe('one line: data source / estimation / partial coverage / what null means. Acknowledge the tableNotes warning for pure factual snapshot tables.'),
  enumerationScope: EnumerationScopeSchema.optional().describe('required for plannedTables marked enumeration:true'),
  claimRefs: z.array(claimRef).optional().describe('C<ChapterLetter>### ids backing the table'),
}).passthrough().superRefine((table, ctx) => {
  const expected = table.columns?.length ?? 0;
  for (const [rowIndex, row] of (table.rows ?? []).entries()) {
    if (row.length !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rows', rowIndex],
        message: `row ${rowIndex + 1} has ${row.length} cells but columns declares ${expected}`,
      });
    }
  }
});

export const CalloutSchema = z.object({
  calloutType: enumMember(CALLOUT_TYPES, 'calloutType').optional(),
  title: nonEmptyString,
  body: nonEmptyString,
  claimRefs: z.array(claimRef).describe('C<ChapterLetter>### ids the callout cites'),
}).passthrough();

export const FigureSchema = z.object({
  id: z.string().optional().describe('F<ChapterLetter>### (e.g. FO003)'),
  title: nonEmptyString,
  type: nonEmptyString.describe('one of the figure types listed in references/rules.md → Renderer contracts → Allowed figure types'),
  summary: nonEmptyString.optional().describe('1-sentence figure caption'),
  data: z.record(z.string(), z.any()).describe('shape depends on figure type — see references/rules.md for required field combinations and allowed populated fields per type'),
  approximationNotes: nullableString.optional().describe('note any rounding, smoothing, or estimation'),
  claimRefs: z.array(claimRef).optional().describe('C<ChapterLetter>### ids backing the figure (must give a distinct lens vs. any sibling table or duplicateAnalysis trips)'),
}).passthrough();

export const AcknowledgedWarningSchema = z.object({
  dimension: nonEmptyString.describe('validator dimension being acknowledged (e.g. tableNotes)'),
  reason: z.string().trim().min(30, 'reason must be at least 30 characters').describe('>=30 char justification for why the warning is non-actionable'),
}).strict();

export const AnalysisArtifactSchema = DocumentHeadSchema.extend({
  chapter: z.object({
    number: z.number().describe('1-based chapter order matching the configured chapter\'s order'),
    title: nonEmptyString,
    summary: nonEmptyString.describe('1–3 sentence chapter abstract that anchors on the strongest evidence'),
  }).passthrough(),
  sections: z.array(SectionSchema),
  tables: z.array(TableSchema),
  figures: z.array(FigureSchema),
  callouts: z.array(CalloutSchema).default([]),
  localEvidence: LocalEvidenceSchema,
  acknowledgedWarnings: z.array(AcknowledgedWarningSchema).optional().describe('opt out of intentional --strict warnings; never use to silence real failures'),
}).passthrough();

export const CoverFactSchema = z.object({
  label: nonEmptyString.describe('headline fact label (e.g. "Last raised", "ARR")'),
  value: z.union([z.string(), z.number(), z.null()]).describe('scalar value; use null when not yet known'),
  unit: nullableString.optional().describe('unit string (USD, %, ...) or null'),
  claimRefs: z.array(claimRef).optional().describe('claim ids backing the fact (resolved by build-report against the consolidated evidence ledger)'),
}).passthrough();

export const CompanyProfileFounderSchema = z.object({
  name: nonEmptyString,
  role: nullableString.optional(),
  background: nullableString.optional().describe('1-sentence prior experience'),
  claimRefs: z.array(claimRef).optional(),
}).passthrough();

export const CompanyProfileSchema = z.object({
  summary: nonEmptyString.describe('1-paragraph company overview'),
  foundedDate: nullableDateLike.optional(),
  founders: z.array(CompanyProfileFounderSchema).optional(),
  foundingLocation: nullableString.optional(),
  headquarters: nullableString.optional(),
  productSummary: nonEmptyString.describe('what the company sells, in concrete product terms'),
  customerFocus: nullableString.optional().describe('target customer segment'),
  businessModel: nullableString.optional().describe('how the company makes money'),
  stage: nullableString.optional().describe('company stage (Series X, public, ...)'),
  fundingStatus: nullableString.optional().describe('latest funding round summary'),
  disclosureProfile: z.enum(['public', 'private-disclosed', 'private-undisclosed', 'stealth']).nullable().optional().describe('public=public company; private-disclosed=private with public financials; private-undisclosed=private but opaque; stealth=undisclosed product/business'),
  claimRefs: z.array(claimRef).optional(),
}).passthrough();

export const KeyMetricsSchema = z.object({
  valuationUsdM: z.number().nullable().describe('latest valuation in USD millions; null if not disclosed'),
  revenueRunRateUsdM: z.number().nullable().describe('current revenue run rate in USD millions'),
  arrUsdM: z.number().nullable().describe('annual recurring revenue in USD millions'),
  revenueGrowthYoYPct: z.number().nullable().describe('year-over-year revenue growth %'),
  grossMarginPct: z.number().nullable().describe('gross margin %'),
  nrrPct: z.number().nullable().describe('net revenue retention %'),
  totalRaisedUsdM: z.number().nullable().describe('lifetime capital raised in USD millions'),
  customerCount: z.number().nullable().describe('active customer / account count'),
  headcount: z.number().nullable().describe('employee count'),
}).strict();

export const SummaryJudgmentSchema = z.object({
  headline: nonEmptyString.describe('1-sentence top-line judgment'),
  overallScore: z.number().min(0, 'overallScore must be 0–10').max(10, 'overallScore must be 0–10').describe('0–10 composite score'),
  recommendation: enumMember(CARD_RECOMMENDATIONS, 'recommendation'),
  confidence: enumMember(CARD_CONFIDENCES, 'confidence').describe('author\'s confidence in the recommendation'),
  riskRating: enumMember(CARD_RISK_RATINGS, 'riskRating'),
  valuationStance: enumMember(CARD_VALUATION_STANCES, 'valuationStance'),
  keyMetrics: KeyMetricsSchema.describe('structured KPIs (use null for unavailable values, never zero)'),
  topStrengths: z.array(nonEmptyString).min(1, 'topStrengths must have at least one item').describe('ranked strengths (>=1)'),
  topRisks: z.array(nonEmptyString).min(1, 'topRisks must have at least one item').describe('ranked risks (>=1)'),
  unresolvedGaps: z.array(nonEmptyString).describe('open questions / blockers carried into the next refresh'),
}).strict();

export const CompanyMetaSchema = z.object({
  name: nonEmptyString,
  website: nullableString.optional(),
  sector: nullableString.optional(),
  stage: nullableString.optional(),
  headquarters: nullableString.optional(),
  shortDescription: nullableString.optional(),
}).strict();

export const BlockSchema = z.object({
  type: enumMember(BLOCK_TYPES, 'block.type'),
  title: nullableString.optional(),
  body: nullableString.optional().describe('block prose (when type=paragraph or callout)'),
  calloutType: enumMember(CALLOUT_TYPES, 'calloutType').nullable().optional().describe('required when type=callout'),
  tableRef: tableRef.nullable().optional().describe('T<ChapterLetter>### id (when type=table)'),
  figureRef: figureRef.nullable().optional().describe('F<ChapterLetter>### id (when type=figure)'),
  items: z.array(nonEmptyString).optional().describe('list items (when type=list)'),
  equation: nullableString.optional().describe('math expression (when type=equation)'),
  claimRefs: z.array(claimRef).default([]),
}).passthrough();

export const AppendixSchema = z.object({
  id: z.string().regex(/^[A-Z]$/, 'appendix id must be A, B, C, ...').describe('single uppercase letter A, B, C, ...'),
  title: nonEmptyString,
  blocks: z.array(BlockSchema).describe('ordered content blocks; each block uses one of the type values below'),
}).passthrough();

export const ReportMetaSchema = z.object({
  slug: nonEmptyString.describe('company slug (matches every chapter\'s slug)'),
  runDate: dateLike,
  company: CompanyMetaSchema,
  revision: RevisionSchema.nullable().optional().describe('DO NOT AUTHOR — written automatically by link-refresh.mjs. Canonical: omit the field entirely (preferred over `revision: null` or `revision: {}`). If more than one finalized current report matches the same company/domain, resolve it before folder creation with create-report-run.mjs --refresh-of <runId>.'),
  subtitle: nullableString.optional(),
  coverageNotes: nullableString.optional().describe('caveats about coverage / dating / scope'),
  coverFacts: z.array(CoverFactSchema).nullable().optional().describe('front-page fact strip'),
  companyProfile: CompanyProfileSchema,
  summary: SummaryJudgmentSchema,
  appendices: z.array(AppendixSchema).nullable().optional().describe('optional appendix sections (cap, gtm, citations, ...)'),
  disclaimer: nullableString.optional().describe('legal / methodology disclaimer'),
}).passthrough();

export const EvidenceArtifactSchema = DocumentHeadSchema.extend({
  artifact: z.literal('evidence'),
  coverage: z.object({
    evidenceQuality: enumMember(EVIDENCE_QUALITIES, 'evidenceQuality'),
    sourceDiversityNotes: nullableString.optional(),
    deduplicationNotes: nonEmptyString.optional(),
    recencyNotes: nonEmptyString.optional(),
    coverageGaps: z.array(nonEmptyString).optional(),
  }).passthrough(),
  sources: z.array(SourceSchema),
  claims: z.array(ClaimSchema),
  evidenceGaps: z.array(EvidenceGapSchema),
}).passthrough();

export function schemaErrors(schema, value, { path = '/', dimension = 'schema', source = null, fix = null } = {}) {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return zodIssues(result.error, { dimension, source, fix }).map((issue) => ({
    ...issue,
    path: issue.path === '/' ? path : `${path}.${issue.path}`.replace(/\.\//g, ''),
  }));
}
