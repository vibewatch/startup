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
Attached labels such as `2026Q1` and `2026H1`, and escaped line breaks in chart
labels, also retain their year anchors. Quarter and half-year labels in
`Q2 ARR` or `H1 ARR` are not ARR amounts. The metric tokenizer separates these
labels from the metric; it does not establish quarter/half-year fidelity or
interpret relative periods such as `the first two quarters after IPO`.
These token checks do not establish complete numeric or semantic fidelity;
verify the source proposition and metric meaning as well.

The uncertainty check accepts `未披露公开里程碑` as a faithful rendering of
`no public milestone disclosed`. Reported attribution accepts `据报道`, `据报`,
`据称`, or `报道称`; omitting it still fails. A prohibition such as `no public cloud LLM API
allowed` is checked separately from missing public disclosures: Chinese must
preserve the restriction, not add an unrelated evidence gap.
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
bounded source-anchored repair of only those cached leaves and validates again.
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
currency symbol, such as `$20+ billion` and `€580-million`. Plus-qualified or
hyphenated counts without a currency symbol are not expanded here; never strip
a faithful magnitude merely to clear a token mismatch.
When ordinary metric tokens differ, a conservative fallback compares standalone
non-currency counts across English scale words / `K`, `M`, `B`, `T` and Arabic
numbers with `千`, `万`, `亿`, or `万亿`, including `100 多万`. It shifts decimal
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
`percent` and `per cent` match `%`, including both range
endpoints. Common written percentages such as `百分之十三` and `超过八成`
can resolve a mismatched numeric anchor only when the full metric-token sets
then agree; this does not validate all verbal ratios. `26-fold` and `26 倍`
retain the same multiplier. A bare
calendar year followed by `ARR` or another metric label remains a year;
repeating that year does not create another quantitative claim. Repeated
amounts and rates still retain their occurrence counts.
Other unit or currency conversions still require source
comparison; do not remove faithful units merely to make token-level checks pass.

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
`网站口径` and an attributed `反方观点` can also preserve a claim. Insurance
coverage limits and claims history refer to insurance, not assertions.
`at most recent fiscal quarter-end` names the latest period, not an upper bound;
a separate `at most` quantity in the same leaf still needs its upper bound.
Do not mistake `来源` or `带来` for the purpose marker in `通过…来`, or a
locative phrase such as `正在生产环境中部署` for clause-final `正在…中`.
Public-evidence gaps can place a Latin company name or a carrier relationship
before `公开`; `公开材料没有…` and `公开来源无法…` can retain a negative finding.

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
