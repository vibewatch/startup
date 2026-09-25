<!-- GENERATED FILE: edit references/workflow-config.yaml, scripts/validation-catalog.mjs, or website/src/lib/figures.mjs, then run `npm run build:rules`. -->

# startup-research rules

Binding policy and reference values for report authoring. Read Agent policy, Gates, ID system, and Renderer contracts before authoring. Consult only the validator dimension named by a failed check instead of preloading the full catalog.

Pairs with [SKILL.md](../SKILL.md) (the workflow narrative) and [contracts.md](contracts.md) (the field shapes for the YAML you write).

## Agent policy (binding)

#### `hardRules` (do not violate)

- Set slug to the company slug only: the report folder basename with the leading timestamp removed.
- Do not hand-write evidence.yaml, full-report.yaml, or summary-card.yaml; let finalization scripts assemble them.
- Do not hand-author the `revision` block in report-meta.yaml; finalize-report's link-refresh phases own every revision field (status, refreshOfRunId, supersededByRunId, refreshReason). Disambiguate prior matches at create time with create-report-run --refresh-of <priorRunId>; if the new report is already finalized, edit `.research-cache/<newRunId>/refresh-context.yaml` (scratch) to set refreshOfRunId, preserving the file's other keys.
- Do not invent facts, metrics, customers, funding, valuation, or dates.
- Do not edit another chapter artifact while working on the current chapter.
- Keep scratch files under .research-cache/<runId>/, never under reports/<runId>/.
- Only chapter YAMLs, report-meta.yaml, assembled final artifacts, and the script-owned .workflow-snapshot.yaml belong under reports/<runId>/. Never hand-edit .workflow-snapshot.yaml: apply-research-profile.mjs writes the selected profile before chapter work, or finalize-report writes the deep head config when no profile snapshot exists.
- Do not run any git command (git add, git commit, git push, git stash, git checkout, etc.) at any point in the workflow — including after finalize-report exits 0. Leave every generated and modified file unstaged in the working tree; the caller owns commit decisions. The only exception is when the invocation prompt explicitly instructs the agent to commit.

#### `researchRules`

- Review direct URLs with fetch-url before retaining them as evidence; do not cite generic search-result pages.
- Prefer primary, official, independent, customer, regulatory, legal, and adverse sources over summary pages.
- Record reviewed sources, atomic claims, search queries, typed research questions, and typed evidence gaps in localEvidence.
- Start source discovery with build-search-plan.mjs, use search-web.mjs for cached provider-neutral discovery, and fetch every retained direct URL with fetch-url before citation. Search results are candidates, never evidence by themselves.
- Use a search funnel: cheap broad discovery first; primary, fresh, and adverse passes second; semantic or deep search only for named unresolved gaps. On refresh runs, prioritize prior unresolved gaps and volatile facts instead of repeating the full broad pass.
- Deduplicate candidate URLs before fetch and prefer net-new registrable domains that improve source-type, independence, and stance coverage.
- Re-fetch volatile facts every run; refresh context and earlier chapters are background only for those facts.
- Treat runtimeContext.run.runDate as the ONLY source of truth for "today"; the model's training cutoff is unreliable and may be years stale. Before issuing source-discovery searches, derive any date tokens from runDate (for example its year, Month YYYY for very recent coverage, or the prior year only for explicit trailing-window queries), and never use a year you remember from training as the freshness anchor.
- Anchor volatile-fact source discovery to runDate before searching: every localEvidence.searchQueries[].query whose text matches a volatileFactQueryTokens substring (funding/ARR/headcount/customers/leadership/regulatory/launches/etc.) MUST contain the runDate year as a literal 4-digit token. For explicit trailing-window queries, it may also contain the prior year, but the prior year never replaces the runDate year. Freshness words such as latest, updated, or announced may supplement, but not replace, literal runDate-derived date tokens. localEvidence.searchQueries[] is the provenance/audit trail for queries already issued, not the search executor; the searchQueryFreshness validator audits this log after the fact as a hard gate that cannot be acknowledged away. If a lookup is genuinely historical, rephrase it so it no longer matches a volatile-fact token instead of adding a fake freshness year.

#### `chapterAuthoringRules`

