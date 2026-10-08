---
name: translate-zh
description: "Use when: producing a Simplified Chinese zh overlay of one finalized startup diligence report, translating summary-card.yaml or full-report.yaml into summary-card.zh.yaml / full-report.zh.yaml for the website /zh/ route, repairing or extending an existing zh overlay, or fixing zh sparse-bundle / whitelist / check-translation errors. Keywords: translate report, Chinese overlay, Simplified Chinese, zh, summary-card.zh.yaml, full-report.zh.yaml, sparse bundle, whitelist, check translation."
argument-hint: "<runId-or-company-name>"
user-invocable: true
---

# translate-zh

Produce a Simplified Chinese zh overlay for one finalized report. The website's `/zh/`
route loads the overlay and falls back to the English leaf when a Chinese
leaf is missing.

## Scope

One invocation translates one report under `reports/<runId>/`. You write
exactly two siblings:

- `summary-card.zh.yaml` — list-card text and detail-page cover (~11 leaves).
- `full-report.zh.yaml` — entire detail-page body (~1500–2500 leaves).

Do not touch any files other than the two final zh siblings and the
required `.translate-cache/<runId>/` intermediates. Do not edit a
`*.zh.yaml` file directly — the applier writes it from the imported
sparse bundle.

Validation code, schemas, policies, dependency manifests and skill instructions
are read-only during a translation run. A demonstrated checker false positive
belongs in a separate repository-maintenance change with regression coverage,
not an unpublished worker patch. Report the blocker rather than inventing
attribution or weakening a gate.

In automated publication, run only the assigned per-report runner checks.
Repository-wide validation, builds and dependency installation belong to the
workflow. Its pre-worker snapshot restricts changes to the selected Chinese
outputs and binds approval to the complete English source bytes.

### Editorial-worker scope

When `STARTUP_TRANSLATION_EDITOR_WORKER=1`, you are the workflow's editor or
bounded repair worker, not the parent orchestrator. The cache and validated-draft
checkpoint already exist. Read the English source and edit only the assigned
`summary-card.translate.yaml` and existing `parts/part.NNN.yaml` files.
Do not run the commands below or any translation script, initialize or delete
caches, accept or restore a draft, or edit final overlays. Leave the environment
flag unchanged. Return after editing; the workflow owns all lifecycle commands.
The runner rejects commands in this worker mode to prevent premature cleanup.

## Start here

The parent agent must use the orchestration runner. Do not reassemble the
export/split/merge/import/apply/check chain inline.

```sh
REPORT=<runId-or-company-name>
npm run translate:zh -- preflight "$REPORT"
npm run translate:zh -- init "$REPORT"
```

After `init`, translate only these cached files:

- `.translate-cache/$RUN_ID/summary-card.translate.yaml`
- `.translate-cache/$RUN_ID/parts/part.NNN.yaml`

`summary-card.translate.yaml` is small and should be handled directly by
the parent. Its `summary.headline` is the list-card sentence; keep it as
one fluent Chinese conclusion. Keep `topStrengths`, `topRisks`, and
`unresolvedGaps` parallel within each array.

Then finalize through the runner:

```sh
npm run translate:zh -- lint-parts "$REPORT"
npm run translate:zh -- finalize-summary "$REPORT"
npm run translate:zh -- finalize-full "$REPORT"
```

Finalization runs a conservative quality gate after the structural check. It fails when a translatable leaf drops year/date anchors or explicit uncertainty qualifiers, or retains a high-confidence translationese pattern from the soundcheck. It emits advisory findings for glossary drift, untranslated ordinary descriptors, half-width Chinese punctuation, and dense `的` chains. Repair only the flagged cached leaf or part and rerun the narrow finalize command.

Calendar-date checks preserve ISO month/day anchors as well as years, accepting equivalent Chinese dates such as `2026-09-25` and `2026 年 9 月 25 日`. Fiscal-year prefixes and forecast suffixes (`FY2024`, `2024E`) normalize to the same year without allowing a changed year.
Chinese fiscal shorthand such as `FY26` can match an explicit English
`fiscal 2026` or `FY2026` only when the source leaf supplies an unambiguous
full year. The checker does not guess a century or treat calendar years as
fiscal years.
Attached labels such as `2026Q1` and `2026H1`, and escaped line breaks in chart
labels, also retain their year anchors. Quarter and half-year labels in
`Q2 ARR` or `H1 ARR` are not ARR amounts. The metric tokenizer separates these
labels from the metric; it does not establish quarter/half-year fidelity or
interpret relative periods such as `the first two quarters after IPO`.
Version-style product labels are also separated: `v0 ARR` is not `0 ARR`.
Actual zero-valued metrics still retain their numeric and currency anchors;
this separation does not validate product-name identity.
An explicit ranked label such as `top-10 ARR` can match `前 10 大客户 ARR`;
the ten is a rank cutoff, not an ARR amount. This fallback pairs each positive
integer rank with its ARR/MRR/GMV/TPV label and compares all remaining numeric
occurrences and paired month/year anchors. Changed or missing ranks and metric
labels still fail. Shared rank lists, written-number ranks, signed or bounded
quantities, explicit currency labels, unrecognized currencies and unsupported
ordering remain outside this comparison. It does not validate the ranked
population, concentration figures, or disclosure claims.
These token checks do not establish complete numeric or semantic fidelity;
verify the source proposition and metric meaning as well.

The uncertainty check accepts `未披露公开里程碑` as a faithful rendering of
`no public milestone disclosed`. Reported attribution accepts `据报道`, `据报`,
`据称`, or `报道称`; omitting it still fails.
Clause-leading `报称` and `据独立报道`, `据媒体报道`, or `据公开报道`
(including `根据` variants) also retain reported attribution. Directly negated
versions do not satisfy these additional aliases. This does not establish
publisher identity or preserve a separate assertion elsewhere in the same leaf.
A prohibition such as `no public cloud LLM API allowed` is checked separately
from missing public disclosures: Chinese must preserve the restriction, not
add an unrelated evidence gap.
Likewise, a warehouse that `has no public IP address` or warehouses that
`have no public IP addresses` lack public IP addresses; this is not a claim
that their addresses were merely undisclosed. A separate public-disclosure
gap in the same leaf must still be preserved.

## Mandatory editorial pass

Automated publication uses a second, source-anchored editorial pass after the
draft has finalized. The editor must be a separate Copilot invocation from the
draft translator. It rereads the complete English source and validated Chinese
draft, rewrites Chinese from the underlying proposition rather than the English
syntax, and is accepted only if the stricter editor gate passes.

```sh
npm run translate:zh -- editor-init "$REPORT"
# Edit summary-card.translate.yaml and every actual parts/part.NNN.yaml in place.
npm run translate:zh -- lint-parts "$REPORT"
npm run translate:zh -- finalize-summary "$REPORT" --skip-quality
npm run translate:zh -- finalize-full "$REPORT" --keep-cache --skip-quality
npm run translate:zh -- editor-accept "$REPORT"
```

`editor-init` checkpoints the already validated final overlays before seeding
the sparse cache. `editor-accept` enforces metric-token fidelity, uncertainty,
attribution, and the wider translationese soundcheck with zero hard errors.
Advisory glossary/descriptor/punctuation findings must either reach zero or
strictly decrease from the validated draft; equal or higher counts are rejected.
If the first strict check reports exact failing paths, automation performs one
bounded source-anchored repair with `gpt-5.6-sol-fast` of only those cached leaves
and validates again; the initial editor uses `gpt-5.6-luna`. These stages follow
the `translation-qa` profile's default and escalation routes respectively.
`editor-accept` writes the complete cross-artifact issue set to
`.translate-cache/<runId>/editor-findings.json`; the repair must address every
listed error rather than stopping at the first failing artifact. `--skip-quality`
is only for this intermediate materialization step: it still enforces YAML shape
and preserved fields, while publication quality remains exclusively gated by
`editor-accept`.
If that retry still cannot demonstrate semantic safety and monotonic improvement,
restore the safe draft instead of publishing a regression:

```sh
npm run translate:zh -- editor-restore "$REPORT"
```

Rollback is not publication approval. After editorial acceptance, restoration,
or a skipped editorial pass, automation checks both final artifacts with
`check-translation-quality.mjs --strict-editor`. Remaining hard findings fail
the run and block commit/push; the restored draft is retained only as a workflow
artifact. Advisory findings remain separate from hard publication failures.

Scheduled recovery translates one report per two-hour run. This keeps each draft
and editorial context bounded while still clearing a monthly backlog comfortably.
Editorial preparation skips any selected report that did not produce both final
overlays; downstream verification still fails the batch rather than publishing a
partial report.

During editing, audit the semantic head of each metric (accuracy, approval
rate, conversion, cost share, time, and count are not interchangeable), both
sides of conjunctions, and operators such as `only`, `at least`, `at most`,
`not yet`, `unproven`, and `no public evidence`. Attach dates and thresholds
to the event they modify. Never replace a detailed source claim with a generic
Chinese summary.

