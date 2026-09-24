<!-- GENERATED FILE: edit scripts/contracts/*.schema.mjs (use `.describe()` to annotate fields), then run npm run build:contracts. -->

# startup-research contracts

Schema version: `report-v2`. Field shapes and inline comments are generated from the Zod schemas in `scripts/contracts/report-artifacts.schema.mjs`.

## What you author vs. what is generated

You hand-write two kinds of YAML in each report folder:

1. **Per-chapter analysis YAML** at `<reportFolder>/<chapter.file>` (one per configured chapter) — see *Analysis chapter shape* below.
2. **`<reportFolder>/report-meta.yaml`** — see *Report meta shape* below.

Authoring stops there. `finalize-report.mjs` produces every other artifact in the folder from those inputs:

- `evidence.yaml` is a **consolidated** ledger built from each chapter's `localEvidence` by `build-evidence-ledger.mjs`. It does not renumber: chapter ids stay as you wrote them, and duplicates across chapters get tagged with a `canonical` pointer to the first occurrence.
- `full-report.yaml` and `summary-card.yaml` are assembled by `build-report.mjs` from the chapter YAMLs and `report-meta.yaml`.
- `.workflow-snapshot.yaml` is script-owned. `apply-research-profile.mjs` may write a resolved fast/deep snapshot before chapter work; otherwise `finalize-report.mjs` freezes the deep head config on first finalize. Every downstream validator loads this snapshot in preference to the head config, so later edits never retroactively re-judge the report. Never hand-edit it; pass `--refresh-snapshot` to finalize-report only when you intentionally want the report re-judged against the current deep head config.

Vocabularies (enum value sets) are listed inline below at each enum field. Agent policy, gates, IDs, renderer rules, and the on-demand validator catalog live in [`rules.md`](rules.md). Chapter workers need the analysis shape; the orchestrator needs report-meta before finalization. Do not preload unrelated sections.

### Reading conventions

Field comments below reference `runtimeContext.X` paths. `runtimeContext` is the per-chapter JSON projection emitted by `node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --order <n> --report-folder <reportFolder> [--include-context]`; omit `--include-context` during parallel drafting. It carries only the chapter brief, neighbouring chapters, run identity, refresh cache, and earlier-chapter rollups — no workflow/policy/vocabulary content. The id shorthand used throughout (`S<L>###`, `C<L>###`, …) is documented under *ID system* in [`rules.md`](rules.md).

## Analysis chapter shape

One file per configured chapter at `<reportFolder>/<chapter.file>`. The first five fields (`schemaVersion` through `company`) are the shared document head reused by `report-meta.yaml` (without `schemaVersion` / `artifact`).

```yaml
schemaVersion: "report-v2"
artifact: string  # use runtimeContext.chapter.key for chapter YAMLs (e.g. company-overview); literal "evidence" for evidence.yaml
slug: string  # company slug (the report folder basename with the leading <timestamp>- stripped)
runDate: YYYY-MM-DD  # canonical run date — derive from runtimeContext.run.runDate, not the model clock
company:
  name: string
chapter:
  number: number  # 1-based chapter order matching the configured chapter's order
  title: string
  summary: string  # 1–3 sentence chapter abstract that anchors on the strongest evidence
sections:
  - id: string  # section id (kebab-case recommended; unique within the chapter)
    title: string
    body: string  # section prose; expanded by the depthSection gate if too short
    claimRefs: [C<L>###]  # C<ChapterLetter>### ids cited in this section's body
    tableRefs?: [T<L>###]  # T<ChapterLetter>### ids of tables that belong inside this section (rendered after the prose, in listed order). Each table id may appear in at most one section across the chapter; unreferenced tables fall back to the trailing Exhibits section.
    figureRefs?: [F<L>###]  # F<ChapterLetter>### ids of figures that belong inside this section (rendered after the prose and any sectioned tables, in listed order). Each figure id may appear in at most one section across the chapter; unreferenced figures fall back to the trailing Exhibits section.
tables:
  - id?: string  # T<ChapterLetter>### (e.g. TO008)
    title?: string
    columns: [string]
    rows: [[string|number|null]]  # every row must have the same cell count as columns
    notes?: string|null  # one line: data source / estimation / partial coverage / what null means. Acknowledge the tableNotes warning for pure factual snapshot tables.
    enumerationScope?:  # required for plannedTables marked enumeration:true
      coverage: exhaustive|partial|sample  # exhaustive=full population, partial=most, sample=representative subset
      basis: string  # describe the enumeration boundary in 20+ chars (data source, time window, geography, segment)
    claimRefs?: [C<L>###]  # C<ChapterLetter>### ids backing the table
figures:
  - id?: string  # F<ChapterLetter>### (e.g. FO003)
    title: string
    type: string  # one of the figure types listed in references/rules.md → Renderer contracts → Allowed figure types
    summary?: string  # 1-sentence figure caption
    data: {...}  # shape depends on figure type — see references/rules.md for required field combinations and allowed populated fields per type
    approximationNotes?: string|null  # note any rounding, smoothing, or estimation
    claimRefs?: [C<L>###]  # C<ChapterLetter>### ids backing the figure (must give a distinct lens vs. any sibling table or duplicateAnalysis trips)
callouts:
  - calloutType?: strength|risk|recommendation|insight|assumption
    title: string
    body: string
    claimRefs: [C<L>###]  # C<ChapterLetter>### ids the callout cites
localEvidence:
  searchQueries:  # provenance/audit trail for source-discovery queries; plan and issue the searches before recording them here
    - query: string  # provenance/audit record of a source-discovery query you issued; not the search executor itself
      engine?: string|null  # search engine identifier (google, bing, etc.)
      hits?: number|null  # count of returned results, if known
      retainedSourceRefs: [S<L>###] (default [])  # S<ChapterLetter>### ids retained from this query (subset of sources[])
  researchQuestions:
    - id: Q<L>###  # Q<ChapterLetter>### (e.g. QO001). Letter must match this chapter's letter.
      question: string  # verifiable question (>=20 chars). Phrase as a question, not a topic.
      type: enumeration|quantification|verification|adverse|freshness|comparison|mechanism  # drives minQuestionTypeSpread; balance across types
      targets: [string]  # reference items in runtimeContext.chapter.contentRequirements/<index>, .plannedTables/<slug>, or .plannedFigures/<slug>
      status: answered|partial|unresolved  # answered=a claim cites this via answersQuestionRefs; partial=some evidence but unresolved; unresolved=open (must have an evidenceGap citing it).
  sources:
    - id?: string  # S<ChapterLetter>### (e.g. SO001). Schema-optional so partial drafts validate, but in practice mandatory — every sourceRefs[] entry resolves against sources[].id, so a missing id makes the source unreferenceable and yields a dangling-reference error at build time.
      publisher: string  # publishing organization (e.g. "Securities and Exchange Commission", "Financial Times")
      title: string  # article / filing / page title
      url: string  # canonical http(s) URL fetched via the fetch-url skill
      date?: YYYY-MM-DD  # publication date YYYY-MM-DD if known
      accessDate: YYYY-MM-DD  # the date you fetched the URL
      accessStatus: ok|paywall|js-only|broken|rate-limited  # how the fetch went. ok=normal page; paywall|js-only|broken|rate-limited count toward the report-level paywall ceiling.
      stance: confirming|adverse|neutral|unknown  # source posture toward the company. adverse=skeptical/critical, confirming=positive, neutral=factual, unknown=cannot determine.
      sourceType: official|filing|regulatory|news|analyst-market-data|technical-docs|customer-proof|partner-proof|developer-signal|review|legal|other  # artifact category. filing|regulatory|legal|official are primary-tier (count toward gate.requiredSourceTypes and high-confidence corroboration).
      reputationTier: high|medium|low  # publisher reputation. high=SEC/FT/NYT/top analyst etc.; low=anonymous blogs, paid PR; medium otherwise.
      independence: company|partner|customer|competitor|independent|unknown  # relationship to the company. company=issued by company itself; partner|customer|competitor as labelled; independent=arms-length third party.
      topics: [string]  # free-form topic tags used for cross-chapter de-dupe and ledger consolidation. Quote bare numerics like years (- "2024") so YAML parses them as strings.
      keyQuote?: string|null  # verbatim quote backing the strongest claim this source supports (recommended for adverse and high-confidence sources)
  claims:
    - id?: string  # C<ChapterLetter>### (e.g. CO045). Schema-optional so partial drafts validate, but in practice mandatory — every claimRefs[] entry resolves against claims[].id, so a missing id makes the claim unreferenceable and yields a dangling-reference error at build time.
      statement: string  # single-fact statement (one sentence). Split compound facts into multiple atomic claims.
      type: observed|company-claimed|third-party-reported|estimated|inferred|open-question|conflicting  # observed=directly seen by author, third-party-reported=cited from another source, company-claimed=company's own statement, inferred=derived, estimated=numerical estimate, conflicting=contradicted by another claim (requires contradictsClaimRefs), open-question=unverified hypothesis (sourceRefs may be empty).
      topic: string  # topic tag for grouping. Reuse topics across claims that cover the same angle.
      sourceRefs: [S<L>###]  # S<ChapterLetter>### ids that back this claim. Must be non-empty unless type=open-question.
      confidence: high|medium|low  # high requires a primary-tier source (filing|regulatory|legal|official OR reputationTier=high); otherwise downgrade to medium.
      freshness: current|recent|historical|unknown  # current=valid as of runDate, recent=within volatileFacts horizon, historical=stable fact, unknown=time horizon unclear.
      answersQuestionRefs?: [Q<L>###]  # Q<ChapterLetter>### ids this claim answers. Drives researchQuestionAnswerCoverage.
      contradictsClaimRefs?: [C<L>###]  # C<ChapterLetter>### ids this claim contradicts. Required when type=conflicting.
  evidenceGaps:
    - type: missing-source|conflicting-data|private-evidence-only|enumeration-incomplete|stale|access-blocked
      severity: blocking|material|minor  # blocking=cannot ship without it; material=affects judgment; minor=nice to have.
      topic: string  # topic tag (reuse a topic from claims/sources where possible)
      missingEvidence: string  # describe what evidence would close the gap
      whyItMatters: string  # explain why it affects the analysis or judgment
      diligencePath: string  # concrete next step to acquire the evidence
      relatedQuestionRefs?: [Q<L>###]  # Q<ChapterLetter>### ids whose closure depends on this gap
      relatedTableRefs?: [T<L>###]  # T<ChapterLetter>### ids whose enumeration this gap covers
acknowledgedWarnings?:  # opt out of intentional --strict warnings; never use to silence real failures
  - dimension: string  # validator dimension being acknowledged (e.g. tableNotes)
    reason: string  # >=30 char justification for why the warning is non-actionable
```

## Report meta shape

`<reportFolder>/report-meta.yaml` — owns the final judgment, cover facts, and company profile.

```yaml
slug: string  # company slug (matches every chapter's slug)
runDate: YYYY-MM-DD
company:
  name: string
  website?: string|null
  sector?: string|null
  stage?: string|null
  headquarters?: string|null
  shortDescription?: string|null
revision?:  # (nullable) DO NOT AUTHOR — written automatically by link-refresh.mjs. Canonical: omit the field entirely (preferred over `revision: null` or `revision: {}`). If more than one finalized current report matches the same company/domain, resolve it before folder creation with create-report-run.mjs --refresh-of <runId>.
  status: current|superseded (default "current")  # current=this run is the live report; superseded=replaced by a newer refresh
  refreshOfRunId?: string|null  # runId of the report this refresh replaces (set automatically by link-refresh.mjs)
  supersededByRunId?: string|null  # runId of the newer refresh that replaced this report (set on the prior run after link-refresh)
  refreshReason?: string|null  # the same --refresh-reason string passed to create-report-run and finalize-report
subtitle?: string|null
coverageNotes?: string|null  # caveats about coverage / dating / scope
coverFacts?:  # (nullable) front-page fact strip
  - label: string  # headline fact label (e.g. "Last raised", "ARR")
    value: string|number|null  # scalar value; use null when not yet known
    unit?: string|null  # unit string (USD, %, ...) or null
    claimRefs?: [C<L>###]  # claim ids backing the fact (resolved by build-report against the consolidated evidence ledger)
companyProfile:
  summary: string  # 1-paragraph company overview
  foundedDate?: YYYY-MM-DD
  founders?:
    - name: string
      role?: string|null
      background?: string|null  # 1-sentence prior experience
      claimRefs?: [C<L>###]
  foundingLocation?: string|null
  headquarters?: string|null
  productSummary: string  # what the company sells, in concrete product terms
  customerFocus?: string|null  # target customer segment
  businessModel?: string|null  # how the company makes money
  stage?: string|null  # company stage (Series X, public, ...)
  fundingStatus?: string|null  # latest funding round summary
  disclosureProfile?: public|private-disclosed|private-undisclosed|stealth|null  # public=public company; private-disclosed=private with public financials; private-undisclosed=private but opaque; stealth=undisclosed product/business
  claimRefs?: [C<L>###]
summary:
  headline: string  # 1-sentence top-line judgment
  overallScore: number  # 0–10 composite score
  recommendation: strong-buy|buy|track|research-more|avoid
  confidence: high|medium|low  # author's confidence in the recommendation
  riskRating: low|medium|high|critical|unknown
  valuationStance: attractive|fair|stretched|expensive|unknown
  keyMetrics:  # structured KPIs (use null for unavailable values, never zero)
    valuationUsdM: number|null  # latest valuation in USD millions; null if not disclosed
    revenueRunRateUsdM: number|null  # current revenue run rate in USD millions
    arrUsdM: number|null  # annual recurring revenue in USD millions
    revenueGrowthYoYPct: number|null  # year-over-year revenue growth %
    grossMarginPct: number|null  # gross margin %
    nrrPct: number|null  # net revenue retention %
    totalRaisedUsdM: number|null  # lifetime capital raised in USD millions
    customerCount: number|null  # active customer / account count
    headcount: number|null  # employee count
  topStrengths: [string]  # ranked strengths (>=1)
  topRisks: [string]  # ranked risks (>=1)
  unresolvedGaps: [string]  # open questions / blockers carried into the next refresh
appendices?:  # (nullable) optional appendix sections (cap, gtm, citations, ...)
  - id: string  # single uppercase letter A, B, C, ...
    title: string
    blocks:  # ordered content blocks; each block uses one of the type values below
      - type: paragraph|callout|table|figure|list|equation
        title?: string|null
        body?: string|null  # block prose (when type=paragraph or callout)
        calloutType?: strength|risk|recommendation|insight|assumption|null  # required when type=callout
        tableRef?: T<L>###|null  # T<ChapterLetter>### id (when type=table)
        figureRef?: F<L>###|null  # F<ChapterLetter>### id (when type=figure)
        items?: [string]  # list items (when type=list)
        equation?: string|null  # math expression (when type=equation)
        claimRefs: [C<L>###] (default [])
disclaimer?: string|null  # legal / methodology disclaimer
```

## Chapter runtime context shape

The per-chapter projection produced by `load-chapter-runtime-context.mjs --order <n> [--report-folder <path>] [--include-context]`. Field availability:

- Always present: `schemaVersion`, `generatedFrom`, `totalChapters`, `previousChapter`, `chapter`, `nextChapter`, `policy`. `policy.retryPolicy` carries the per-chapter retry budget (`maxChapterRetries`) and the monotonic-decrease rule that workers must enforce themselves; no script blocks a non-monotonic retry.
- Present whenever `--report-folder` is supplied (including the first chapter and parallel-drafting): `run`, `runCache`. `run.runDate` is the single canonical clock anchor; copy it into every chapter doc head's `runDate` and derive any source-discovery query date tokens from it before searching.
- Present only with `--include-context` (omit during parallel drafting to avoid stale rollups): `contextChapters`, `cumulativeContext`.

```yaml
schemaVersion: "chapter-runtime-context-v3"
generatedFrom: string
totalChapters: number
previousChapter:  # (nullable)
  key: string
  order: number
  letter: string
  file: string
  title: string
  mission: string
  optionalContext: [string]
  contentRequirements: [string]
  plannedTables: [{...}]
  plannedFigures: [{...}]
  evidenceStrategy: [string]
  qualityBar: [string]
  gate: {...}
chapter:
  key: string
  order: number
  letter: string
  file: string
  title: string
  mission: string
  optionalContext: [string]
  contentRequirements: [string]
  plannedTables: [{...}]
  plannedFigures: [{...}]
  evidenceStrategy: [string]
  qualityBar: [string]
  gate: {...}
nextChapter:  # (nullable)
  key: string
  order: number
  letter: string
  file: string
  title: string
  mission: string
  optionalContext: [string]
  contentRequirements: [string]
  plannedTables: [{...}]
  plannedFigures: [{...}]
  evidenceStrategy: [string]
  qualityBar: [string]
  gate: {...}
contextChapters?:
  - key: string
    file: string
    status: loaded|missing|parseError|unknownKey
    error?: string|null
    artifact?: string|null
    title?: string|null
    summary?: string|null
    sections: [{...}]
    tables: [{...}]
    figures: [{...}]
cumulativeContext?:
  note: string
  partial?: boolean
  warnings?:
    - code: string
      message: string
      missingFiles?: [string]
  cumulativeUnresolvedQuestions: number  # Sum of researchQuestions across all earlier loaded chapters whose status is not "answered". Advisory only; never gates this chapter.
  cumulativeRestrictedAccessPct: number  # Share of localEvidence.sources across all earlier loaded chapters whose accessStatus is paywall|js-only|broken|rate-limited (the report-level paywall ceiling pool). Range 0..1, rounded to 3 decimals. Advisory only; never gates this chapter.
  earlierChapters: [{...}]
run?:
  runId: string
  companySlug: string|null
  runDate: string|null
runCache?:
  cacheDir: string|null
  refreshContext: {...}|null
policy?:
  retryPolicy:  # Per-chapter retry budget enforced by the agent (no script blocks a non-monotonic retry). Workers must surface a blocker once the budget is exhausted or the failure count fails to strictly decrease across retries.
    maxChapterRetries: number
    requireMonotonicFailureDecrease: boolean
  workerRouting:  # Binding model and reasoning effort for the chapter worker. The orchestrator must pass both values when spawning the worker; top-level CLI settings do not reliably propagate to subagents.
    profile: chapter-synthesis|chapter-synthesis-fast
    model: string
    reasoningEffort: string
    escalateTo: string|null
```

The list-mode projection (`--list`) emits the chapter roster only:

```yaml
schemaVersion: "chapter-runtime-context-list-v3"
generatedFrom: string
totalChapters: number
chapters:
  - key: string
    order: number
    letter: string
    file: string
    title: string
    mission: string
    optionalContext: [string]
    contentRequirements: [string]
    plannedTables: [{...}]
    plannedFigures: [{...}]
    evidenceStrategy: [string]
    qualityBar: [string]
    gate: {...}
```

## Validation result envelope

Every `check-*.mjs --format json` returns this envelope. Note that the schema shapes above are only one validation layer — `check-chapter` and `check-report` also enforce semantic gates (cross-references, source diversity, freshness, duplicate analysis, depth floors, …) listed in [`rules.md`](rules.md) under *Validator dimensions*. When a gate fails, read `issues[].fix`, `globalHints[].fix`, and `retryOrder[]` before guessing.

Conditional keys (marked optional below) are emitted by the envelope only when non-empty: `retryOrder`, `suppressedDimensions`, `globalHints`, `counts`, and `objectFailures` are all omitted from the JSON when their value is empty / null. Code that reads these keys must tolerate them being absent.

```yaml
ok: boolean
validator: string
artifact?: string                  # only emitted when set; null when validator is folder-scoped
reportFolder?: string              # only emitted when set; absolute path to the report folder
issueCount: number
warningCount: number
issues:
  - path: string                   # dot-joined location of the issue (e.g. tables.0.rows.2)
    message: string
    dimension: string              # see references/rules.md → Validator dimensions
    code: string                   # stable error code (often "<dimension>" or "<artifact>.<reason>")
    severity: error
    fix?: string                   # one-line concrete repair instruction
    # plus any per-dimension extras (id, tableId, claimId, actual, required, …)
warnings:
  - path: string
    message: string
    dimension: string
    code: string
    severity: warning
    fix?: string
retryOrder?: [dimension]           # only when failures exist; ordered root-cause-first per RETRY_PRECEDENCE
suppressedDimensions?: [dimension] # only when CASCADE_SUPPRESSORS hid downstream noise
globalHints?:                      # only when same dimension fails on >=3 distinct objects
  - dimension: string
    affectedObjects: [string]
    fix: string|null
    note: string
counts?:                           # check-chapter only
  sections: number
  tables: number
  figures: number
  sources: number
  claims: number
  gaps: number
  researchQuestions: number
objectFailures?:                   # check-chapter only; failures grouped by the table/figure/claim/question/source they touch
  - objectId: string
    dimensions: [string]
    fixes: [string]
    messages: [string]
summary: object                    # validator-specific (chapterKey, schema path, …)
```

## YAML rules

- Use spaces, not tabs.
- Quote scalar strings containing colon-space (`: `) so YAML does not parse them as mappings.
- Use `null` for unknown optional values, not `N/A` or empty strings.
- Keep numeric fields numeric, not formatted strings with currency signs or commas.
- Do not use YAML anchors/aliases in report artifacts; generated reports should be explicit and portable.