- Use runtimeContext.chapter as the chapter brief and runtimeContext.chapter.gate as the binding per-chapter gate.
- Use the *Validator dimensions* section below for dimension precedence/suppressors and the inline allowed enum values in references/contracts.md for each field; trust the per-issue `fix` in check-chapter JSON output (`issues[].fix`) for concrete repair.
- Use the *Renderer contracts* section below before writing figures; substitute a table when the evidence does not fit the figure contract.
- Cite tables through table-level claimRefs, never through evidence-only columns that hold raw claim ids.
- Populate tables[].notes whenever the table contains estimates, partial coverage, computed/derived cells, or any caveat the reader needs (data-source convention, units, vintage, what null means). Leave notes null only for pure factual snapshot tables where every cell is a primary-source fact with no qualifier.
- Place each table/figure under the section whose prose introduces or relies on it via section.tableRefs / section.figureRefs (each id may appear in at most one section across the chapter). The trailing Exhibits section is a fallback for genuinely cross-cutting artifacts, not the default landing place; the unsectionedExhibits warning fires when an exhibit lacks a section home.

#### `retryPolicy`

```yaml
maxChapterRetries: 3
requireMonotonicFailureDecrease: true
```

#### `volatileFacts` (re-fetch every run; refresh context is background only for these)

- funding
- valuation
- headcount
- customer count
- pricing
- legal/regulatory status
- outages
- partnerships
- product launches

#### `volatileFactQueryTokens` (substring tokens that trigger `searchQueryFreshness`)

Any `localEvidence.searchQueries[].query` whose lowercased text contains one of these substrings is classified as a volatile-fact query and must include the chapter `runDate`'s year as a literal 4-digit token. The prior year may also appear for explicit trailing-window queries, but it does not replace the `runDate` year. The `searchQueryFreshness` validator is a hard chapter gate and cannot be acknowledged away. Edit this list (and rerun `npm run build:rules`) when you add a new volatile-fact vocabulary.

`raise`, `raised`, `round`, `series`, `seed`, `venture`, `valuation`, `valued`, `arr`, `revenue`, `growth`, `burn`, `runway`, `margin`, `headcount`, `hiring`, `layoff`, `layoffs`, `customer`, `customers`, `client`, `clients`, `partner`, `partnership`, `channel`, `reseller`, `distributor`, `pricing`, `launch`, `launches`, `released`, `roadmap`, `announce`, `announced`, `ipo`, `s-1`, `prospectus`, `lawsuit`, `litigation`, `regulator`, `regulatory`, `sanction`, `enforcement`, `breach`, `outage`, `incident`, `leadership`, `ceo`, `cfo`, `coo`, `cto`, `executive`, `acquisition`, `acquired`, `merger`

#### `finalResponseFields` (every field must appear in the final user-facing summary)

- report folder
- generated files
- source count
- claim count
- recommendation
- confidence
- risks
- valuation stance
- table count
- figure count
- finalize result
- main gaps

## Gates

Per-chapter `gate:` blocks in `workflow-config.yaml` override individual keys; un-overridden keys fall through to `defaultGate`. `check-chapter` enforces the merged gate per chapter; `check-report` enforces `reportGate` after finalization.

#### `researchProfiles`

Head/default profile: `deep`. Automation may resolve one profile into the per-report workflow snapshot before chapter work.

```yaml
deep:
  description: Full-depth diligence using the repository's default chapter and report gates.
  defaultGate: {}
  reportGate: {}
  capChapterGateOverrides: false
  clearRequiredSourceTypes: false
fast:
  description: >-
    Time-bounded diligence with a smaller evidence and exhibit set while preserving strict
    validation, adverse evidence, source diversity, and report assembly.
  defaultGate:
    minArtifacts: 4
    maxTables: 3
    maxFigures: 1
    minResearchQuestions: 8
    minQuestionTypeSpread: 3
    minLocalSources: 8
    minLocalClaims: 12
    minSourceDomains: 4
    minNetNewSources: 2
    minSourceTypeSpread: 3
    maxResearchQuestions: 10
    maxLocalSources: 12
    maxLocalClaims: 16
    depthFloor:
      minSectionBodyWords: 70
      minSectionWordsTotal: 300
      minTableRowsTotal: 10
      minFigureDataPointsTotal: 6
  reportGate:
    minDistinctDomains: 18
    minIndependentSourceShare: 0.4
    maxCompanyControlledSourceShare: 0.55
  maxPlannedTablesPerChapter: 3
  maxPlannedFiguresPerChapter: 1
  capChapterGateOverrides: true
  clearRequiredSourceTypes: true
```