Resolve financial terms by their role in the sentence. In an investor's assessment,
`underwrite revenue quality`, `underwrite upside`, or an `underwriting judgment`
usually means `评估收入质量`, `把上行空间计入投资判断`, or `投资判断`, not `承销`.
Retain `承销` for securities issuance, `承保` for insurance, and appropriate
credit-assessment wording for lending. Do not use a blanket glossary replacement:
one report can discuss more than one of these activities.

Legal `dismissed with prejudice` means dismissal barring refiling of the same
claim, not bias (`有偏见`). Preserve whether dismissal was court-ordered,
voluntary or stipulated, and any exceptions for different claims or parties.
`Without prejudice` instead preserves the possibility of refiling. Neither
disposition alone proves that the court ruled on infringement or that every
underlying IP risk disappeared.
The quality gate rejects demonstrated literal forms such as `有偏见驳回` and
`带偏见撤诉` when the English explicitly describes a with-prejudice disposition,
including short table cells. Explicit English bias allegations and Chinese
explanations rejecting the literal reading remain outside this conservative
guard. Passing it does not establish that refiling rights, parties, dates or
the disposition itself were translated completely; review those separately.

Use `npm run audit:translations-zh -- --limit 20` for a non-blocking corpus sample. The audit reports hard semantic/style errors separately from advisory glossary drift, untranslated ordinary descriptors, half-width Chinese punctuation, and dense `的` chains. Use the report to target only weak leaves; do not rewrite clean overlays.

Add `--strict-editor` to include metric fidelity and the wider editorial
soundcheck. Omit `--limit` to audit the entire corpus. JSON output records
`strictEditor` so before/after counts cannot be confused across gate modes.
The audit is non-blocking in either mode: inspect `errorCount`, not just its
exit status. It checks existing overlay pairs and reports absent translations
separately as `missingOverlayPairs`; an unassessed report has `null` pass rates,
not a clean bill of health. Missing overlays retain the website's English
fallback and are not quality-gate errors. Independent factual accuracy still
requires source review.
The metric check treats `x`, `×`, and `倍` as equivalent multipliers and
compares both endpoints of multiplier and percentage ranges. Conventional
retention-relative phrases such as `NRR above 100` or `NRR trends toward low 100s`
allow an explicit `%` in Chinese; nearby customer and cohort counts do not.
English scale words (`thousand`, `million`, `billion`, `trillion`) match
`K`, `M`, `B`, `T` without changing the quantity or currency; `bps` remains
distinct from `B`. Additional normalization covers amounts with an explicit
currency symbol, such as `$20+ billion` and `€580-million`. Bare-count forms such as `30+ million` and `30-million` are not expanded here;
the scalar fallback below handles supported word-suffixed `-plus` forms.
Never strip a faithful magnitude merely to clear a token mismatch.
For an explicit currency amount, the strict checker retains `bn` as a billion
unit and can match `£65bn` with `£65B` or `£65 billion`. This bounded comparison
requires every numeric occurrence and paired month/year anchor to agree.
Signed, ranged, bounded or approximate amounts, accounting parentheses and
additional currency labels stay outside this alias fallback. It does not
infer the implicit one in `per £bn` or validate the financial proposition.
When ordinary metric tokens differ, a conservative fallback compares standalone
non-currency counts across English scale words / `K`, `M`, `B`, `T` and Arabic
numbers with `千`, `万`, `百万`, `亿`, or `万亿`, including `100 多万`. It shifts decimal
text exactly and requires the complete numeric token sets, including occurrence
counts and nearby unscaled numbers, to agree. For example, `345 million` can
match `3.45 亿`, and `per 1 million tokens` can match `每 100 万 tokens`.
Within that comparison, a full English month name followed by a year retains
both anchors: `April 2025` matches `2025 年 4 月`, but not `2025 年 5 月`.
Month and year remain paired; swapping months across two years must not pass
merely because the same numbers remain. An omitted repeated year is inferred
only when the leaf has a single unambiguous year.
Shared-unit ranges, signed counts, and monetary conversions remain outside this
fallback. It does not establish qualifier, metric-head, or physical-unit fidelity;
source comparison is still required, and existing hedge checks remain active.
The same exact-value comparison accepts comma-grouped integer counts such as
`35,000 businesses` versus `3.5 万家企业`, including beside scaled counts.
Word-suffixed counts such as `30 million-plus` and `60,000-plus` can match
`3000 万起以上` and `6 万起以上`; retain those bounds in the translation.
Currency-marked amounts, accounting-style parentheses, signed values, and
shared-unit ranges are not reinterpreted as grouped scalar counts. This fallback
compares quantities and occurrences, not the meaning of the bounds or units.
An otherwise mismatched metric set can recognize exact verbal tripling as
`3x` / `3倍`, using complete numeric occurrences and paired month/year anchors.
Existing explicit multiplier tokens that already agree are left alone.
`triple-digit`, `triple-A`, and `tripling down` are not multipliers here.
Signed, ranged, approximate, increment-based, and ambiguous `翻…倍` multiplier expressions
remain outside this fallback, as do unsupported written quantities.
Signed or accounting-style monetary amounts also keep their existing findings.
This only resolves a quantity-token mismatch; attribution and the surrounding
proposition still require source review.
Within that exact-tripling comparison, conventional title/lowercase English
month abbreviations such as `Apr 2025`, `apr. 2025`, and `Sept 2025` retain their
paired month/year anchors. All other numeric occurrences must still agree.
Wrong or omitted months, changed years and multipliers, and increment-based
`增长 3 倍` do not gain acceptance. Uppercase labels such as `APR`, URL/file
fragments, attached year suffixes and bare currency-prefix contexts stay outside
this abbreviation expansion. This is not a general date-parser expansion or a
check of which event a date qualifies.
An explicit `50/50` split can also match `各占一半` in a mismatched count
comparison. Every ratio occurrence, other numeric occurrence and paired
month/year anchor must agree; matching must not join adjacent digits, currencies
or units. Recognized negations, questions, conditional
or target ratios, bounds, signed quantities and URL fragments stay outside
this fallback. Preserve approximation and attribution separately, and review
which categories the split describes; equal numeric shares do not prove a
revenue mix or its underlying economics.
`percent` and `per cent` match `%`, including both range
endpoints. The source forms `60-percent-plus` and `60-plus percent` can match
`60%+` or `60+%` through a separate bounded comparison. It retains the exact percentage
value, each `+` bound and repeated occurrences, and compares the remaining
numeric tokens and paired month/year anchors. Missing units or bounds cannot
be cleared by another scalar fallback, even when ordinary metric tokens agree.
Identifier/URL fragments are not percentage quantities. Signed, currency-marked,
shared-range, negated or conditional percentage expressions remain outside this
alias; so do signed/accounting amounts, changed currency markers and unsupported
bound conversions elsewhere in the leaf. It does not convert other scalar counts
between English and Chinese magnitude units. This is not a general comparison of
verbal bounds or a verification of the metric's population or proposition.
Common written percentages such as `百分之十三` and `超过八成`
can resolve a mismatched numeric anchor only when the full metric-token sets
then agree; this does not validate all verbal ratios. `26-fold` and `26 倍`
retain the same multiplier. A bare
calendar year followed by `ARR` or another metric label remains a year;
repeating that year does not create another quantitative claim. Repeated
amounts and rates still retain their occurrence counts.
In a dated list, month/year notation such as `August 2015 ×2` means two
occurrences, not a `2015x` multiplier. It can match `2015 年 8 月 ×2` while
retaining the paired month/year, exact integer count, and repeated occurrences.
Signed, decimal, ranged, or suffixed counts are not reinterpreted by this rule;
neither are bare years without a month. This does not establish the underlying
filing history or general date/count fidelity.
Exact integer award occurrences such as `4× champion` or
`4× Reclame Aqui award` can match `4 次夺冠` or `4 次 Reclame Aqui 获奖`.
The fallback compares award occurrences separately and preserves every other
numeric token and paired month/year anchor. Approximate, bounded, signed,
decimal and ranged counts remain outside it; ordinary growth multipliers
still require `倍`, not `次`. Company attribution remains mandatory.
`B2B` is an identifier, not a `2B` quantity; repetition or anaphora does not
create or remove a two-billion metric. Nearby actual amounts still retain
their values and occurrence counts. These checks do not establish award
identity, issuer independence, or the truth of the recognition.
Other unit or currency conversions still require source
comparison; do not remove faithful units merely to make token-level checks pass.
For a table heading `Exit Multiple at 5.6B Entry`, an explicit dollar sign in
`以 $5.6B 入场的退出倍数` can retain the source table's currency context.
The checker accepts this specific heading form only with one dated valuation
column, nonempty entirely dollar-denominated valuation cells, and no conflicting
currency labels. Standalone text, ambiguous columns, mixed currencies, changed
amounts, and added qualifications remain outside this inference. Review the
table's assumptions separately; this does not validate its valuation or returns.
An exact fallback accepts positive dollar scalars such as `$50M` and
`5,000 万美元`, comparing all numeric occurrences and paired month/year anchors.
It shifts decimal text without floating-point rounding. Shared-unit ranges,
signed amounts, and conversion between different currencies remain outside
this fallback; qualifiers and metric meaning still require source review.
Scaled amounts with an English `dollars` suffix also retain their magnitude:
`1.5 trillion dollars` can match `1.5 万亿美元`. Explicit foreign-currency
labels and ambiguous non-US dollar contexts stay outside this additional alias.
It does not reinterpret a proper name such as `Dollar General` as a currency,
or establish that a cost estimate is an audited market size or company valuation.

