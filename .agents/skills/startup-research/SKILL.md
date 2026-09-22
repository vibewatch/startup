---
name: startup-research
description: "Use when: producing a startup research report, company diligence report, investment diligence report, or full report-v2 workflow for a named company."
user-invocable: true
---

# Startup Research

Workflow narrative: what to run, in what order, with which flags. Two generated companions carry the static reference material; load both **in full at session start**, **`rules.md` first**:

- [`references/rules.md`](references/rules.md) — binding agent policy, gates, ID system, validator dimensions, renderer contracts.
- [`references/contracts.md`](references/contracts.md) — chapter YAML and `report-meta.yaml` field shapes (with allowed enum values inline).

`references/rules.md` and `references/contracts.md` are generated from `references/workflow-config.yaml`, `scripts/validation-catalog.mjs`, `scripts/contracts/*`, and renderer contract sources — do not hand-edit them. If any prose in this file disagrees with a runtime/script output, **trust the runtime/script output**.

## Execution contract

- Run every command from the repository root. Paths are repo-root relative unless a script prints an absolute path.
- Treat validation commands as gates. Preserve full stdout/stderr and nonzero exit codes; do not pipe them through truncating filters.
- Prefer `--format json` (or `--format compact`) on every `check-*` / `build-*` script. Read repair hints in this priority: `issues[].fix` → `objectFailures[].fixes` → `globalHints[].fix` → `retryOrder[]`. `suppressedDimensions[]` re-emit after their prerequisite is fixed. Conditional keys are omitted when empty — see *Validation result envelope* in [`contracts.md`](references/contracts.md).
- The `hardRules` block in [`rules.md`](references/rules.md) → *Agent policy (binding)* binds every step (no git, no hand-edited `revision:` / `evidence.yaml` / `full-report.yaml` / `summary-card.yaml`, scratch only under `.research-cache/<runId>/`, no sibling-chapter edits). Read it once at session start.

## Runtime bootstrap

1. **Preflight.** Confirm the runtime has an approved web/search capability (`fetch-url` reviews direct URLs; it does not discover them). If absent, stop **before** calling `create-report-run.mjs`: in interactive mode ask the user for an authoritative URL pack; in automation print `source-discovery-unavailable` to stderr and surface an "intentional skip" to the orchestrator. No script runs at this stage — do not reuse exit codes 1–4 reserved by `create-report-run.mjs`. For staged local files, require `originalUrl` / publisher / title / date and cite the original URL; do not invent URLs from filenames.
2. **Get the configured chapter list:**
   `node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --list`
   Each entry is the full chapter brief. Per-chapter `previousChapter` / `nextChapter`, `runtimeContext.run`, `runtimeContext.runCache`, and `runtimeContext.policy` are emitted later by the per-chapter loader (chapter generation step 1), not by `--list`. Authoritative shape: [`contracts.md`](references/contracts.md) → *Chapter runtime context shape*.