#### `defaultGate` (every chapter)

```yaml
minSections: 3
maxSections: 8
minArtifacts: 6
maxTables: 8
maxFigures: 6
minResearchQuestions: 25
minQuestionTypeSpread: 4
minAdverseQuestions: 1
minLocalSources: 25
minLocalClaims: 35
minSourceDomains: 10
minNetNewSources: 8
minSourceTypeSpread: 4
minHighConfidenceCorroboration: 2
minSourcesPerEnumerationRow: 2
minQuestionAnswerRate: 0.8
minContentRequirementCoverage: 0.8
requiredSourceTypes: []
depthFloor:
  minSectionBodyWords: 100
  minSectionWordsTotal: 600
  minTableRowsTotal: 16
  minFigureDataPointsTotal: 12
```

#### `reportGate` (post-finalize, evaluated against `evidence.yaml`)

```yaml
minDistinctDomains: 30
requireAdverseSource: true
maxPaywallPercent: 0.3
minIndependentSourceShare: 0.4
maxCompanyControlledSourceShare: 0.55
crossChapterTolerances:
  metricDrift: 0.1
  keyFactOverlap: 0.7
  duplicateOverlap: 0.7
```

#### `adverseDistribution` (per-chapter `gate.minAdverseSources` is injected from this)

```yaml
requireAtLeastOneAdverseSource:
  - company-overview
  - financials
  - customers
  - valuation
warnIfChaptersWithAdverseSourceAtMost: 2
```

## ID system

Every `S/C/T/F/Q` id has the shape `<TypeLetter><ChapterLetter><Seq3>`.

- **TypeLetter** is fixed per entity kind: `S` source, `C` claim, `T` table, `F` figure, `Q` question. These letters (C, F, Q, S, T) are reserved and cannot be reused as chapter letters.
- **ChapterLetter** is the current chapter's `letter` (single uppercase A–Z, declared in workflow-config). Use **only this chapter's letter** for ids you mint inside this chapter — reusing another chapter's letter trips the `crossChapterRefLeak` gate.
- **Seq3** is a zero-padded sequence within the chapter, `001`–`999`.

Examples: `SO001` = source #1 in the chapter whose `letter: O`; `CM045` = claim #45 in the chapter whose `letter: M`.

When you need to reference a fact established in another chapter, restate it as a new local claim with this chapter's letter and its own `sourceRefs[]`; do not import the other chapter's id.

## Validator dimensions

Eight scripts emit issues/warnings tagged with these `dimension` keys: `check-chapter`, `check-cross-chapter`, `check-report-meta`, `build-evidence-ledger`, `build-report`, `check-report`, `check-revision-graph`, and `check-workflow-config`. The runtime `runtimeContext` object does NOT carry this catalog; trust the per-issue `fix` field in JSON output (and the tables below) for repair guidance.

Within `check-chapter`, fix in `precedence` order (lowest rank = root cause first); a suppressed dimension is masked while its upstream still fails, so the upstream fix usually clears the downstream too. Failure-class and warning-class chapter dimensions share one ordered list (`RETRY_PRECEDENCE`), which is why the failure table's rank column has gaps — the missing numbers are warning dimensions that show their rank in the warning-class table below. Other validators do not use precedence — fix what the message names.

`defaultFix` is the generic guidance baked into the validator; concrete failures echo the same hint with the specific field/id filled in (e.g. "Add 3 more registrable domain(s)…"). Trust the per-failure `fix` in JSON output over the generic version below.

Dimensions are grouped by class. Only the **chapter-warning** class is acknowledgeable, and even there `paywallRisk` is acknowledgeable *only* at chapter scope — its report-scope failure (from `check-report` when the consolidated restricted share crosses the 30% ceiling) is NOT ack-able and must be fixed by swapping sources. Two chapter-failure dimensions also fire at report scope from `check-report` (NOT ack-able in that context): `sourceDomains` (`reportGate.minDistinctDomains`) and `sourceStanceSpread` (`requireAdverseSource` across the consolidated ledger).