To repair existing overlays one report at a time, seed the cache from the
current Chinese files instead of retranslating from English:

Review audit findings against the source before editing. Fiscal-year prefixes
(`FY2029`), URL paths, and nominal insurance terms such as `for claims modeling`
are not translation omissions or assertions. In medical-data lists such as
`clinical, claims, and operational data` or `EHRs, claims systems, and staff`,
`claims` means insurance claims, not an attributed assertion. A separate
`the company claims` in the same leaf still requires attribution. Correct a
demonstrated checker false positive with regression coverage rather than adding
unrelated attribution or changing preserved URLs merely to satisfy a pattern.
The same distinction applies to high-cost claim concentration, real-time claims
data, claims-data-driven rankings, and percentage-qualified claims cost
reductions. `claims up to 50% cost trend reduction` instead asserts a benefit;
it requires attribution and must not become `理赔成本` in Chinese. Descriptions
of IP claim quality and qualitative directional claims are not automatically
company assertions. Faithful `大体`, `尚缺`, and `厂商自述` retain qualitative
approximation, not-yet absence, and vendor attribution respectively. An unrelated
`大体` cannot stand in for a numerical approximation such as `roughly 25/50/25`;
that numeric qualifier still needs wording such as `约` or `粗略`.
Scoped absence of proof can also read `未跑通`, `尚无公开验证`, or
`尚未按 Fruitist 标准验证`. Those are not omissions of `unproven`. Keep the
negative attached to validation within the same clause; `尚未按期发布，但已验证`
does not preserve it. These phrase checks still require a source-level review
when multiple assertions or qualifiers share a leaf.
Legal and insurance workflow nouns such as `personal injury claim`, `claim setup`,
`per claim`, and `returning claim numbers` do not require invented company
attribution. Ordinary verbs such as `the company claims setup takes one day`
still do. `尚未规模化验证` retains missing scale validation, and
`未见 OCR 错误率公开第三方审计` retains an object-specific public-audit gap;
negated aliases and statements in a different clause must not satisfy either.
`requires careful claim drafting` and `composition-of-matter claims` describe
patent rights, not company assertions. Isolation claims are recognized only in
the explicit comparison with composition-of-matter claims; a separate claim
about product isolation or efficacy still requires attribution.
The `通过…来` soundcheck stays within one clause and does not treat `来自` as a
purpose marker; a separate genuine `通过…来` construction still needs rewriting.
Likewise, `正在…集中` is not the redundant `正在…中` construction, and that
soundcheck must not cross a clause boundary. `推算` preserves an estimate;
`尚未在规模上得到验证` preserves an unproven-at-scale qualifier. Missing-public-
evidence wording includes `未找到公开`, `没有找到公开`, `未发现针对…的公开`, and
`公开证据尚未…`; positive disclosures must still fail. `fraud claim handling` and
`government guarantee claim status` are financial claims nouns, not assertions.
`声明` and `公司口径` can preserve an assertion, but a separate company assertion
beside a financial claims noun still needs attribution.
For a source label beginning `Company campaign claim`, clause-leading
`公司活动口径` retains the company attribution. A negated attribution, a different
issuer or a separate assertion in the same leaf must not be cleared by it.
`网站口径` and an attributed `反方观点` can also preserve a claim. Insurance
coverage limits and claims history refer to insurance, not assertions.
`at most recent fiscal quarter-end` names the latest period, not an upper bound;
a separate `at most` quantity in the same leaf still needs its upper bound.
Likewise, `at most confirmed sites` or `at most RIAs` means at the majority of
those locations or firms, not a numeric cap. Keep any separate upper-bound quantity. Percentage-qualified
`payer denials documented in >20% of claims` describes insurance claims, not
a company assertion; a separate company assertion still needs attribution.
Do not mistake `来源` or `带来` for the purpose marker in `通过…来`, or a
locative phrase such as `正在生产环境中部署` for clause-final `正在…中`.
`通过…转来的顾问` contains the modifier `转来的`, not a purpose marker.
Genuine purpose constructions such as `通过资金周转来改善现金流` or a second
`通过…来…` in the same leaf still require rewriting.
Public-evidence gaps can place a Latin company name or a carrier relationship
before `公开`; `公开材料没有…` and `公开来源无法…` can retain a negative finding.
`没有披露任何公开…` and `没有可验证的公开…` also retain scoped evidence gaps;
negated wording or an absence in another clause must not satisfy them.
`customer compensation claims` means customer compensation demands, not a
company assertion; a separate assertion still needs attribution. The soundcheck
does not mistake `在买方面前` for the `在…方面` construction.
Evidence gaps also accept `公开渠道没有…`, `未提及公开…`,
`公开披露未…`, `未披露任何公开…`, `公开层面没有…`, and
`公开资料不显示…`; negation and clause boundaries still matter.
Billing-documentation claim validation and claims-denial reduction data refer
to insurance workflows. `not marketing claims` denies a marketing assertion;
neither phrase removes the need to attribute a separate company assertion.
`公司披露的汇总口径` retains company attribution for aggregate figures.
Insurance noun contexts such as `across claims intake`, `a claims platform`,
`claim type`, and hyphenated `claims-processing` do not require invented
attribution. Recognition is context-specific: an explicit assertion such as
`the company claims automation improves retention` still needs attribution,
including when the same leaf also describes insurance workflows.
`还不足以证明` retains insufficient proof. `没有发现 G2 或 Capterra 上的公开…`
retains a review-site evidence gap; negated wording or a gap in another clause
must not satisfy either check.
The `在…层面` soundcheck does not cross a comma or colon: `风险在于，公开控制仍是政策层面的`
is not that construction. A genuine `在政策层面` in another clause still needs
rewriting.
Descriptor checks preserve a relative route such as `/platform` only when the
same route appears in the English leaf. A separate untranslated `platform` or
`product` still produces an advisory. Price denominators such as
`$100 /enterprise/year` are not URL paths and still need translation.
Do not translate or invent actual URL paths.
`预估` can retain an estimate, and `预计` can express a likely outcome or
inferred financial condition. Negated forms do not establish preservation.
Review the proposition: these aliases do not validate the metric, time basis,
or a separate omitted attribution or evidence gap in the same leaf.
`还看不到证明` retains `not yet the proof`; a negated or positive-proof
statement does not.
`未见任何公开` retains a scoped public-evidence gap; an unrelated absence or
negation does not.
Medical billing phrases such as `API-based claim creation, claim submission`
and dollar-qualified annual claims volume describe workflows or processed
amounts, not assertions. A separate `claims accuracy is superior`, an
`NDR claim`, or `claimed scale` still requires attribution. A workflow-list
exemption must not swallow an adjacent assertion.
`未经证明` retains `unproven`, and `未发现 Candid 公开…` can retain a scoped
public-evidence gap. `潜在进入者` can render the entrant category `likely entrants`;
it cannot replace a separate `likely` or `probably` in the same source leaf.
Metric definitions also need source review: a vendor's touchless metric may
cover submission through finalization without human intervention, whereas a
clean-claim metric may measure passing the first claim edits without manual
intervention. Neither means payer approval or payment. Render `manual touch`
as manual intervention, not a physical touchpoint, in these billing workflows.

