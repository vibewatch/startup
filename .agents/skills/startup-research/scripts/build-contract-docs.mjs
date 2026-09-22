#!/usr/bin/env node
// Generate the agent-facing contract reference from executable schemas.
//
// Field shapes and inline descriptions come straight out of the Zod schemas in
// scripts/contracts/report-artifacts.schema.mjs. Keep the schemas annotated
// with `.describe(...)` and the rendered Markdown will stay in sync.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnalysisArtifactSchema,
  ReportMetaSchema,
  SCHEMA_VERSION,
} from './contracts/report-artifacts.schema.mjs';
import {
  ChapterRuntimeContextSchema,
  ChapterRuntimeContextListSchema,
} from './contracts/runtime-context.schema.mjs';
import { renderSchemaAsYaml } from './contracts/contract-yaml-renderer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../references/contracts.md');

function yamlBlock(value) {
  return ['```yaml', value.trimEnd(), '```'].join('\n');
}

const text = `<!-- GENERATED FILE: edit scripts/contracts/*.schema.mjs (use \`.describe()\` to annotate fields), then run npm run build:contracts. -->

# startup-research contracts

Schema version: \`${SCHEMA_VERSION}\`. Field shapes and inline comments are generated from the Zod schemas in \`scripts/contracts/report-artifacts.schema.mjs\`.

## What you author vs. what is generated

You hand-write two kinds of YAML in each report folder:

1. **Per-chapter analysis YAML** at \`<reportFolder>/<chapter.file>\` (one per configured chapter) — see *Analysis chapter shape* below.
2. **\`<reportFolder>/report-meta.yaml\`** — see *Report meta shape* below.

Authoring stops there. \`finalize-report.mjs\` produces every other artifact in the folder from those inputs:

- \`evidence.yaml\` is a **consolidated** ledger built from each chapter's \`localEvidence\` by \`build-evidence-ledger.mjs\`. It does not renumber: chapter ids stay as you wrote them, and duplicates across chapters get tagged with a \`canonical\` pointer to the first occurrence.
- \`full-report.yaml\` and \`summary-card.yaml\` are assembled by \`build-report.mjs\` from the chapter YAMLs and \`report-meta.yaml\`.
- \`.workflow-snapshot.yaml\` is script-owned. \`apply-research-profile.mjs\` may write a resolved fast/deep snapshot before chapter work; otherwise \`finalize-report.mjs\` freezes the deep head config on first finalize. Every downstream validator loads this snapshot in preference to the head config, so later edits never retroactively re-judge the report. Never hand-edit it; pass \`--refresh-snapshot\` to finalize-report only when you intentionally want the report re-judged against the current deep head config.

Vocabularies (enum value sets) are listed inline below at each enum field. Agent policy, gates, IDs, renderer rules, and the on-demand validator catalog live in [\`rules.md\`](rules.md). Chapter workers need the analysis shape; the orchestrator needs report-meta before finalization. Do not preload unrelated sections.

### Reading conventions

Field comments below reference \`runtimeContext.X\` paths. \`runtimeContext\` is the per-chapter JSON projection emitted by \`node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --order <n> --report-folder <reportFolder> [--include-context]\`; omit \`--include-context\` during parallel drafting. It carries only the chapter brief, neighbouring chapters, run identity, refresh cache, and earlier-chapter rollups — no workflow/policy/vocabulary content. The id shorthand used throughout (\`S<L>###\`, \`C<L>###\`, …) is documented under *ID system* in [\`rules.md\`](rules.md).

## Analysis chapter shape

One file per configured chapter at \`<reportFolder>/<chapter.file>\`. The first five fields (\`schemaVersion\` through \`company\`) are the shared document head reused by \`report-meta.yaml\` (without \`schemaVersion\` / \`artifact\`).

${yamlBlock(renderSchemaAsYaml(AnalysisArtifactSchema))}

## Report meta shape

\`<reportFolder>/report-meta.yaml\` — owns the final judgment, cover facts, and company profile.

${yamlBlock(renderSchemaAsYaml(ReportMetaSchema))}

## Chapter runtime context shape

The per-chapter projection produced by \`load-chapter-runtime-context.mjs --order <n> [--report-folder <path>] [--include-context]\`. Field availability:

- Always present: \`schemaVersion\`, \`generatedFrom\`, \`totalChapters\`, \`previousChapter\`, \`chapter\`, \`nextChapter\`, \`policy\`. \`policy.retryPolicy\` carries the per-chapter retry budget (\`maxChapterRetries\`) and the monotonic-decrease rule that workers must enforce themselves; no script blocks a non-monotonic retry.
- Present whenever \`--report-folder\` is supplied (including the first chapter and parallel-drafting): \`run\`, \`runCache\`. \`run.runDate\` is the single canonical clock anchor; copy it into every chapter doc head's \`runDate\` and derive any source-discovery query date tokens from it before searching.
- Present only with \`--include-context\` (omit during parallel drafting to avoid stale rollups): \`contextChapters\`, \`cumulativeContext\`.

${yamlBlock(renderSchemaAsYaml(ChapterRuntimeContextSchema))}

The list-mode projection (\`--list\`) emits the chapter roster only:

${yamlBlock(renderSchemaAsYaml(ChapterRuntimeContextListSchema))}

## Validation result envelope

Every \`check-*.mjs --format json\` returns this envelope. Note that the schema shapes above are only one validation layer — \`check-chapter\` and \`check-report\` also enforce semantic gates (cross-references, source diversity, freshness, duplicate analysis, depth floors, …) listed in [\`rules.md\`](rules.md) under *Validator dimensions*. When a gate fails, read \`issues[].fix\`, \`globalHints[].fix\`, and \`retryOrder[]\` before guessing.

Conditional keys (marked optional below) are emitted by the envelope only when non-empty: \`retryOrder\`, \`suppressedDimensions\`, \`globalHints\`, \`counts\`, and \`objectFailures\` are all omitted from the JSON when their value is empty / null. Code that reads these keys must tolerate them being absent.

${yamlBlock(`ok: boolean
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
summary: object                    # validator-specific (chapterKey, schema path, …)`)}

## YAML rules

- Use spaces, not tabs.
- Quote scalar strings containing colon-space (\`: \`) so YAML does not parse them as mappings.
- Use \`null\` for unknown optional values, not \`N/A\` or empty strings.
- Keep numeric fields numeric, not formatted strings with currency signs or commas.
- Do not use YAML anchors/aliases in report artifacts; generated reports should be explicit and portable.
`;

writeFileSync(outPath, text, 'utf8');
console.log(`[build-contract-docs] wrote ${outPath}`);