#### Chapter failure-class (numeric `precedence`, ordered root-cause first)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| 0 | `chapter-failure` | `missingArtifact` | Create the chapter YAML at the expected path. | — |
| 1 | `chapter-failure` | `yamlParse` | Fix the YAML syntax error reported in the message. | — |
| 2 | `chapter-failure` | `documentHead` | Fix the chapter document head: schemaVersion=report-v2, artifact matches the chapter key, slug, runDate=YYYY-MM-DD, company.name, and chapter.number matching the chapter order. | `yamlParse` |
| 3 | `chapter-failure` | `slugConsistency` | Set slug: to the company slug only (the report folder basename with the leading <timestamp>- stripped). | `yamlParse` |
| 4 | `chapter-failure` | `runDateConsistency` | Set runDate: to the UTC YYYY-MM-DD derived from the report folder runId timestamp prefix (use runtimeContext.run.runDate from the chapter-runtime-context loader; never format a date from the model clock). | `yamlParse`, `documentHead` |
| 5 | `chapter-failure` | `localEvidenceMissing` | Add the entire localEvidence block (researchQuestions, searchQueries, sources, claims, evidenceGaps). | — |
| 6 | `chapter-failure` | `researchQuestionShape` | Fix the question object: id Q<ChapterLetter>### (e.g. QO001), >=20-char text, valid type, non-empty targets[], valid status. | `yamlParse`, `localEvidenceMissing` |
| 7 | `chapter-failure` | `researchQuestionTargets` | Point the question.targets[] entries at a real contentRequirements/<index>, plannedTables/<slug>, or plannedFigures/<slug>. | `yamlParse`, `localEvidenceMissing` |
| 8 | `chapter-failure` | `researchQuestionTypeMix` | Add questions of types you have not used yet to reach minQuestionTypeSpread. | `yamlParse`, `localEvidenceMissing` |
| 9 | `chapter-failure` | `researchQuestionAdverse` | Add type:adverse questions until you reach minAdverseQuestions. | `yamlParse`, `localEvidenceMissing` |
| 10 | `chapter-failure` | `searchQueriesMissing` | Append the actual queries you ran into localEvidence.searchQueries[] ({query, engine, hits, retainedSourceRefs}). | `yamlParse`, `localEvidenceMissing` |
| 11 | `chapter-failure` | `sourceShape` | Fill accessStatus and stance (and other required fields) on each source. | `yamlParse`, `localEvidenceMissing` |
| 12 | `chapter-failure` | `assignedSourcePool` | Replace every cross-pool URL with a successful prefetched source from this chapter’s assigned worker pool; sibling reservations are not reusable. | — |
| 13 | `chapter-failure` | `sourceDomains` | Add sources from new registrable domains; do not duplicate publishers. Same dimension also fires at report scope (check-report) against reportGate.minDistinctDomains across the consolidated ledger. | `yamlParse`, `localEvidenceMissing` |
| 14 | `chapter-failure` | `sourceTypeSpread` | Add sources with sourceType values you have not used yet. | `yamlParse`, `localEvidenceMissing` |
| 15 | `chapter-failure` | `sourceStanceSpread` | Add at least one source with stance: adverse (regulator complaint, short report, skeptical analyst note, FT Alphaville-style critique, FOS/CFPB record). Mark a genuinely critical existing source as stance: adverse instead of inventing one. Same dimension also fires at report scope (check-report) when the entire report has no adverse-stance source; the risks chapter is the canonical owner. | `yamlParse`, `localEvidenceMissing` |
| 16 | `chapter-failure` | `sourceIndependence` | At report scope, replace company-authored sources with independent reporting, customer evidence, benchmarks, or regulatory records until both configured source-mix thresholds pass. | — |
| 17 | `chapter-failure` | `requiredSourceTypes` | Pull at least one source of each missing type listed in gate.requiredSourceTypes. | `yamlParse`, `localEvidenceMissing` |
| 18 | `chapter-failure` | `netNewSources` | Run new searches to add URLs not seen in earlier chapters; reusing the global pool will not satisfy this gate. | `yamlParse`, `localEvidenceMissing` |
| 20 | `chapter-failure` | `researchQuestions` | Add more researchQuestion entries until you hit the per-chapter floor. | `yamlParse`, `localEvidenceMissing` |
| 21 | `chapter-failure` | `sources` | Use one source ID per canonical URL. Meet the per-chapter floor with distinct relevant sources, not duplicate IDs or tracking-URL variants. | `yamlParse`, `localEvidenceMissing` |
| 22 | `chapter-failure` | `claims` | Add more claims until you hit the per-chapter floor. | `yamlParse`, `localEvidenceMissing` |
| 23 | `chapter-failure` | `claimShape` | Fix the claim object: required fields (statement, type, topic, sourceRefs, confidence, freshness), valid enum values, non-empty sourceRefs unless type is open-question, and contradictsClaimRefs when type is conflicting. | `yamlParse`, `localEvidenceMissing` |
| 24 | `chapter-failure` | `highConfidenceCorroboration` | Either downgrade confidence:high to medium, or ensure the claim has at least gate.minHighConfidenceCorroboration sourceRefs with at least one primary-tier source (filing\|regulatory\|legal\|official or reputationTier:high). | `yamlParse`, `localEvidenceMissing` |
| 25 | `chapter-failure` | `researchQuestionAnswerCoverage` | Convert questions from unresolved/partial to answered by adding the missing claim and citing it via claim.answersQuestionRefs. | `yamlParse`, `localEvidenceMissing` |
| 26 | `chapter-failure` | `researchQuestionClosure` | Add an evidenceGap whose relatedQuestionRefs[] includes the still-open question. | `yamlParse`, `localEvidenceMissing` |
| 27 | `chapter-failure` | `claimAnswerRefs` | Resolve dangling answersQuestionRefs entries; do not duplicate evidence. | `yamlParse`, `localEvidenceMissing` |
| 28 | `chapter-failure` | `claimContradictRefs` | Resolve dangling contradictsClaimRefs entries; type:conflicting requires non-empty contradictsClaimRefs. | `yamlParse`, `localEvidenceMissing` |
| 29 | `chapter-failure` | `crossChapterRefLeak` | Local C<L>### appears to come from another chapter. Chapter-letter ids cannot be reused across chapters — restate the underlying fact as a new local claim here with its own sourceRefs[]. | `yamlParse`, `localEvidenceMissing` |
| 30 | `chapter-failure` | `claimRefs` | Resolve dangling claimRefs across sections, tables, figures, and callouts. | `yamlParse`, `localEvidenceMissing` |
| 31 | `chapter-failure` | `enumerationScope` | Add enumerationScope { coverage, basis(>=20 chars) } to the matching enumeration table. | `yamlParse`, `localEvidenceMissing` |
| 32 | `chapter-failure` | `enumerationRows` | Add rows to reach expectedMinRows or set coverage to partial/sample with rationale. | `yamlParse`, `localEvidenceMissing` |
| 33 | `chapter-failure` | `enumerationCoverageGap` | Open an evidenceGap whose topic mentions the table or whose relatedTableRefs[] cites it. | `yamlParse`, `localEvidenceMissing` |
| 34 | `chapter-failure` | `enumerationTableCorroboration` | Extend the enumeration table's table-level claimRefs[] so the underlying sources span more registrable domains (table-level, not per-row). | `yamlParse`, `localEvidenceMissing` |
| 35 | `chapter-failure` | `tableShape` | Fix the table: non-empty columns, every row has the same number of cells as columns, enumerationScope { coverage, basis(>=20 chars) } when present. | `yamlParse` |
| 36 | `chapter-failure` | `figureShape` | Fix the figure data to satisfy its type contract (e.g. dag needs edges, range needs numeric low/high, matrix needs columns and rows). | `yamlParse` |
| 38 | `chapter-failure` | `duplicateIds` | Renumber the duplicate or malformed table/figure id; ids must match T<ChapterLetter>### / F<ChapterLetter>### (e.g. TO001 / FO001) and be unique within the chapter. | `yamlParse` |
| 39 | `chapter-failure` | `artifactRefs` | Resolve the dangling figureRef/tableRef: it must point at an id that exists in this chapter's figures[] / tables[]. | `yamlParse` |
| 41 | `chapter-failure` | `duplicateAnalysis` | Either give the figure at least one claimRef the table does not have (a distinct slice/lens), rename it to reflect that lens, or merge it into the table. | `yamlParse` |
| 42 | `chapter-failure` | `calloutShape` | Fix the callout: required title, body, claimRefs[], and optional calloutType in (strength\|risk\|recommendation\|insight\|assumption). | `yamlParse` |
| 43 | `chapter-failure` | `sectionsMin` | Add the missing section(s) to reach minSections. | `yamlParse` |
| 45 | `chapter-failure` | `artifactsMin` | Add the missing table or figure (or substitute a planned figure with an extra table when data shape does not fit). | `yamlParse` |
| 48 | `chapter-failure` | `depthSection` | Expand the prose of the shortest section(s) only; leave the others untouched. | `yamlParse` |
| 49 | `chapter-failure` | `depthSectionTotal` | Expand prose across short sections to reach minSectionWordsTotal. | `yamlParse` |
| 50 | `chapter-failure` | `depthTableRows` | Add rows to existing tables to reach minTableRowsTotal. | `yamlParse` |
| 51 | `chapter-failure` | `depthFigureData` | Add data points to existing figures to reach minFigureDataPointsTotal. | `yamlParse` |
| 52 | `chapter-failure` | `contentRequirementCoverage` | Add researchQuestions whose targets[] cover the un-targeted contentRequirements. | `yamlParse`, `localEvidenceMissing` |
| 53 | `chapter-failure` | `searchQueryFreshness` | For volatile-fact queries (funding/ARR/headcount/customers/leadership/regulatory/launches), plan source discovery with year/month tokens derived from runDate before searching; the runDate year is required and the prior year may only supplement explicit trailing-window searches. The searchQueryFreshness validator fails stale query logs and cannot be acknowledged away. | `yamlParse`, `localEvidenceMissing`, `documentHead`, `runDateConsistency` |