`没有…的公开证据` and `未见…的公开证据` retain a single `no public evidence`
gap within one clause. `公开证据不足以支撑` can retain `no public evidence supports`;
it does not stand in for an unrelated missing disclosure. Negated forms,
cross-clause matches, and additional public-evidence gaps must not be cleared
by these alternatives. Warranty-claim histories, rates, service requests and
compensation demands are nouns, not company assertions; a separate assertion
about warranty coverage or product performance still requires attribution.
Requests for `claims frequency` and hyphenated `warranty-claim rate` or history
likewise describe claim activity, not company assertions. Check the metric
separately: claim frequency is not a payout ratio.
`claims-reduction proof` and the outcome-list phrase `reduced claims, safer driving`
refer to claim activity, not a company assertion. Keep the proof requirement and
the complete outcome proposition; a separate `the company claims`, including
`claims reduced costs` or `claims a reduction`, still requires attribution.
Likewise, `gross profit` is a monetary amount (`毛利` or `毛利润`), not
`gross margin` (`毛利率`). The strict editor rejects demonstrated amount-to-rate
substitutions, including short figure labels. Leaves that also name a margin or
explicit ratio/percentage remain outside that conservative guard; compare their
complete propositions manually. A clean numeric-token check does not establish
metric-head fidelity.
The standalone label `Gross profit after risk margin` explicitly names a rate
and may read `扣除风险成本后的毛利率`. Without `margin`, the same risk-adjusted
profit is still an amount. This label exception does not clear a separate
gross-profit amount in the same leaf or validate the underlying bank ratios.
`claims in this table are minted locally` describes this report's evidence
ledger, not a company assertion; a separate company claim still needs attribution.
The same holds for `using locally minted claims rather than copied claim ids`:
these are evidence statements and their identifiers. A separate company assertion
or public-disclosure gap remains subject to its own check.
Likewise, scores `synthesized from the cited claims` refer to cited evidence,
not a new company assertion. `章节证据中未收录公开…` retains a single
`no public … retained in chapter evidence` gap; it does not prove that no public
material exists. Separate assertions and disclosure gaps still need preservation.
`公开证据缺失` can retain a single `no public evidence` gap. Negated predicates
and additional disclosure gaps must not be cleared by that wording. These
qualifier checks do not establish that every object or proposition was preserved.
`公开信息不足以` (also `公开资料`, `公开证据`, or `公开依据`) can preserve
`no public basis`; it cannot substitute for another missing public disclosure.
`还无法完全看清` or `仍无法完全看清` can retain `not yet fully transparent`,
but not a separate `not yet` claim. Direct negations of these aliases do not
preserve the gap. `public-claim dispersion` describes variation among public
statements, not an assertion by a company; a separate company assertion still
requires attribution.
Coverage lists containing claim procedures, claim triggers, or claims history
refer to insurance processes, not assertions; separate company claims still
require attribution. `公司披露的增长口径` and `管理层口径` retain attribution.
`未提交公开…` can preserve an explicit public-filing gap, and `未确认公开…`
can preserve an explicit confirmation gap. Neither is a blanket substitute
for absent public information. `暂无…数据` can retain `not yet available`,
but does not establish another negative proposition such as lack of profit.
Negated wording and a filing or confirmation in a different clause do not
satisfy these aliases.
`仍无法从公开材料中衡量` can retain a single `not yet publicly measurable`
gap; negation, unrelated gaps and additional `not yet` clauses still fail.
A rejected formulation such as `rather than a single "market size is X" claim`
is not a company assertion. A separate company claim still requires attribution.
For a search that `returns no public filings`, `没有检索到 … 的公开文件`
or `未检索到 … 的公开申报文件` retains the search-result gap. It does not
establish that no filings exist. Negation, clause boundaries and additional
public-disclosure gaps remain distinct; this check does not verify the search
itself or the underlying English assertion.
For `no public repositories attributable to` a company, `没有可归因于…的公开代码库`
retains the repository-attribution gap. Negation, clause boundaries and a separate
public-disclosure gap still matter. Product-liability claims are legal demands,
not company assertions; a separate assertion in the same leaf still needs attribution.
`仍缺公开…证明` or `尚缺公开…证据` can retain a single missing-public-proof
finding; negated wording and a separate disclosure gap still fail. A clause-ending
`insurance and customer claims` list refers to legal demands, not a company
assertion. Separate assertions still require attribution.
`尚未得到证明` (also `验证` or `证实`) can retain a single unproven predicate.
For an explicit `no public announcement` gap, `没有…的公开公告` or
`未见…的公开公告` retains the missing announcement, not absence of the event.
Negated wording, clause boundaries and additional gaps remain separate.
`还谈不上便宜` can preserve a single `not yet cheap` qualification.
`公开市场上没有…报告` can preserve a single explicit public-market-report gap;
neither alias can stand in for another missing predicate. `can claim every
BaaS or DBaaS dollar` describes capturing market spending, not making an
assertion; `rather than a single expansive TAM claim` rejects a sizing shortcut.
A separate company assertion still requires attribution.
Consumer-protection claims and hyphenated counter-claims describe legal demands,
not a separate company assertion. `evidence does not support a clear positive claim`
is a negative assessment, not a positive company claim. Separate assertions still
need attribution. `关税影响论断基于` can retain one explicitly source-based tariff
assertion; it cannot clear another claim in the leaf. `缺少公开基准` can preserve
one explicit `no public benchmark` gap. Negation, clause boundaries and separate
public-disclosure gaps remain distinct.
Likewise, `arbitration claims against` a party are arbitration demands, while
`non-competition and non-solicitation claims against` a party are legal demands.
Neither is a company assertion. A separate company or arbitration-provider
assertion still requires attribution.
Copyright demands that impose costs or are resolved against a party,
surviving docket claims, and rights-claim cases describe legal matters.
Claim-governance and claim-review processes are workflows. In an explicit
YouTube rights context, false or duplicate claims and `claim and monetize UGC`
concern rights management, not company assertions. A separate assertion still
requires attribution. A dispute resolved in a party's favor is not necessarily
a court victory; an adverse resolution need not be a merits judgment.
In `customer validates fabric claim`, `客户在…验证面料承诺` retains the
customer's testing of a fabric promise. This scoped rendering cannot satisfy
a separate company assertion, a negated test, or a different claim; it does not
establish that the promised performance was actually achieved.
`public evidence can support the claim that` introduces an evidence-based judgment,
not necessarily a company assertion. A separate company claim still needs attribution.
`公开市场上没有独立的校园招聘…TAM` can retain the explicit standalone
campus-recruiting TAM gap, and `没有按…公开分层` can retain a public-segmentation
gap. These scoped alternatives do not clear negation, cross-clause matches or
additional public-disclosure gaps in the same leaf.
Indemnity `for narrow claim classes` concerns categories of legal demands, not
a company assertion. A separate company claim still needs attribution.
`未按零售子垂直或区域公开收入档位拆分` and
`未按电信 / 媒体账户公开合同规模或续约数据` retain their respective
public-segmentation gaps. These scoped aliases do not accept a different missing
predicate, negation, another disclosure gap, or merely late publication (`未按期`).
`没有关于…的公开数据` or `未见关于…的公开数据` can retain one explicit
`no public data on` gap. Negated wording, cross-clause matches and additional
public-disclosure gaps remain distinct; this does not verify the data's subject.
For the explicit revenue/user-count/repeat-purchase segmentation gap,
`未按细分披露公开收入、用户数或复购情况` preserves the absence of that breakdown.
It cannot clear a negated statement, merely late publication, a different
missing disclosure, or an additional public-disclosure gap.

