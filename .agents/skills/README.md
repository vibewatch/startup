# Skills

This folder holds the workflow skills the coding agent invokes. Each skill's `SKILL.md` is its entry point.

## Available skills

- **`startup-research/`** — end-to-end report-v2 diligence pipeline. Owns the chapter loop, per-chapter and report-level checks, ledger consolidation, and final artifact assembly.
- **`fetch-url/`** — fetch one URL and return readable HTML text or PDF-extracted text. Includes identity-profile retries (curl-impersonate), a per-host strategy map, reader/wayback fallbacks, and an on-disk cache.
- **`translate-zh/`** — translate finalized report artifacts into Simplified Chinese overlays (`summary-card.zh.yaml` and `full-report.zh.yaml`) using the sparse-bundle workflow.

## Conventions

- Skill scripts live under `<skill>/scripts/`. Validation logic that must run both during chapter generation and at report-build time (e.g. figure shape contracts) is shared via `website/src/lib/` modules imported by the skill validators.
- Invoke skill scripts directly: `node .agents/skills/<skill>/scripts/<name>.mjs`. Keep root npm aliases limited to repository-level checks and user-facing runners such as `translate:zh`.
- Use `npm run reports:duplicates` for a dry-run of exact current duplicates and `npm run reports:dedupe` to keep the newest finalized report in each safe group. Use `npm run --silent startup:refresh -- "<company>" --website "<url>" --refresh-reason "<reason>"` to create a refresh run. Automated fast runs then call `npm run research:profile -- --report-folder <folder> --profile fast`, `npm run research:bootstrap -- --report-folder <folder> --profile fast`, `npm run research:workers -- --report-folder <folder>`, and `npm run research:finalize -- --report-folder <folder>`; the bounded runners own independently routed chapter processes, convergence, metadata, artifact verification, and final report gates. `npm run check:research-profile` and `npm run check:chapter-workers` guard snapshot loading and process routing. Deep/manual runs keep the original gates. Use `npm run refresh:plan` to inspect the deterministic daily batch that keeps every current report on a monthly refresh cycle; `.github/workflows/refresh-portfolio.yml` runs that plan daily. Report jobs run targeted contract checks before publishing, while `.github/workflows/validate-main.yml` performs the full historical validation and Astro build after changes land on `main`.
- Use `npm run research:evaluate -- reports/<runId> --format json` after finalization to measure evidence reuse, source mix, question closure, blocking gaps, and output size.
- For startup report contract maintenance, use `npm run check:reports-contract`. If finalized reports have orphan exhibits, anchor the affected table/figure ids in the source chapter's `tableRefs`/`figureRefs`, rebuild with `node .agents/skills/startup-research/scripts/build-report.mjs reports/<run-id>`, then rerun the contract check.
- For Simplified Chinese overlay maintenance, use `npm run check:translations-zh` for all overlays or `npm run translate:zh -- verify <run-id>` for one report. To improve an existing overlay without retranslating clean leaves, run `repair-init`, edit only the printed target paths, finalize with `--keep-cache`, then run `measure` for the saved before/after quality delta.