#### Chapter warning-class (numeric `precedence` shared with the failure list — fills the gaps in the failure table's rank column; eligible for `acknowledgedWarnings` at chapter scope, except `tableNotes` which has no precedence rank)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| 19 | `chapter-warning` | `paywallRisk` | At chapter scope (warning, ack-able): swap restricted (paywall\|js-only\|broken\|rate-limited) sources for ok ones to stay under the report-level 30% ceiling. At report scope (failure from check-report, NOT ack-able): the per-report restricted share already exceeds the 30% ceiling and must be brought back below it before finalize-report can pass. | `yamlParse`, `localEvidenceMissing` |
| 37 | `chapter-warning` | `figureType` | Render at least one of the planned figure types, or add an acknowledgedWarnings entry for dimension "figureType" with a >=30-char reason when the substitution is intentional. | `yamlParse` |
| 40 | `chapter-warning` | `unsectionedExhibits` | Add each table/figure to the section.tableRefs[] / section.figureRefs[] of the section that introduces or relies on it. The trailing Exhibits section is a fallback for cross-cutting artifacts, not the default landing place. Acknowledge dimension "unsectionedExhibits" only when an exhibit is intentionally orphaned. | `yamlParse` |
| 44 | `chapter-warning` | `sectionsMax` | Reduce or merge sections; the chapter looks over-fragmented. | `yamlParse` |
| 46 | `chapter-warning` | `tablesMax` | Reduce or merge tables; the chapter looks over-fragmented. | `yamlParse` |
| 47 | `chapter-warning` | `figuresMax` | Reduce or merge figures; the chapter looks over-fragmented. | `yamlParse` |
| 54 | `chapter-warning` | `unverifiedSource` | One or more cited sources have no successful fetch-url retrieval recorded for this run; retrieve usable content so accessStatus, sourceType, and stance are based on the actual page rather than a failed attempt or a guess. | — |
| 55 | `chapter-warning` | `fetchTrailMissing` | Set STARTUP_FETCH_LOG_PATH=.research-cache/<runId>/_fetch-log.jsonl in your shell BEFORE running fetch-url so check-chapter can audit cited URLs against actual retrievals; the default gate warns and --strict fails when the trail is missing. | — |
| — | `chapter-warning` | `tableNotes` | Write tables[].notes (one line: data source / estimation / partial coverage / what null means), or acknowledge dimension "tableNotes" for pure factual snapshot tables. | — |