For `no public signal`, `没有…的公开信号` retains a single signal gap,
not absence of the underlying event. A requirement for `no public filing of
accounts` means public filing is not required; it is neither a filing ban nor
proof that no accounts were filed. `No public sources can substitute for
data-room access` denies substitutability, not the existence of public sources.
Financial `no public comparables at scale` refers to missing same-scale listed
peers, not merely undisclosed company information. Each predicate is checked
separately; negation and another missing disclosure must not be cleared by it.
Nominal `for NPE claims` / `handles NPE claims` contexts and a docket-count
observation that additional claims may follow describe legal demands, not
company assertions. `The NPE claims, …` remains an assertion, including with
a parenthetical clause; separate assertions still require attribution.
`未见…的公开引用` can retain a single
`no public reference` gap; it does not establish that the underlying audit or
event never occurred. Negation and other disclosure gaps remain separate.
The `在…方面` soundcheck distinguishes a later clause-leading
`一方面…另一方面…` comparison after a comma or colon from that construction.
Actual aspect phrases, including comma-separated lists and `在某一方面`,
remain subject to the soundcheck.
Reviewed-source confirmation gaps can read `已审阅公开来源均未确认`, including
a bounded publisher-list apposition. `未按…公开基准` can retain an explicit
benchmark-by-dimension gap, but not merely late publication. Negation and a
separate public-disclosure gap remain distinct. A procurement diagram described
as `not a claim that every customer follows the exact same procurement sequence`
is a disclaimer, not a company assertion. Its Chinese must still disclaim a
universal sequence; reversing it or omitting a separate assertion fails.
Likewise, `not a claim that the company has already earned public-market software
multiples on disclosed fundamentals` is a valuation disclaimer, not a company
assertion. Retain the denial and its disclosed-fundamentals basis; a positive
claim, negated disclaimer, different basis or separate omitted assertion still
fails. This scoped check does not establish that the valuation itself is sound.
The reviewed inference-only, universal LPU/NVIDIA-path and financing-mark
disclaimers are likewise not positive company assertions. Their scope and
negative predicates must remain intact; a financing mark establishes neither
fairness, a post-money basis, investor returns nor confirmed cash availability.
Cash arrival alone is not cash availability. Reversed or negated disclaimers,
different predicates and separate omitted company assertions still fail.
Source-identical `Tiger Global Management` and `IBM (watsonx Orchestrate)` are
proper names, not untranslated descriptors. Ordinary text beside those names,
such as `platform`, and `Pricing Guide` beside a publisher still needs translation.
`Continuity of historical shareholder claims` concerns shareholder rights,
not a company assertion. A shareholder who `claims` a return or a separate
company assertion still requires attribution.
Bank leverage `excluding claims on central banks` or `excluding central-bank
claims` concerns assets, not assertions. Preserve the exclusion and the asset
counterparty; a separate company or central-bank assertion still needs attribution.
For an explicit retained-material gap, `未留存公开…` preserves
`no public … retained`; it does not assert that no public material exists.
`保留的…材料没有出现公开…` likewise retains a price's absence from the
reviewed materials, not universal unavailability. Negation, retention prohibitions,
clause boundaries and additional disclosure gaps remain separate.
`目前还无法量化` can retain one `not yet quantifiable` predicate, not a different
missing condition. The industrial-vertical customer-count/ACV and health-system
account-data gaps can retain their scoped `没有按…披露公开…` and `没有…的公开…数据`
forms; merely late publication and other missing disclosures remain distinct.
Hyphenated warranty-claim disclosures concern warranty demands, not company
assertions. An evidence-ledger `claim evidence` reference and an `absence claims`
disclaimer need not invent company attribution. The reviewed alternatives retain
the distinction between qualitative positions and statistical probabilities, and
between missing public evidence and proof that private controls do not exist.
Reversed predicates and a separate company assertion still fail these alternatives.
These checks retain the existing long-prose/table/figure-note applicability;
they do not add general semantic checking of short labels or certify source facts.

```sh
npm run audit:translations-zh -- --report <run-id> --format json
npm run translate:zh -- repair-init <run-id>
```

`repair-init` writes `quality.before.json`, prints the blocking target paths,
and builds the sparse cache from the current English shape, seeding matching
paths with existing Chinese text. New prose leaves remain editable even when
their older Chinese value was numeric-only; current mechanical cells instead
come from English during application. Newly added prose without an existing
translation starts in English and must be translated. Edit only the
flagged leaves, then finalize with `--keep-cache` and measure the delta:

Finalization retains an existing literal `—`, `–`, or `-` at a whitelisted
blank-string source field. These are display placeholders, not new data, and
remain outside the editable sparse bundle. Other old text in blank fields,
nulls, non-translatable fields, and nonblank mechanical values still follow
the current English source.

```sh
npm run translate:zh -- lint-parts <run-id>
npm run translate:zh -- finalize-summary <run-id>
npm run translate:zh -- finalize-full <run-id> --keep-cache
npm run translate:zh -- measure <run-id>
npm run translate:zh -- cleanup <run-id>
```

`repair-init` and `measure` use the standard gate. For a strict-quality repair,
also save `audit:translations-zh -- --report <run-id> --strict-editor --format json`
before and after editing; a standard `0 -> 0` does not measure strict improvements.

The measurement is saved as `quality.after.json` and reports error/warning
counts against the repair baseline. Process only one report at a time so each
quality change remains attributable and reversible.

### Batching reviewed repairs

For multiple existing reports, the runner can apply source-reviewed patches
sequentially, retaining per-report checks and results:

```sh
npm run translate:zh -- repair-batch reviewed-fixes.json
npm run translate:zh -- repair-batch reviewed-fixes.json --apply
```

The JSON has `reports: [{ runId, changes: [{ artifact, path, english, before,
after }] }]`. `artifact` is `summary-card` or `full-report`; `path` is the
slash-separated whitelisted leaf path. `english` and `before` must exactly match
the current English and Chinese strings. `after` is a reviewed translation,
not an instruction to a model. The command does not invent fixes or verify the
underlying English facts.

Preview writes nothing. Apply refuses existing caches, seeds sparse bundles,
edits only the listed leaves, and runs the existing lint/finalize/verify/measure
commands without skipping quality gates. Standard hard errors must reach zero,
and strict findings must not increase or move to new paths. Baseline strict
findings can remain; an applied patch is not a whole-report quality certificate.
Final parsed overlays must exactly match the approved changes, and all other
report YAML stays byte-identical. A failed report restores only outputs written
by that attempt, does not overwrite detected later edits, retains its cache
for inspection, and does not prevent the next report from running. Any blocked
report makes the batch exit nonzero.

Review `.translate-cache/<runId>/batch-result.json` and `batch.log`, then run
one integrated `npm run validate` for the accepted batch before publication.
Archive the per-report evidence before using the runner's `cleanup` command.

For low-cost model routing, use `gemini-3.8-flash` for summary and long-form
full-report drafts, then use `gpt-6-luna` for compact table/figure leaves
where brevity matters. Run deterministic QA after translation and route only
meaning-sensitive or still-awkward leaves to `gpt-5.6-luna`; reserve
`gpt-5.6-sol-fast` for unresolved semantic conflicts. Keep
`gemini-3.5-flash` for search planning and evidence extraction, where its
lower-cost output is easier to verify. The shared policy is in
`../startup-research/references/model-routing.yaml`.

If both zh siblings already exist and no repair is requested, do not rewrite
them; run:

```sh
npm run translate:zh -- verify "$REPORT"
```

When a finalized English report is superseded by a refresh,
`link-refresh.mjs` automatically runs `sync-preserved-fields.mjs` on the
previous report. The synchronizer copies the current English shape and every
non-translatable leaf into existing zh overlays while retaining whitelisted
Chinese text. Use `npm run sync:translations-zh` only to repair historical
overlay drift across the corpus.

`run-translation.mjs` owns preflight, cache paths, sparse export,
splitting, part linting, merge/import/apply/check, and successful cache
cleanup. Final deliverables are only `reports/$RUN_ID/summary-card.zh.yaml` and
`reports/$RUN_ID/full-report.zh.yaml`.

If finalization fails, repair only the offending cached leaf or part,
then rerun the narrowest finalize command. Re-run `init` only when the
cache is structurally corrupted; it refuses to overwrite a non-empty
cache unless `--force` is supplied.

Run `lint-parts` after all `parts/part.NNN.yaml` files have been
translated and before `finalize-full`. It parses every part, verifies the
manifest leaf count, and compares each part's string-leaf paths with the
source bundle so shape drift is caught before any final zh file is
written.

## Subagent contract

Spawn each translation subagent with this prompt, substituting only the
target path:

```
You are translating one part of a Chinese diligence-report overlay.

TARGET (read/write): <workspaceRoot>/.translate-cache/<runId>/parts/part.<NNN>.yaml

Workflow:
1. Read the TARGET file in full.
2. Apply the per-leaf process from .agents/skills/translate-zh/SKILL.md
   (read-through → draft → cover-English revision → final write).
3. Update TARGET in place. Same keys, same array length and order.
   Translate every non-null string value. Leave `null` as `null`.
   Do not add or drop keys. Do not change YAML shape.

Structural guardrails:
- `null` is an index placeholder, not a translation task. Never replace it
  with guessed text, and never write the string `"null"` unless the source
  leaf itself is the string `"null"`.
- Translate table cells cell-by-cell from the source text. Do not fill an
  empty-looking cell from neighboring rows, column expectations, or domain
  knowledge.
- When a block scalar such as `notes: >-` is followed by the next table or
  figure item, keep the next `- title:` aligned with its sibling list item;
  do not indent it under `notes`.
- Preserve `- text: null`, `- label: null`, and similar sparse placeholders
  exactly as `null`.

Hard constraints — do NOT:
- run `node`, `npm`, or any other command;
- invoke any script under `.agents/skills/translate-zh/scripts/`
  (those belong to the parent);
- write anywhere except the single TARGET path (no `/tmp`, no extra
  `.json` files);
- touch the English source under `reports/<runId>/`;
- read or modify any other `parts/part.*.yaml`;
- fetch URLs or invent facts.

Return when TARGET has been updated in place. The parent merges all parts.
```

## Authoritative whitelist

`scripts/whitelist.mjs` is the single source of truth for which leaves
are translatable. The exporter only emits whitelisted paths; the applier
silently drops anything else; the validator byte-compares everything else.
If a new visible-text path appears (new figure shape, new section), stop
and report the whitelist gap. Whitelist changes are repo-development
work, not part of a report translation run.

The corpus translation-check cache is keyed by the batch checker, per-folder
checker and whitelist source bytes as well as report bytes and validation flags.
Changes to those rules must recheck previously cached reports; a cached pass is
not evidence that newly translatable fields have been translated.

