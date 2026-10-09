# Startup

Startup is a diligence report generator for startup companies. It produces evidence-backed YAML report artifacts and renders them as a static Astro website.

## What it does

- Researches a named startup company, optionally starting from an official URL.
- Generates structured report artifacts under `reports/`.
- Consolidates evidence and claim references into a final evidence ledger.
- Renders complete reports, summary cards, search pages, filters, scorecards, tables, and native figures through the Astro website.

## Repository layout

```text
.agents/skills/startup-research/  # report-generation workflow skill
.agents/skills/fetch-url/         # direct URL fetch helper skill
.agents/skills/translate-zh/      # Simplified Chinese overlay workflow skill
reports/                          # generated report runs (one folder per finalized run)
website/                          # Astro static site and website-owned validation
```

Important files:

- `.agents/skills/startup-research/SKILL.md` — thin end-to-end workflow entry point that loads runtime contracts.
- `.agents/skills/startup-research/references/workflow-config.yaml` — workflow inputs, conditions, phases, policy, chapter order, artifacts, gates, and requirements.
- `.agents/skills/startup-research/references/contracts.md` — generated agent-readable contract reference.
- `.agents/skills/startup-research/scripts/contracts/` — executable Zod schemas for workflow config, report artifacts, and runtime context.
- `.agents/skills/startup-research/scripts/` — skill-owned workflow scripts (chapter loader, gate checks, ledger consolidation, report assembly, validators).
- `.agents/skills/translate-zh/SKILL.md` — Simplified Chinese sparse-overlay workflow for finalized reports.
- `website/src/lib/` — rendering contracts shared between the renderer and the chapter/report validators.
- `AGENTS.md` — repo-development conventions (working rules, core philosophy). Read before touching skills, scripts, or schemas.
- `.agents/skills/README.md` — skills index and skill-folder conventions.

## Quick start

Install dependencies from the repository root:

```bash
npm install
npm --prefix website install
```

Run all validation and build checks:

```bash
npm run validate
```

Start the website locally:

```bash
npm --prefix website run dev
```

## Automation

GitHub Actions owns all recurring automation so schedules and failures remain
visible in one place:

- `research-unicorns.yml` discovers and generates one new report every six hours.
- `refresh-portfolio.yml` refreshes the existing report portfolio daily.
- `translate-reports-zh.yml` translates one report every two hours.
- `validate-main.yml` validates each relevant push, including workflow-only changes, and deploys only the validated
  site artifact.

Publication retries use `STARTUP_PAT` for checkout, push and PR fallback; give
that PAT contents and pull-request write permissions. The fallback does not
override it with the Actions token, which repository policy may forbid from
creating PRs. Translation runs fully validate before publication. A report-only
rebase reruns selected strict translation checks, corpus report/translation
contracts and revision checks without rebuilding the unchanged site code;
non-report changes still require full validation. Every accepted main push
receives a fresh validated deployment.

Generation and translation jobs check automation configuration before invoking
models; the portfolio planner checks it before launching its refresh matrix.
All Copilot jobs on Ubuntu x64 install the CLI and its matching native package
as required dependencies, then run `copilot --version` before generation.
This prevents npm's optional-package handling from reporting a successful
installation when the executable is missing.
Translation uses the `translation-draft` default for drafting and the
`translation-qa` default/escalation routes for editing and bounded repair.
Keep the workflow and `model-routing.yaml` aligned when changing these models.
Editorial workers edit prepared bundles only; the workflow owns acceptance,
rollback and cache cleanup. Research bootstrap can refill exhausted reserves
once from unused discovery results or surplus backups of healthy chapters
(at most six per failing chapter), preserving exclusive URL ownership and
every chapter's recommended evidence. It still requires the same successfully
fetched source, domain and net-new evidence floors. Successfully fetched,
nonexclusive evidence can also fill another chapter's source/domain shortfall
without moving its owner's evidence or counting it as net-new.
Discovery expands a formal company name only with a shortened brand that
matches its official domain; external alias matches require that brand in
both the title and URL, not just a search snippet.
This includes formal `Global` and `Biosciences` suffixes, not arbitrary
company-name truncation.
Refresh chapters rotate through retained unresolved gaps within their existing
query budgets rather than all searching only the first gap.
Finalizer retries receive source diagnostics even when
assembly stopped before producing final report artifacts.
New-company discovery starts with the repository's URL-based search tool; host
search is supplementary. For `Any`, portfolio coverage is a preference rather
than a sector exclusion. The bounded retry reads the first pass's local log and
candidate decisions; discovery logs and cached evidence remain in the run
artifact even when no report folder was created.
A search outage or lack of a verified new candidate
still blocks generation rather than publishing an invented or duplicate report.

`cloudflare/worker.js` retains an optional dispatcher compatible with the old
hourly Cloudflare trigger. It targets the current workflows, requests one report
per research/translation run, and leaves model selection to workflow defaults.
This is repository source only: no Cloudflare trigger or deployment is configured
here. Do not enable it alongside the native GitHub schedules above.
Run its isolated dispatch checks with `node --test cloudflare/worker.test.mjs`.

## Generate a report

Ask the coding agent to run the Startup Research workflow with a company name and optional official URL, for example:

> Research Perplexity AI — official site https://www.perplexity.ai.

The workflow writes a new run under:

```text
reports/<YYYYMMDDHHmmss>-<company-slug>/
```

A complete report run contains:

```text
01-company-overview.yaml
02-market-analysis.yaml
03-competitors.yaml
04-financials.yaml
05-product-tech.yaml
06-customers.yaml
07-risks.yaml
08-valuation.yaml
evidence.yaml
full-report.yaml
report-meta.yaml
summary-card.yaml
```

Some finalized runs also contain Simplified Chinese overlay artifacts:

```text
summary-card.zh.yaml
full-report.zh.yaml
```

The `*.zh.yaml` files are sparse overlays for whitelisted translatable text, not full copies of the English YAML. They must be produced and checked through the translation workflow, not hand-assembled.

After generation, run:

```bash
npm run validate
```

## Chinese overlays

Use the translate-zh workflow for Simplified Chinese report overlays:

```bash
npm run translate:zh -- preflight <run-id-or-company-name>
npm run translate:zh -- init <run-id-or-company-name>
npm run translate:zh -- finalize-summary <run-id-or-company-name>
npm run translate:zh -- finalize-full <run-id-or-company-name>
npm run translate:zh -- verify <run-id-or-company-name>
```

Check all existing Chinese overlays with:

```bash
npm run check:translations-zh
```

The root `npm run validate` command includes this translation check.

Existing translations can be repaired in batches from reviewed, source-anchored
patches, without rewriting whole reports:

```bash
npm run translate:zh -- repair-batch reviewed-fixes.json          # preview only
npm run translate:zh -- repair-batch reviewed-fixes.json --apply
```

The [translation skill](.agents/skills/translate-zh/SKILL.md#batching-reviewed-repairs)
documents the patch format and per-report rollback/checks. This applies approved
Chinese fixes; it does not generate factual corrections or bypass quality gates.
Run `npm run validate` once for the accepted batch before publishing.

## Validation commands

From the repository root:

```bash
npm run check:workflow-config
npm run check:revision-graph
npm run check:reports-contract
npm run check:translations-zh
npm run validate
```

For finalized report maintenance, `npm run check:reports-contract` verifies the assembled report artifacts. If it reports orphan exhibits, fix the source chapter YAML by anchoring each affected table or figure under the section whose prose introduces it via `section.tableRefs` or `section.figureRefs`, then rebuild the assembled artifacts for that report:

```bash
node .agents/skills/startup-research/scripts/build-report.mjs reports/<run-id>
npm run check:reports-contract
```

For normal report generation, prefer the full startup-research workflow and `finalize-report.mjs`; use `build-report.mjs` only when maintaining existing finalized reports and the chapter/evidence ledger is already current.

The historical YAML migration is complete. Current schema and renderer checks
reject unsupported snapshot fields and figure layouts; validation no longer runs
the retired one-off migration utility.

### Incremental builds

Both `--all` validators and the website loader are digest-keyed, so unchanged report folders are skipped on rebuild:

- [.agents/skills/startup-research/scripts/check-reports.mjs](.agents/skills/startup-research/scripts/check-reports.mjs) hashes every YAML in each `reports/<run>/` folder (plus `CHECK_VERSION`) and persists `.cache/check-reports.json`. Failures are never cached. Bump `CHECK_VERSION` when validation rules change. Set `CHECK_REPORT_NO_CACHE=1` to bypass.
- [.agents/skills/translate-zh/scripts/check-translations.mjs](.agents/skills/translate-zh/scripts/check-translations.mjs) hashes both `*.yaml` and `*.zh.yaml` per folder (plus `CHECK_VERSION` and the `--strict` / `--require-final` flags) and persists `.cache/check-translations.json`. Same failure / version semantics. Set `CHECK_TRANSLATION_NO_CACHE=1` to bypass.
- [website/src/content/reports-loader.ts](website/src/content/reports-loader.ts) hashes each `summary-card.yaml` (plus `LOADER_VERSION`) and reuses Astro's persistent content store at `website/.astro/data-store.json`. Bump `LOADER_VERSION` when the loader's parsing surface or the Zod schema in [content.config.ts](website/src/content.config.ts) changes.

In CI, [`validate-main.yml`](.github/workflows/validate-main.yml) runs full validation, builds the site, and deploys that same validated artifact to GitHub Pages. The retired `deploy.yml` workflow is no longer used.

Model-driven publishers snapshot their checkout before generation and copy the
committed publication-scope guard into the runner's temporary directory. Before
approval, the guard rejects uncommitted code changes, unexpected staging,
untracked files outside the output scope, and model-created commits rather than
grading with unpublished scripts. Translation permits only the selected Chinese
outputs; research permits report files, including legitimate refresh lineage
updates. Ignored working caches remain available.

Successful rebases rerun publication checks when the approved commit changes.
Translations also retain hashes of both selected English inputs: changed source
prose blocks publication even when its numbers remain identical. Changed
dependency manifests trigger a clean install before revalidation. Report agents
run their assigned per-report checks; the workflows own repository-wide checks
and builds. This publication-integrity boundary is not an operating-system
sandbox or an independent factual audit.

From `website/`:

```bash
npm run build
npm run preview
```

## Ownership boundaries

- Skill workflow scripts live under `.agents/skills/*/scripts/` and are called directly with `node` by the skills.
- Website code and website validators live under `website/`.
- The root `package.json` exposes repository-level checks and the `translate:zh` runner; other skill-internal workflow steps are called directly by their skills.
- Report workflow details belong in `.agents/skills/startup-research/SKILL.md`, not in this README.