#### Cross-chapter failure-class (`check-cross-chapter`, `precedence: —`, blocks `finalize-report`, NOT ack-able)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| — | `cross-chapter-failure` | `duplicateAnalysisCrossChapter` | Merge the duplicated artifact into the chapter that owns the topic, or sharpen one to a distinct lens. | — |
| — | `cross-chapter-failure` | `keyFactDrift` | Reference the canonical company-overview claim instead of restating the key fact as a new local claim. | — |
| — | `cross-chapter-failure` | `metricDrift` | Reconcile the conflicting metric values across chapters: pick the canonical numeric value and update the other chapters to match, or restate them as a clearly different lens so they no longer normalize to the same label. | — |
| — | `cross-chapter-failure` | `missingChapter` | Author the missing chapter file flagged in the message before re-running finalize. | — |

#### Cross-chapter warning-class (`check-cross-chapter`, `precedence: —`, non-blocking outside `--strict` and `finalize-report` does not pass `--strict`; advisory only, NOT ack-able)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| — | `cross-chapter-warning` | `duplicateLocalClaim` | (advisory; non-blocking outside --strict) Remove duplicated local claim ids across chapter ledgers; each chapter has its own C### namespace. | — |
| — | `cross-chapter-warning` | `metricDriftSmall` | (advisory; non-blocking outside --strict) Slight metric drift across chapters within tolerance; harmonize values or document the rounding source. | — |