Use `references/glossary.zh.yaml` for recurring terms. Do not edit the
glossary during a report translation; if a recurring term is missing,
pick one consistent rendering within the cache and mention the glossary
gap after the overlay is complete.

## Invariants — must not change

1. Schema shape: keys, key order, array length, array order. Address
   list items by index — never reorder, merge, or split.
2. IDs, refs, slugs, URLs, dates, enums, numerics, `schemaVersion`,
   `artifact` stay byte-identical to English.
3. Proper nouns (companies, products, models, SKUs) keep Latin spelling.
   Never add a parenthetical Chinese alias (`OpenAI（开放人工智能）` — never).
4. Source titles, publishers, and `keyQuote` text are excluded by the
   whitelist; they stay in the original publication's language.
5. No new facts. No hedging shift. `may` is not `将`. `fails to` is not
   `尚未`. `roughly`, `at least`, `reportedly`, `only when`, `unless`,
   `provided that` survive at the same strength.
6. Punctuation: 全角 inside Chinese sentences (`，。；：？！「」`).
   Half-width with one space on each side around embedded English tokens
   and numbers: `ARR 增长 80%，由 Microsoft Azure 渠道贡献`.

## Translation philosophy — re-author, not translate

The English file is the source of facts, not of sentence shape. Read the
whole leaf, then write Chinese the way an investment analyst at 晚点
LatePost / 海外独角兽 / 远川研究所 would write it from scratch. If your
draft mirrors English clause order, rewrite the whole sentence — patching
words never removes 翻译腔.

Self-check: *could an experienced Chinese analyst have written this from
scratch, without ever seeing the English?*

### Sentence shape — apply before drafting

- Time, place, condition lead. `Y is true when X` → `X 之后，Y`.
  Never `Y，当 X 时`.
- Topic to the front; drop `对……来说`. `For thin AppSec teams, manual
  reproduction is the bottleneck` → `AppSec 团队人手紧，手工复现就是瓶颈`.
- Long noun phrases become short verb clauses. Three or more `的` in a
  row is a smell — flatten to a verb or split.
- Split long sentences. A 30-word English sentence with two relative
  clauses becomes 2–3 short Chinese clauses joined by `，` `；` `——` or
  a period. Subordination is English; Chinese is parataxis.
- Use concrete verbs (`落地 / 拼出 / 卡住 / 砸钱 / 吃掉 / 跑通 / 挤压 /
  撬动 / 顶住 / 守住 / 打穿`) over `实现 / 进行 / 做出 / 完成 / 形成`.
  Collapse `进行 / 做出 + 名词` (`做出决策` → `决定`; `进行验证` → `验证`).
- Active over passive.

### Tone

Investor-memo register: confident, concise, analytical, dense with verbs
and numbers. Avoid 学术腔 / 公文味 / 营销文案腔 (`市场进入策略`、
`相关性分析`、`形成竞争优势`).

Length parity, not character parity. A natural Chinese sentence is
shorter than its English source. If your draft is dramatically longer,
you over-translated qualifiers (`approximately`, `essentially`,
`in the context of`, `in order to`, `with respect to`) — cut them.
Specificity (numbers, names, dates, mechanisms, direct quotes) stays
intact.

### Anti-patterns — rewrite the sentence, do not patch

| Anti-pattern | Rewrite toward |
|---|---|
| 长定语堆砌：`一个针对……的、能够……的、并且……的产品` | 短句串联：`一个产品。它针对……、能够……，也……` |
| 段首 `对……来说 / 对于……而言` | 主语前置：`团队需要……` |
| `通过…… 来 ……` | `靠 / 借助 / 凭 / 用` + 动词，或直接动宾 |
| `在 …… 的过程中 / 在 …… 上` | 删除，或用 `时 / 中 / 里` 一字带过 |
| 被动逐字：`被设计为 / 被要求 / 被使用` | 主动：`团队设计成……`、`监管要求……` |
| `A 和 B 和 C` 串列 | 顿号：`A、B、C`；必要时加 `等` 收束 |
| `正在 …… 中` | 直接动词：`公司在调整` |
| 跨句用 `这 / 这一 / 这些` 指代 | 重复关键名词，或 `上述 / 该` |
| `做出……决策 / 进行……尝试` | 直接动词：`决定 / 尝试` |
| `随着…… 的 ……` | `当…… / 一旦…… / ……之后` |
| 数字前后 `约……的……的……` | `约 X` 后接动词，避免 `的` 连用 |
| `是一个……的……` | 判断句 `X 就是 Y`，或拆为两句 |
| 段段 `这意味着…… / 这表明……` | `因此 / 也就是说 / 反过来 / 换句话说`，或直接给结论 |
| `相关 / 相应 / 对应 / 该等 / 此项 / 之` | 删掉或换具体名词 |
| 同义堆叠：`努力和尝试 / 机会与可能` | 取一个 |
| `此外，/ 然而，/ 而且，` 机械直译 | 删掉，让句子自己接续 |
| `公司称其预期…… / 公司表示其将……` | 合一：`公司预期……` |

### Worked example

- Source: *"OpenAI's product experience depends on model availability, API/tool orchestration, SDK integration, and trust controls; partner channels add deployment reach but also opacity."*
- Stiff: `OpenAI 的产品体验依赖于模型可用性、API/工具编排、SDK 集成和信任控制；合作伙伴渠道增加了部署触达，但也带来了不透明度。`
- Native: `OpenAI 的产品体验靠几样东西撑着：模型够稳、API 和工具编排能跑、SDK 接得上、信任控制守得住；合作伙伴渠道把部署做远了，但也把这条链做模糊了。`

The fix: pivot `依赖于 + 名词串` to `靠几样东西撑着` plus short verb
clauses; turn the abstract noun `信任控制` into the action `守得住`.

### Soundcheck — mental grep your draft

If any of these survive, the leaf is not done:

- 三个 `的` 连用。
- 段首 `对……来说`、`对于……而言`、`关于……方面`、`随着……`、
  `通过……来……`、`在……的过程中`、`在……方面`。
- 空动词 + 名词：`做出决定`、`进行尝试`、`产生影响`、`实现增长`。
- 被动逐字：`被设计为`、`被要求`、`被认为是`、`被使用`。
- 段段 `这 / 这一 / 这些` 指代上文。
- 公文词：`相关 / 相应 / 对应 / 该等 / 此项 / 之`。
- `正在……中`。
- 同义堆叠：`努力和尝试`、`机会与可能`。
- 段段 `此外，/ 然而，/ 而且，`。

## Per-leaf process

For every prose leaf and every multi-word table cell:

1. **Read the part end-to-end first.** Lock recurring terms, proper
   nouns, and acronyms so the same English term gets the same Chinese
   form throughout the file. Mark mechanical leaves (numbers, currency,
   dates, IDs, mermaid blocks) — copy them verbatim. `$60M` is `$60M`,
   never `6 万美元`.
2. **Draft** using the sentence-shape rules above. Note hedges
   (`may`, `likely`, `roughly`, `at least`, `reportedly`, `estimated`)
   and constraints (`only when`, `unless`, `provided that`) — they must
   survive at the same strength.
3. **Cover the English. Read the Chinese alone.** Walk the soundcheck
   and the anti-pattern table. Rewrite any sentence that makes you
   pause **as a whole sentence**, not word-by-word.
4. **Re-open the English.** Confirm no fact, number, hedge, or
   qualifier was lost, strengthened, softened, or invented.
5. **Save in place** to the bundle (`*.translate.yaml`) or your
  assigned `parts/part.NNN.yaml`. The applier writes `*.zh.yaml` from
  the imported bundle — never edit it directly. The runner's finalize
  commands perform the final strict translation checks.

## Table cells

Standalone mechanical placeholders `unknown`, `none`, and `tbd` stay unchanged
in report YAML and sparse bundles. Table and matrix/cohort cell renderers display
them as `未知`, `无`, and `待定` in Chinese, including cell qualifications and
tooltips. English spelling, larger prose strings, `n/a`, numbers and source
metadata remain unchanged; `n/a` is not assumed to mean either not applicable or
not available. Check the rendered cells rather than editing protected values.

Most leaves in `full-report.yaml` come from `tables/[]/rows/[]/[]` —
short cells, not sentences. They follow stricter rules than prose:

- **Pure numbers / units / currency / percent / dates / IDs**: do not
  translate. "$2.6T–$4.4T", "13.8", "2024", "n/a", "—", "null", "T+1"
  all stay verbatim. Currency symbols stay too — write "$852B", not
  "8520 亿美元", inside a table cell, even though the prose convention
  is the opposite. Cells must align across rows; a column that is
  numeric in 9 rows and prose in 1 row should keep the same form.