3. **Create a report folder:**
   `node .agents/skills/startup-research/scripts/create-report-run.mjs "<companyName>" [--website <companyUrl>]`
   - The script writes the **report folder path to stdout**; everything else (hints, env-snippet path, refresh notices) goes to stderr. Capture stdout and check the exit code immediately:
     ```sh
     REPORT_FOLDER=$(node .agents/skills/startup-research/scripts/create-report-run.mjs "<companyName>" --website "<companyUrl>") || exit $?
     ```
   - **Quote multi-word values** (`"<companyName>"`, `--refresh-reason "<text>"`, any `--website` URL containing shell metacharacters); otherwise the second word parses as an unknown flag and the script exits 1.
   - **Refresh:** add `--refresh --refresh-reason "<text>"`. If the script reports multiple current matching reports, list each candidate's runId / `company.name` / `company.website` from `reports/<runId>/summary-card.yaml`, confirm the intended one (interactive: ask the user; automation: pick the most recent runId), and rerun with `--refresh --refresh-reason "<text>" --refresh-of <priorRunId>` (all three flags — `--refresh-of` requires `--refresh`). `<priorRunId>` is the bare `YYYYMMDDhhmmss-<slug>`, not a folder path. `--resume` reuses the cached refresh reason.
     The root shortcut is `npm run --silent startup:refresh -- "<companyName>" --website "<companyUrl>" --refresh-reason "<text>"`; it preserves the same stdout folder-path contract.
   - **Exit 1** — bad CLI args or non-recoverable failure; stderr (every script prefixes its messages with `[script-name]`) names the offending field. Refresh-specific cases: (a) `no matching finalized report exists for this company/domain` — verify `<companyName>` and `--website` against `ls reports/` / recent `summary-card.yaml` before dropping `--refresh`, since aliases silently produce a duplicate fresh run; (b) `every matching report is already superseded` — surface a maintainer blocker listing each prior runId and its `revision.status` (read from `reports/<runId>/report-meta.yaml`); do not hand-edit `revision.status` (link-refresh overwrites it); (c) `multiple current finalized reports match` — rerun with `--refresh-of <priorRunId>`. Resume + refresh consistency: (d) `cannot resume refresh run <runId> without --refresh` — rerun with `--resume --refresh`; (e) `cannot promote in-progress run <runId> into a refresh` — finalize/discard the in-progress run, then start a fresh `--refresh` run.
   - **Exit 2** — finalized duplicate exists (fresh runs only; refresh runs short-circuit this check). Treat as a successful skip; do not retry with a suffixed folder.
   - **Exit 3** — in-progress folder for the same company slug exists; rerun with `--resume` (and `--resume-run <runId>` if stderr lists multiple candidates).
   - **Exit 4** — no matching in-progress folder for `--resume`; rerun without `--resume`.
4. Use `$REPORT_FOLDER` as `<reportFolder>` for every later command. The runId is the folder basename. The per-chapter loader emits `runtimeContext.run.runDate` (auto-derived UTC `YYYY-MM-DD` from the runId timestamp prefix) whenever `--report-folder` is supplied — that is the canonical clock and freshness anchor for every chapter doc head and every source-discovery query date token. Never format a date from the model clock. Binding rules: [`rules.md`](references/rules.md) → `researchRules`.
5. **Export `STARTUP_FETCH_LOG_PATH` before any `fetch-url` invocation:**
   ```sh
   RUN_ID=$(basename "$REPORT_FOLDER")
   source ".research-cache/${RUN_ID}/env.sh"
   ```
   - **CI exception:** if `STARTUP_FETCH_LOG_PATH` is already exported (e.g. a workflow-wide trail), keep that value — do **not** source the snippet. (`create-report-run.mjs` detects this and prints a confirming note instead of the source-the-snippet hint.)
   - **Subagent caveat:** when fanning work out to subagents that don't inherit env vars, pass the resolved value explicitly. Use the absolute path `"$PWD/.research-cache/${RUN_ID}/_fetch-log.jsonl"` if any subagent may chdir away from the repo root.
   - `check-chapter` emits `unverifiedSource` (warning; failure under `--strict`) for each cited URL absent from the trail, and a single `fetchTrailMissing` warning when the trail is missing entirely.

## Chapter generation

**Default mode: parallel** — spawn every chapter concurrently; step 7's convergence rerun reconciles the per-chapter dimensions that depend on sibling state (`netNewSources`, `crossChapterRefLeak`). Fall back to **sequential** (each chapter starts only after the prior chapter's YAML is on disk) when the runtime cannot spawn concurrent workers, or when chapter coupling is so tight that parallel would force multiple convergence cycles. Sequential gives the agent the full sibling context up front via `--include-context`, so it authors chapters that don't trigger `crossChapterRefLeak` / `netNewSources` (the validators still run — they just have nothing to flag), and step 7 is unnecessary.

For each chapter from the `--list` roster:

1. Load its per-chapter delta:
   `node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --order <n> --report-folder <reportFolder> [--include-context]`
   - The loader emits JSON to stdout; do not pass `--format`.
   - `--order <n>` is the canonical selector; `--key <chapter-key>` and `--file <chapter.file>` are equivalent (useful in retry loops where the failing chapter's key or file is what you have on hand). Pick one per invocation.
   - **`--include-context` rule by drafting mode:**
     - **Parallel (default):** omit it on every chapter — the projected rollup is empty (or partial as a few peers happen to finish first), and step 7 reconciles cross-chapter divergence.
     - **Sequential (fallback):** omit it on chapter 1 (rollup would be empty); pass it on every later chapter so the loader projects `contextChapters` and `cumulativeContext` from on-disk siblings.
   - If the loader returns `cumulativeContext.partial: true` (a `cumulativeContextPartial` warning fired because some earlier chapter file was missing or unreadable — typically the parallel-mode rule above was violated), treat `cumulativeUnresolvedQuestions` and `cumulativeRestrictedAccessPct` as incomplete and do not gate authoring decisions on them. Step 7's convergence rerun makes them clean.
2. Plan queries → search → fetch → record (run this **before** step 3 so `localEvidence` is populated when the YAML body is written):
   - Build a run-aware query portfolio first:
     `npm run research:plan -- --report-folder <reportFolder> --company "<companyName>" [--website "<companyUrl>"] [--chapter <key|order>]`
     Refresh runs infer the company and prior unresolved gaps from `.research-cache/<runId>/refresh-context.yaml`.
   - Execute discovery queries through the cached provider-neutral runner:
     `npm run research:search -- --report-folder <reportFolder> --query "<query>" --intent <broad|freshness|primary|semantic|adverse> [--provider auto] [--official-domain <company-domain>]`.
     `auto` prefers AnySearch for free broad discovery, Brave for freshness when configured, and Exa/Tavily for semantic or content-rich gap filling. Provider keys are optional except for their named provider: `ANYSEARCH_API_KEY`, `BRAVE_SEARCH_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`.
   - The runner adds a deterministic `sourceQuality` tier using official-domain, regulator/government, publisher-reputation, freshness, preview-depth, and low-signal-platform checks. Deduplicate candidates, retain the strongest primary/independent/adverse mix, then fetch every retained URL with `fetch-url`; only fetched direct URLs may enter `localEvidence.sources`.
   - **`researchQuestions[]` and `searchQueries[]` are distinct fields** — the former are typed analytical questions (`Q<L>###`, `type`, `status`, `targets[]`), the latter are the literal search-engine query strings you ran. Don't conflate them; the validators check different shapes (see [`contracts.md`](references/contracts.md)).
   - Plan source-discovery queries from `runtimeContext.run.runDate`; derive any year/month tokens from that single anchor. Binding rules: [`rules.md`](references/rules.md) → `researchRules`, `volatileFactQueryTokens`. Use the host runtime's approved web/search capability — if absent, you stopped at the bootstrap preflight; do not invent sources or backfill from memory.
   - Record each query you actually issued in `localEvidence.searchQueries[]` (provenance/audit, not the search mechanism).
   - Retrieve each retained URL with the [`fetch-url`](../fetch-url/SKILL.md) skill (with `STARTUP_FETCH_LOG_PATH` set, this also writes the fetch trail that `unverifiedSource` audits against).
   - Store reviewed sources, atomic claims, typed research questions, and typed evidence gaps in `localEvidence`.
3. Author the chapter YAML at `reportFolder/<runtimeContext.chapter.file>` using:
   - `runtimeContext.chapter` for mission, content requirements, planned tables/figures, quality bar, and gate.
   - [`rules.md`](references/rules.md) for agent policy, gates, the **ID system** (mint every `S/C/T/F/Q` id with this chapter's `runtimeContext.chapter.letter`), validator dimensions, and renderer contracts.
   - [`contracts.md`](references/contracts.md) for chapter YAML field shapes and inline allowed enum values.
4. Run the chapter gate (normal pass):
   `node .agents/skills/startup-research/scripts/check-chapter.mjs <reportFolder> <chapter.file> --format json`
   - **Read `warnings[]` even on exit 0.** The normal pass surfaces warning-class dimensions in `warnings[]` without flipping `ok`. Triage them now (fix or plan an `acknowledgedWarnings` opt-out per step 6) — step 6's `--strict` sweep promotes every unacked warning into the failure set with no extra per-table/per-source diagnostic context. The full ack-eligible list is in [`rules.md`](references/rules.md) → *Validator dimensions* → *`acknowledgedWarnings` opt-out*. `acknowledgedWarnings` itself is **not** ack-eligible — it is a meta-warning emitted when an entry under `acknowledgedWarnings:` is malformed (missing `dimension`, `reason` < 30 chars, or targets a failure-class dimension); fix the offending entry instead.
5. On failure, fix dimensions in `retryOrder[]` first — root-cause and global hints before object-by-object cosmetic edits.
   - **`retryOrder[]` absent / empty:** the envelope omits it whenever `summary.failedDimensions` is empty. If `ok: false` but `retryOrder` is absent, you are in `--strict` mode with only unacked warnings remaining — fall back to `summary.unackedWarningDimensions[]`.
   - **`retryOrder[]` and `summary.unackedWarningDimensions[]` both non-empty (only under `--strict`):** fix `retryOrder[]` (root causes) **and** every entry in `summary.unackedWarningDimensions[]` (fix or `acknowledgedWarnings`-opt-out the whole dimension) in the **same edit cycle** before rerunning the strict sweep — otherwise the unacked warnings re-emit and look like new failures.
   - **Retry policy** ([`rules.md`](references/rules.md) → `retryPolicy`): per chapter, **3** retries (`maxChapterRetries`) on top of the initial run, and each retry must reduce the **failure count** (`requireMonotonicFailureDecrease`). Failure count = `issueCount + summary.unackedWarningDimensions.length`. `summary.unackedWarningDimensions` is a **deduped Set of dimension names**, not a count of instances — five `tableNotes` warnings on different tables collapse to one entry; you must fix every instance (or ack the whole dimension) before that entry drops out. No script blocks a non-monotonic retry; the agent enforces it.
   - **Stop conditions:** if retry N's failure count is `>=` retry N−1's, or the budget exhausts with failures still present, stop and surface a user-facing **blocker** naming (a) the chapter file, (b) surviving failure dimensions from the last JSON envelope, (c) the **phase that exhausted** (`mid-flight normal pass` / `mid-flight strict sweep` / `convergence rerun`), and (d) what you tried. Do not author `report-meta.yaml`, do not run `finalize-report`.
6. Once the normal pass is clean, run a **strict pre-finalization sweep**:
   `node .agents/skills/startup-research/scripts/check-chapter.mjs <reportFolder> <chapter.file> --strict --format json`
   - `--strict` adds unacknowledged warning dimensions to the failure set so `ok` flips to `false`. Warnings stay in `warnings[]`; `summary.unackedWarningDimensions[]` lists the dimensions now contributing to the failure count.
   - For genuinely non-actionable warnings, opt out via top-level `acknowledgedWarnings: [{ dimension, reason }]` (`reason` >= 30 chars; ack-eligible dimensions only — see [`contracts.md`](references/contracts.md) for the schema). Never silence a real failure: `finalize-report` reruns this sweep and refuses to publish if any chapter still fails.
   - **Strict starts a new baseline** — don't compare the first strict envelope against the preceding clean normal pass. Save it; subsequent strict retries must reduce the failure count from that strict baseline. The retry budget and stop conditions in step 5 apply per chapter (phase = `mid-flight strict sweep`).
   - **Mid-cycle escalation when the failure is structurally unfixable** (e.g. `requiredSourceTypes` for a type with no public source, `highConfidenceCorroboration` on a critical adverse claim with only a single witness, `revisionGraph` failures that need maintainer-side schema repair): surface the blocker **before** burning the rest of the budget. Name (a) the chapter file, (b) the offending dimension and the specific id/url/field, (c) why the failure cannot be cleared with available evidence, (d) user-actionable resolution options. (Warning-class dimensions are out of scope here — every ack-eligible dimension can be acked with a 30+ char rationale.)
7. **Convergence rerun (parallel mode only — skip in sequential mode).** After every parallel chapter has landed on disk, walk every chapter **in `--list` order** running step 4 then step 6 per chapter before moving to the next; iterate until both sweeps clear on every chapter. `finalize-report` reruns the strict sweep itself but won't fix root causes.
   - **Why required:** `netNewSources` and `crossChapterRefLeak` inspect on-disk siblings, so a chapter can pass in isolation and fail once a peer lands. (`crossChapterRefLeak` only fires here — the foreign id has to resolve to a sibling on disk; mid-flight in parallel mode the same author error surfaces as the generic `claimRefs` failure. `duplicateAnalysisCrossChapter` and metric/key-fact drift are caught later by `check-cross-chapter`, not here.)
   - **Fresh per-chapter retry budget** — each chapter that surfaces convergence-only failures gets its own `maxChapterRetries: 3`, independent of mid-flight. The three phases (mid-flight normal, mid-flight strict, convergence) each have their own per-chapter budget; convergence is the **final** phase. Convergence failure → step 5 blocker (phase = `convergence rerun`) and stop.
   - **Mid-flight handling of transient failures** (during step 4, before convergence in parallel mode): treat `netNewSources` as transient (it reflects siblings not yet on disk). `crossChapterRefLeak` cannot fire mid-flight in parallel mode — a foreign-letter claimRef written before siblings land surfaces as `claimRefs`, which is **not** transient (restate the fact as a local claim with its own `sourceRefs[]` rather than deferring).
     - **Failure set is *only* transient dimensions:** mark the chapter "drafted, pending convergence". Skip steps 5 and 6 for this chapter and move on — re-validate in convergence.
     - **Mixed transient + non-transient:** fix the non-transient ones within the retry budget (transient ones don't count toward `maxChapterRetries`), then proceed to step 6.

> **Parallel worker contract.** Pass each worker the `reportFolder`, `runId`, its chapter `order`/`key`/`file`/`letter`, the full `runtimeContext` (including `runtimeContext.policy.retryPolicy`, which the worker must enforce), and `STARTUP_FETCH_LOG_PATH` (absolute path if any worker may chdir). Each worker may write only `reportFolder/<runtimeContext.chapter.file>` and scratch under `.research-cache/<runId>/`; no sibling-chapter, `report-meta.yaml`, assembled-artifact, or git edits. Each worker must return: `chapter.file`, `normalStatus` (`passed`/`failed`), `normalRetries`, `strictStatus` (`skipped` for transient-only deferral, else `passed`/`failed`), `strictRetries`, `survivingFailureDimensions[]`. The orchestrator waits for every worker, verifies every configured chapter file exists, then runs the convergence sweep before authoring `report-meta.yaml`.

> **Note: the fetch-url trail is shared across the run.** Every chapter writes into the same `STARTUP_FETCH_LOG_PATH` file (one JSON line per call, append-only); `check-chapter` only requires that each cited URL appear at least once. Parallel `fetch-url` calls need no coordination beyond sharing the env var.

## Finalization

Only start after every configured chapter file exists and passes `check-chapter --strict` (sequential: step 6; parallel: step 7's convergence rerun).

1. **Author `report-meta.yaml`** from the `ReportMetaSchema` summarized in [`contracts.md`](references/contracts.md). It owns the final judgment, cover facts, and company profile fields.
2. **Validate report meta shape:**
   `node .agents/skills/startup-research/scripts/check-report-meta.mjs <reportFolder> --format json`
   - Shape and enums only — cross-references like `coverFacts[].claimRefs` are resolved later by `build-report` against `evidence.yaml`.
   - **`displayCompleteness` is a permanent published warning, not a gate.** `check-report-meta` has no `--strict` mode and never promotes warnings to failures; the warning rides in `warnings[]` and degrades the public display surface forever. Read `warnings[]` even on exit 0, populate the named fields (or accept the documented `null` path) and rerun. `acknowledgedWarnings` cannot silence it.
3. **Run finalization:**
   `node .agents/skills/startup-research/scripts/finalize-report.mjs <reportFolder>`
   - **Refresh:** add `--refresh`. `--refresh-reason` is optional here — if omitted, `finalize-report` reuses the value cached by `create-report-run.mjs` (it logs `[finalize-report] using cached --refresh-reason…`). If you re-pass it, the value **must match the cache exactly** (mismatch → exit 1; the script does not rewrite the cache).
   - **Workflow-config snapshot:** finalize-report freezes the current `references/workflow-config.yaml` into `<reportFolder>/.workflow-snapshot.yaml` on the first run (logged as `[finalize-report] wrote .workflow-snapshot.yaml …`) and reuses it on every re-run, so later edits to the head config never retroactively re-judge this report. Pass `--refresh-snapshot` only when you have intentionally repaired an old report and want it re-judged against the **current** head config.
   - **`--rebuild` is no longer required after chapter edits.** `finalize-report` auto-rebuilds the ledger whenever a chapter's mtime is newer than `evidence.yaml` (logged as `[finalize-report] auto-rebuild:…`). Pass `--rebuild` only to force a fresh consolidation. `coverFacts[].claimRefs` use chapter-letter ids (`C<L>###`) that stay stable across rebuilds; a dangling ref after rebuild points at an actual chapter edit, not the rebuild.
   - **Exit 4** (pre-flight): the report folder is missing, `report-meta.yaml` is missing inside it, or any configured chapter file is missing when the strict sweep starts (stderr: `[finalize-report] missing chapter file(s) before strict sweep: <files>`). Wrong path / step 1 not done / chapter generation incomplete — fix and rerun.

Finalization is a sequential pipeline; it stops at the first failing step and exits with that step's code. Triage by step name printed to stderr (`[finalize-report] -> <step>` then `[finalize-report] <step> failed`):

| Step | Script | Fix target on failure |
|---|---|---|
| `check-chapter:<key>:strict` | `check-chapter.mjs --strict` | the named chapter — rerun the same command directly to iterate |
| `check-report-meta` | `check-report-meta.mjs` | `report-meta.yaml` shape/enum issues |
| `prepare-refresh` (refresh only) | `link-refresh.mjs --prepare-current` | the prior `current` report must exist, be finalized, and match the new report on **either** `company.name` (normalized) **or** `company.website` (normalized registrable domain) — OR semantics, not AND |
| `build-evidence-ledger` | `build-evidence-ledger.mjs` | a chapter `localEvidence` block (script names the chapter and offending id) |
| `check-cross-chapter` | `check-cross-chapter.mjs` | metric drift, key-fact overlap, or duplicate analysis across chapters; rerun `finalize-report` after editing |
| `build-report` | `build-report.mjs` | a chapter or `report-meta.yaml` field the assembler could not project |
| `check-report` | `check-report.mjs` | report-level gates (domain diversity, adverse-source distribution, paywall ceiling) |
| `link-refresh` (refresh only) | `link-refresh.mjs` | only fires after publishability passes. Common `[refresh]` aborts: (a) `report folder not found` / `not finalized` / `not under reports/` — wrong path; (b) `multiple current finalized reports match… ambiguous refresh target` — the new report is already finalized so `create-report-run --refresh-of` cannot retarget it; instead **edit** `.research-cache/<newRunId>/refresh-context.yaml` to set `refreshOfRunId: <intendedPriorRunId>`, preserving the existing `refreshReason` / `previousReport` / `schemaVersion` keys (do not overwrite the file — `link-refresh` falls back to `existing.refreshReason` and clearing it loses the prior/new `revision.refreshReason`), then rerun `finalize-report --refresh`; (c) `<priorRunId> is already superseded by <otherRunId>` — refresh `<otherRunId>` instead; (d) link-refresh re-runs `build-report.mjs` against the prior run's chapters, so a schema change since the prior run can break it — run `check-chapter --strict` against the prior folder and fix what it surfaces |

**Finalize exit 1 has two families:** (a) early-exit (no `<step> failed` line printed), and (b) pass-through from any inner `check-*` / `build-*` step. If no `<step> failed` precedes the exit, the cause is early-exit:
- CLI parse failure (unknown flag, missing positional, `--help`); script prints `Usage:` and exits 1.
- `--refresh` with `--refresh-reason` whose value disagrees with the cache. Omit `--refresh-reason` to reuse the cache (recommended), or pass it verbatim. (When the cache file is missing or unreadable, this consistency check is silently skipped.)

**Inner-step exit codes propagate verbatim** — don't assume non-zero means 1. `prepare-refresh` / `link-refresh` may surface exit `2` (`alreadyExists`, e.g. prior is already superseded) or exit `4` (`notFound`, e.g. report folder not found) on top of `1`; pre-flight inside `finalize-report` itself also exits `4` when the report folder, `report-meta.yaml`, or any configured chapter file is missing. Always read the `[step]` stderr lines to triage rather than branching on the numeric code alone.

Otherwise rerun the failing step directly with `--format json` for structured fix hints (every step except `link-refresh` supports it; for `link-refresh` triage from the `[refresh]` stderr lines), then re-run `finalize-report` — it **always restarts at the top of the pipeline**. The only smart skip is `build-evidence-ledger`, which is bypassed when no chapter is newer than `evidence.yaml` (and `--rebuild` not passed).

When `finalize-report` exits 0 (`[finalize-report] ✓ pipeline complete; report passed schema validation.`), summarize the run for the user using every field listed in [`rules.md`](references/rules.md) → `finalResponseFields`. Quote that stdout line verbatim as the `finalize result` field; pull the rest straight from the produced files:

| Field | Source |
|---|---|
| report folder | the `<reportFolder>` you ran finalize on |
| generated files | filenames under `<reportFolder>/` (chapter YAMLs, `report-meta.yaml`, `evidence.yaml`, `full-report.yaml`, `summary-card.yaml`) |
| source count | `evidence.yaml` → `sources[].length` |
| claim count | `evidence.yaml` → `claims[].length` |
| recommendation | `summary-card.yaml` → `summary.recommendation` |
| confidence | `summary-card.yaml` → `summary.confidence` |
| risks | `summary-card.yaml` → `summary.topRisks[]` |
| valuation stance | `summary-card.yaml` → `summary.valuationStance` |
| table count | `full-report.yaml` → `tables.length` |
| figure count | `full-report.yaml` → `figures.length` |
| finalize result | the literal stdout line above |
| main gaps | `summary-card.yaml` → `summary.unresolvedGaps[]` |

### Refresh runs

`--refresh` rewires the revision graph in addition to producing a normal report. The CLI flow lives in *Runtime bootstrap* step 3 and *Finalization* step 3; the pipeline table covers the two `link-refresh` steps. Runtime-visible behavior the agent must know:

1. **Detecting refresh mode at runtime:** the loader emits `runtimeContext.runCache` whenever `--report-folder` is supplied; `runtimeContext.runCache.refreshContext` is `null` for fresh runs and an object (the cached prior summary) when a refresh-context cache exists. Test `runtimeContext.runCache?.refreshContext != null`; do not infer refresh from folder name or argv. Read the cached prior summary for context, but treat every value listed in [`rules.md`](references/rules.md) → `volatileFacts` as stale and re-fetch it.
2. **Revision authoring rule:** omit the `revision` block from `report-meta.yaml` entirely. The two `link-refresh` phases own every revision field (`status`, `refreshOfRunId`, `supersededByRunId`, `refreshReason`) on both runs. Disambiguate prior matches at create time with `create-report-run --refresh-of <priorRunId>`, never by hand-authoring `revision.refreshOfRunId`.