#### Finalize-step (`check-report` / `build-evidence-ledger` / `build-report`, `precedence: —`, NOT ack-able)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| — | `finalize-step` | `reportContract` | Re-run the upstream assembler the message names (usually build-evidence-ledger.mjs then build-report.mjs) so the consolidated artifact (evidence.yaml.coverageMatrix, summary-card.sourceStats, full-report references) matches the current chapter sources. The dimension fires from check-report against shape contracts the assemblers own — fixing chapters then re-running finalize-report is usually enough. | — |
| — | `finalize-step` | `reportMetaShape` | Edit report-meta.yaml to match the report-meta shape in references/contracts.md (or summary-card.yaml when the message names that file). check-report-meta is the focused validator for this dimension; check-report and build-report also surface it when an assembler refuses to project a malformed field. Run check-report-meta directly with --format json for the per-issue fix. | — |
| — | `finalize-step` | `revisionGraph` | Do NOT hand-edit revision: in report-meta.yaml — link-refresh.mjs (run automatically by finalize-report --refresh in the prepare-refresh and link-refresh steps) writes every revision field on both runs. If the graph is inconsistent, re-run finalize-report.mjs --refresh on the affected report and let link-refresh resync; for one-off cases the message names the exact field (status / refreshOfRunId / supersededByRunId / refreshReason) that is wrong. | — |
| — | `finalize-step` | `usage` | Fix the CLI invocation per the message: pass exactly one report folder argument plus the optional flags listed in the script header (e.g. --format text\|json\|compact, --strict, --refresh). | — |
| — | `finalize-step` | `workflowConfigShape` | Edit `.agents/skills/startup-research/workflow-config.yaml` to satisfy the schema in `scripts/contracts/workflow-config.schema.mjs` (chapter count, finalArtifacts list, agentPolicy.volatileFacts / volatileFactQueryTokens / finalResponseFields, etc.). This is a meta-validator on the skill’s own config and is repo-maintainer facing — report agents do not author this file. | — |

#### Report-meta warnings (`check-report-meta`, `severity: warning` only, no opt-out)

| Precedence | Class | Dimension | Default fix | Suppressed by |
|---|---|---|---|---|
| — | `report-meta-warning` | `displayCompleteness` | Populate the report-meta field that drives the display surface (companyProfile.<field>, coverFacts items, claimRefs); when a field is genuinely unavailable, leave it null only for fields that document a null path. check-report-meta emits this only as a warning and has no acknowledgedWarnings opt-out. | — |