- **Single-word status / level / enum-like values**: translate to a
  consistent short term and reuse it across rows. "High / Medium /
  Low" → "高 / 中 / 低". "Yes / No" → "是 / 否". "Confirming /
  Adverse / Neutral" → "证实 / 反向 / 中性". Pick one rendering per
  column and stick to it; do not vary by row.
- **Phrase cells (2–10 words)**: translate as natural Chinese noun
  phrases. Drop articles ("the", "a") and reorder modifiers as
  needed. Keep proper nouns in Latin spelling.
- **Mixed proper nouns + descriptive English**: keep the proper noun,
  translate the ordinary descriptor. Do not leave a whole cell in English
  just because one token is a company, product, API, or market acronym.
  "U.S. enterprise sample" → "美国企业样本"; "Global retail/CPG" →
  "全球零售 / CPG"; "API platform / Responses API" →
  "API 平台 / Responses API".
- **Sentence cells**: apply the prose translation philosophy above.
- **Cells that are mostly proper nouns + a small connector**: keep
  the proper nouns and translate only the connector. "Microsoft &
  Azure" → "Microsoft 与 Azure".
- **Pure model / version / SKU lists**: keep Latin tokens and normalize
  separators if useful. "GPT-5.x, GPT-4.1, o1, GPT-4o" →
  "GPT-5.x、GPT-4.1、o1、GPT-4o" is acceptable because every token is a
  model/version name.

## Figures

Figures (`figures/[]`) are charts. The renderer reads everything from
`figure.data.{items,nodes,edges,points,columns,rows,series,layers,xAxis,yAxis}`,
not from top-level keys, so reader-visible chart text is two layers
deep. Translate every reader-facing string under `data/`; leave
identifiers, enums, refs, and numerics alone.
Generated item names, dependency roles, and loading/error
messages follow the website locale. Do not rewrite authored labels or structural
keys such as `input`, `impact`, `total`, or `subtotal` to translate this UI.
Publication checks must exercise the hydrated charts and their hover/tap
tooltips in a browser. Raw `script.figure-chart-data` payloads are not proof
that a translated field is displayed; readable-page extraction omits those
payloads and cannot validate client-rendered chart text.
For matrices, verify `text`-backed cells as well as `label`-backed cells.
Distinct column `detail` / `note`, row `note`, and cell `detail` / `note` must stay
visible in desktop grids, mobile cards and print. Check that cell tooltips
retain the matching row/column qualifications, without changing authored
tones or promoting a fallback value over an explicit empty label.
Matrix print uses 10pt row titles, values and qualifications, with 9pt column
headings and figure captions. Check actual PDF glyph sizes and pagination:
keep the caption with the first row and a fitting row card together. Let
oversized cards break between complete cells rather than separating a column
heading from its value and notes.
Cells taller than a page must remain fully readable across pages, not clipped
or shrunk. Check restored desktop/mobile layouts and pointer tooltips too.
Timeline entries retain their full date, label and detail in visible text and
shared hover/tap tooltips. Check both surfaces; an accessibility label alone
does not prove the tooltip works, and print must retain the visible detail.
Print timeline events as ordered date/label/detail entries at the report's
body-text size, not as a long SVG shrunk to a page-height cap. Preserve authored
order and tone, allow page breaks between complete events, and check actual PDF
type size. A label containing a date must not become a second invented date row.
Keep hidden SVGs measurable during print and check the restored screen.
With evidence enabled, retain each timeline event's own ordered claim links
beside the figure links, following the renderer's item-source precedence.
Hide those evidence-only rows when evidence is disabled and in print.
Pyramid layers expose their complete labels, authored values, units and every
distinct qualification on the layer and in shared hover/tap tooltips. Preserve
`displayValue` / `value` / `score` precedence, including zero and an explicitly
empty display value; concept-only layers must not acquire a guessed quantity.
Keep the localized notice that layer widths express hierarchy, not quantitative
proportions visible on screen and in print. Verify an actual
pointer interaction rather than treating the native SVG title as proof of mobile
tooltip support; values and qualifications must remain visible in print.
Check deep pyramids too: every authored layer must retain a positive readable
width, rather than shrinking later layers to zero or negative widths.
When evidence is enabled, verify each pyramid layer's own ordered claim links
as well as the figure-level links. Labels and references follow the same
items-before-nodes precedence as the chart; evidence-only rows stay hidden
when evidence is disabled and in print.
Check visible text bounds as well: character-count wrapping can clip Chinese
glyphs even when the complete string remains in the SVG text node. Pyramid and
timeline wrapping use measured SVG glyph widths rather than assumed Latin widths.
Exercise a cold font load too: measurements made with fallback fonts must be
recomputed once web fonts are ready, even if the chart container never resizes.
Check the initial settled layout before any resize; a later resize must not be
required to bring text back inside its layer.
Print pyramid layers as ordered text at the report's body-text size rather
than shrinking a dense SVG until its values become illegible. Preserve every
layer's label, value, qualification and tone hints in order, allow page breaks between
layers, and inspect actual PDF type size and complete layer text.
Approximation and evidence notes must remain visible on narrow screens and in
print; they qualify the chart data rather than serving as optional decoration.
Multi-series bars render as tables: check every series name and point, including
duplicate point labels, visible context cells, and full hover/tap text.
Single-series bars preserve point qualifications on the page and in print;
differing explicit point units instead produce separate cards with a localized
notice. These presentation changes preserve report YAML and do not certify the
underlying metrics or comparability.
KPI item detail, note, context and unit text qualify its value: verify every
distinct qualification on the card, in print and in its hover/tap tooltip,
including when several fields coexist. Preserve distinct qualifications without
duplicating identical text; mixed-unit bar cards follow the same rule.
Range-chart colors must agree across locales. The renderer resolves legacy
English label hints before translation and gives explicit `tone` values priority;
translated display labels must not change those colors.
Renderer-owned range descriptors also follow the report locale: Chinese uses
`低值 / 中间值 / 高值` in tooltips and `中间值` on the page and in print.
These labels do not imply a statistical median, confidence interval or forecast;
do not edit report values or protected fields to translate generated UI text.
Range rows must also retain every distinct detail, note, context and unit on the
page, in print and in hover/tap tooltips. Check the authored low, center and high
values without inferring comparability or forecast confidence from the display.
An explicit `mid` or `value` takes priority over a finite-number `base`; prose
evidence labels in `base` are not numeric centers. Authored bounds and centers
retain decimal precision in visible labels, generated summaries and tooltips.
Check the center marker's position too, not just its text. Inferred midpoints
and axis ticks retain their existing compact formatting.
Derived axis ticks stay inside the numeric domain. When labels would overlap,
thin only interior tick labels using their measured bounds; retain both endpoints.
Check again after fonts load, small viewport resizes and print transitions.
Tick thinning must not change row values, markers, summaries, notes or tooltips.
Stack diagrams retain their complete ordered items, modules and outputs in
visible layer details and matching tooltips, even when the diagram previews
only a few pills. Check every label, value, unit and qualification in both
locales, on narrow screens and in print; duplicate labels are not merged.
Flow and stack previews fit measured SVG glyph widths, with explicit ellipses
when bounded previews are necessary; their full text remains in the supplements
and tooltips. Check actual glyph bounds, not just text presence. Mobile table
captions must use the full card width rather than collapsing into a vertical strip.
Also verify report-level `coverageNotes`, displayed before cover facts with
the same Chinese-leaf / English-fallback behavior as other report text.
Flow edge aliases resolve from English before overlays are merged. Non-sequential
explicit flows render as node/connection tables, with localized notices for
missing or ambiguous endpoints. Verify all connection directions, duplicate
connections, node details and visible notes in both locales and in print;
unchanged endpoint identifiers must not be translated to repair a display issue.
For ordered flow diagrams, also inspect the supplemental node/connection table:
full node text, values, units and qualifications must remain visible on-page and
in print even when diagram labels are shortened. Check the full tooltip text.
DAG diagrams also retain an ordered node/connection table, including distinct
description/detail aliases, risk prose and edge qualifications. Resolve endpoints
from English before merging overlays; do not translate identifiers or guess
missing links. Check node and edge hover/tap text, each item's ordered evidence
links, and the mobile table's actual `td::before` labels. In print the readable
table replaces the scaled diagram; verify full row text, row pagination and the
complete figure caveat in physical PDFs. Unsupported legacy sidecars still need
separate source/translation review; this display contract does not certify them.
Quadrant figures plot authored coordinates without collision displacement,
generated ranking zones or inferred benchmark thresholds. Honor declared numeric
axis bounds; otherwise fit each axis independently to its data, without inferring
a 0–10 or percentage scoring system. Preserve complete axis definitions, point
labels, coordinates, qualifications and ordered evidence in the accompanying
table. Coincident points stay coincident; use each legend entry to inspect them.
Check exact plotted positions, both locales, mobile labels and physical PDFs.
Print uses the readable coordinate table rather than a shrunken SVG.
Keep a real chart tooltip open when checking print transitions. Body-level
tooltips must be hidden in print, not repeated over every PDF page; verify the
physical output as well as underlying text and row geometry.
Range print labels use 10pt type, with at least 9pt for numeric bounds, center
labels, row notes and axis ticks. Verify actual PDF glyph sizes, complete source
strings and non-overlapping endpoints, including long decimals, qualifications
and dense figures. Print axes show only their domain endpoints to prevent
page-width tick crowding. Keep a figure together when it fits; longer figures
may break between complete rows, not through a row. Preserve screen layout,
authored values, colors and hover/tap behavior.
On screen, long range summaries must wrap without collapsing the numeric track.
Check actual text bounds inside the track and summary, including widths near the
stacked-layout breakpoint; non-overlapping labels alone do not prove containment.
Keep full numeric strings and qualifications rather than clipping or shortening
them, and verify that short summaries and printed rows retain their layout.
Funnel figures display ordered stage-value tables without deriving conversion
rates or shared population, unit or time assumptions. Preserve explicitly
authored rates and qualifications. Verify stage labels, raw values, units,
series names and notes in the visible rows and hover/tap tooltips in both locales,
including narrow screens and print; never invent a rate to replace the old
renderer-generated percentages.
Waterfall figures likewise display ordered source-value tables rather than
inferring additive steps or cumulative totals. Preserve every raw value, unit,
qualification and any declared `kind` / `role`, including conflicting or unfamiliar
role strings. Other authored `type`, `isTotal`, `category`, `direction`, `status`,
`base` and `cumulative` fields also remain literal metadata, not instructions to
recompute a bridge or validate its assumptions. With evidence enabled, retain each
value's own ordered claim links; hide those evidence-only rows when disabled and
in print. Evidence labels follow the value-table label precedence. Keep the
localized no-inference notice visible on screen and in
print. Check physical PDFs: each value card must keep its label, value, declared
roles and context together when the card fits on one page. A final financing tranche must not become a total merely because it is
last; declared totals also remain authored values, not recalculated results.
Item `valueNote` strings are also visible value qualifications, including
`series[].points[]`. Translate them without changing the associated numeric
value; preserve self-reporting, audit limitations and approximate-count wording
on the page, in print and in tooltips.
Enable the evidence toggle when checking inline claim links, including the
company profile. Every declared reference must remain reachable, including references after the eighth; their
IDs and order do not change with translation. Print hides inline links while
retaining the evidence index.
Long table citation rows must wrap within the table width. Check the actual
bounds of every link, not just DOM visibility: clipped later links can still
report visible. Following the last reference must not horizontally scroll the
table or leave its caption and cells shifted after print returns to screen.