### `acknowledgedWarnings` opt-out

You may opt out of intentional `--strict` warnings by listing them under a top-level `acknowledgedWarnings: [{ dimension, reason }]` entry on the chapter YAML. Each entry must satisfy:

- **dimension** is one of the chapter warning-class dimensions listed above: `fetchTrailMissing`, `figureType`, `figuresMax`, `paywallRisk`, `sectionsMax`, `tableNotes`, `tablesMax`, `unsectionedExhibits`, `unverifiedSource`. (Reminder: `paywallRisk` is ack-able **only** at chapter scope — the report-scope failure cannot be acknowledged from a chapter file.) Acks against any other dimension (cross-chapter, finalize-step, report-meta warnings, the report-level instances of `paywallRisk` / `sourceDomains` / `sourceStanceSpread`, or any other failure-class dimension) surface as a non-blocking `acknowledgedWarnings` warning so the misuse is visible without breaking historical reports.
- **reason** is a string of at least 30 characters explaining why the warning is non-actionable for this chapter. Shorter reasons do not take effect and produce a non-blocking `acknowledgedWarnings` warning.

Report-meta warnings (the `displayCompleteness` non-blocking signal emitted by `check-report-meta`) and the new chapter hard-failure dimension `searchQueryFreshness` are intentionally excluded from this opt-out: `displayCompleteness` is non-blocking and never gates the report (so there is nothing to opt out of), and `searchQueryFreshness` is a hard chapter failure that must be fixed by re-planning queries against `runDate` rather than acknowledged. Listing either dimension only emits an `acknowledgedWarnings` warning.

Acks never silence a real failure; the `failures.length === 0` gate is checked unconditionally. Use this only for genuinely non-actionable warnings (e.g. `tableNotes` on a pure factual snapshot whose `defaultFix` explicitly tells you to acknowledge it).

## Renderer contracts (figures)

Every figure must satisfy the contract for its `type`. The renderer ignores extra fields and refuses to render figures whose required arrays are missing or empty. If your evidence does not fit a figure type, swap the planned figure for an extra table — the chapter `gate.minArtifacts` floor counts both.

#### Allowed figure types

```yaml
- timeline
- flow
- quadrant
- bar
- waterfall
- matrix
- stack
- pyramid
- journey-map
- funnel
- cohort
- range
- kpi
- dag
- other
```

#### Allowed `data.*` field names (across all figure types)

```yaml
- items
- nodes
- edges
- points
- columns
- rows
- series
- layers
- xAxis
- yAxis
```

#### Required field combinations per figure type

Each entry is a list of alternative requirements; a figure satisfies the contract when **every** alternative has at least one populated field. Example: `bar: [["items", "series"]]` means a bar figure must populate either `data.items` or `data.series` (or both).

```yaml
timeline:
  - - items
flow:
  - - nodes
dag:
  - - nodes
  - - edges
quadrant:
  - - points
bar:
  - - items
    - series
funnel:
  - - items
    - series
waterfall:
  - - items
range:
  - - items
matrix:
  - - columns
  - - rows
cohort:
  - - columns
  - - rows
stack:
  - - layers
    - items
pyramid:
  - - nodes
    - items
journey-map:
  - - nodes
    - items
kpi:
  - - items
    - nodes
```

#### Allowed populated `data.*` fields per figure type

Populating a field outside this list for the given type is a `figureShape` failure. `other` allows none — use it only when the data does not fit any rendered type.

```yaml
timeline:
  - items
flow:
  - nodes
  - edges
dag:
  - nodes
  - edges
quadrant:
  - points
bar:
  - items
  - series
funnel:
  - items
  - series
waterfall:
  - items
range:
  - items
matrix:
  - columns
  - rows
cohort:
  - columns
  - rows
stack:
  - layers
  - items
pyramid:
  - nodes
  - items
journey-map:
  - nodes
  - items
kpi:
  - items
  - nodes
other: []
```

For `journey-map`, `data.items[].touchpoints` or `data.nodes[].touchpoints`, when present, must be text or arrays of strings. Quote text containing `: ` or use a YAML block scalar; mappings are rejected rather than repaired at load time.