- **Translate**: `title`, `subtitle`, `summary`, `description`,
  `caption`, `insight`, `basis`, `notes`, `approximationNotes`, the
  axis-label shapes (`xAxisLabel` / `yAxisLabel` / `xLabel` / `yLabel`
  / `xAxis` / `yAxis` / `xAxis.label` / `yAxis.label` /
  `data.xAxis` / `data.yAxis` / `data.xAxis.label` / `data.yAxis.label`
  / `data.xAxis.high|low` / `data.yAxis.high|low`), every
  `label` / `name` / `detail` / `description` / `note` / `notes` /
  `text` / `relationship` / `lowLabel` / `highLabel` / `examples` /
  `context` under `data.items[]` / `data.nodes[]` / `data.edges[]` /
  `data.points[]` / `data.layers[]` / `data.layers[].items[]` /
  `data.layers[].modules[]` / `data.layers[].outputs[]` / `data.series[]`
  / `data.series[].points[]` / `data.columns[]` / `data.rows[]` /
  `data.rows[].values[]`, and journey-map row text:
  `data.items[].actor` / `actors[]` / `phase` / `stage` / `emotion` /
  `channel` / `channels[]` / `touchpoints[]`, plus
  `data.nodes[].risk` / `segment`.
- **Never translate unless the exact path is explicitly listed above as
  visible chart text**: `id`, `key`, `slug`, `type`, `kind`, `layout`,
  `tone`, `status`, `sentiment`, `direction`, `trend`, `confidence`,
  `group`, `stage`, `phase`, `category`, `segment`, `unit`, `value`,
  `displayValue`, `date`, `delta`, `from`, `to`, `source`, `target`,
  `claimRef`, `claimRefs[]`, `sourceRefs[]`, `captionSources[]`,
  `xAxis.high|low` numerics, `yAxis.high|low` numerics. These are
  enum keys, chart geometry, refs, numbers, or publisher names — they
  drive CSS classes and bucketing logic in
  [website/src/lib/figures.mjs](../../../website/src/lib/figures.mjs)
  and [FigureRenderer.astro](../../../website/src/components/FigureRenderer.astro).

`scripts/whitelist.mjs` enforces this list. If a future figure shape
adds a new visible-text key, report the missing whitelist path instead
of editing `FIGURE_PATHS` during the translation run.

Style notes specific to figure text:

- Node / column / row / phase **labels** are 2–6 character headings.
  Translate as short noun phrases; drop articles. "Foundation control"
  → "基金会控制"; "OpenAI Group PBC" → keep verbatim.
- Mixed labels follow the same rule as table cells: keep brands/products,
  translate ordinary descriptors. "Meta / open weights" →
  "Meta / 开放权重"; do not keep the whole label English because it starts
  with a proper noun.
- `detail` / `description` / `note` are one-sentence captions that
  appear in tooltips. Apply the prose translation philosophy: lead
  with the topic, drop `对……来说`, prefer concrete verbs.
- `data.items[].valueNote` and `data.series[].points[].valueNote` are
  translatable value qualifications, not numeric or enum fields.
- `data.nodes[].notes` is translatable string prose, including pyramid
  qualifications. Nested objects or arrays under `notes` are not editable;
  node values, units, identifiers and references remain protected.
- Pure model / version / SKU lists in figure details may stay Latin with
  Chinese separators: "GPT-5.x、GPT-4.1、o1、GPT-4o" is fine.
- Axis labels often carry a parenthetical unit hint
  ("Inference Speed (tokens/sec, mid-size LLMs)"). Translate the
  prose, keep the parenthetical units verbatim:
  "推理速度（tokens/sec，中型 LLM）".
- Quadrant `high` / `low` labels are 2–4 character endpoints
  ("Single market (UAE)" / "Multi-market MENA"). Translate as short
  labels; do not narrate.

## Inspection snippets

If the parent runs an inline Node snippet for inspection, this repo is
ESM. Use `import`, not `require`. Always `cd` to the workspace root
first; `js-yaml` lives in the root `package.json`. Inline Node should be
for one-off inspection only, never the main workflow path.

```sh
cd /home/ythuang/workspace/startup
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
NODE
```

## Errors and remediation

Repair incrementally. Edit only the offending leaf or part in the
existing cache, then rerun the narrowest finalize/check step. Do not
re-export the whole report unless the bundle is structurally corrupted.

Use the runner first. Drop to lower-level scripts only when the failing
path or part is already known.

- `check-translation.mjs` `missing`: a required `*.zh.yaml` output is absent.
- `check-translation.mjs` `shape`: a bundle or part changed object/array shape.
- `check-translation.mjs` `preserve`: a non-translatable leaf was changed.
- `check-translation.mjs` `translate`: a leaf is still empty or too English.
- `check-part-leaf-counts.mjs`: a translated part changed string-leaf count
  or paths. Use the reported extra/missing paths to restore `null`
  placeholders or list indentation before rerunning.
- `bundle-translatable.mjs import`: the edited bundle no longer matches source shape.
- `bundle-translatable.mjs merge`: a part is missing, stale, or changed sparse shape.

Common repair order:

1. Fix the offending leaf or part in `.translate-cache/<runId>`.
2. For full-report part edits, rerun `lint-parts` until it passes.
3. Rerun `finalize-summary` or `finalize-full`.
4. Only if shape is badly corrupted, rerun `init` and re-translate the
   affected bundle or part.

## Common pitfalls

- Translating an enum value in YAML (the website maps
  `recommendation: research-more` to `继续研究` via `displayLabel`; the
  YAML stays English).
- Reordering, merging, or splitting list items.
- Translating source titles, publishers, or `keyQuote`.
- Adding parenthetical Chinese aliases for companies or products.
- Translating a mechanical table cell (number, currency, date, `n/a`).
- Leaving byte-identical short labels that include an English descriptor.
  Proper nouns stay Latin, but the descriptor still needs Chinese:
  `U.S. federal courts` → `美国联邦法院`; `Series E at $61.5B` →
  `Series E 轮，估值 $61.5B`; `Responsible Scaling Policy v3.2` →
  `Responsible Scaling Policy v3.2（负责任扩展政策）`.
