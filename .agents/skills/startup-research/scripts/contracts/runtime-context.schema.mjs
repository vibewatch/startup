// Executable schema for the agent-facing chapter runtime context.
//
// The runtime context emits per-chapter and per-run deltas only. The static
// frame (agent policy, gates, ID system, validator dimensions, renderer
// contracts) lives in references/rules.md (generated from workflow-config.yaml,
// validation-catalog.mjs, and website/src/lib/figures.mjs). Field shapes for
// chapter and report-meta YAML live in references/contracts.md (generated
// from report-artifacts.schema.mjs). Read both once at session start.
//
// This schema is intentionally permissive for projected nested objects whose
// authoritative contracts live in workflow-config.schema.mjs and
// report-artifacts.schema.mjs.

import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'must be a non-empty string');
const nullableString = z.string().nullable();

export const CompactChapterSchema = z.object({
  key: nonEmptyString,
  order: z.number().int().positive(),
  letter: z.string().regex(/^[A-Z]$/),
  file: nonEmptyString,
  title: nonEmptyString,
  mission: nonEmptyString,
  optionalContext: z.array(nonEmptyString),
  contentRequirements: z.array(nonEmptyString),
  plannedTables: z.array(z.record(z.string(), z.any())),
  plannedFigures: z.array(z.record(z.string(), z.any())),
  evidenceStrategy: z.array(nonEmptyString),
  qualityBar: z.array(nonEmptyString),
  gate: z.record(z.string(), z.any()),
}).strict();

export const ContextChapterSchema = z.object({
  key: nonEmptyString,
  file: nonEmptyString,
  status: z.enum(['loaded', 'missing', 'parseError', 'unknownKey']),
  error: nullableString.optional(),
  artifact: nullableString.optional(),
  title: nullableString.optional(),
  summary: nullableString.optional(),
  sections: z.array(z.record(z.string(), z.any())),
  tables: z.array(z.record(z.string(), z.any())),
  figures: z.array(z.record(z.string(), z.any())),
}).passthrough();

export const ChapterRuntimeContextSchema = z.object({
  schemaVersion: z.literal('chapter-runtime-context-v3'),
  generatedFrom: nonEmptyString,
  totalChapters: z.number().int().positive(),
  previousChapter: CompactChapterSchema.nullable(),
  chapter: CompactChapterSchema,
  nextChapter: CompactChapterSchema.nullable(),
  contextChapters: z.array(ContextChapterSchema).optional(),
  cumulativeContext: z.object({
    note: z.string(),
    // True when one or more earlier chapters could not be loaded. Subagents
    // drafting chapters in parallel should treat the rollup as incomplete
    // when this is true and prefer per-chapter signals instead.
    partial: z.boolean().optional(),
    warnings: z.array(z.object({
      code: z.string(),
      message: z.string(),
      missingFiles: z.array(nonEmptyString).optional(),
    }).passthrough()).optional(),
    cumulativeUnresolvedQuestions: z.number().describe('Sum of researchQuestions across all earlier loaded chapters whose status is not "answered". Advisory only; never gates this chapter.'),
    cumulativeRestrictedAccessPct: z.number().describe('Share of localEvidence.sources across all earlier loaded chapters whose accessStatus is paywall|js-only|broken|rate-limited (the report-level paywall ceiling pool). Range 0..1, rounded to 3 decimals. Advisory only; never gates this chapter.'),
    earlierChapters: z.array(z.record(z.string(), z.any())),
  }).passthrough().optional(),
  run: z.object({
    runId: nonEmptyString,
    companySlug: nullableString,
    runDate: nullableString,
  }).strict().optional(),
  runCache: z.object({
    cacheDir: nullableString,
    refreshContext: z.record(z.string(), z.any()).nullable(),
  }).strict().optional(),
  // Minimal slice of the workflow agentPolicy that workers must see even
  // when they do not load references/rules.md. Keep this small — it is the
  // delta a sub-orchestrator-spawned chapter worker cannot get any other way.
  policy: z.object({
    retryPolicy: z.object({
      maxChapterRetries: z.number().int().nonnegative(),
      requireMonotonicFailureDecrease: z.boolean(),
    }).strict().describe('Per-chapter retry budget enforced by the agent (no script blocks a non-monotonic retry). Workers must surface a blocker once the budget is exhausted or the failure count fails to strictly decrease across retries.'),
    workerRouting: z.object({
      profile: z.enum(['chapter-synthesis', 'chapter-synthesis-fast']),
      model: nonEmptyString,
      reasoningEffort: nonEmptyString,
      escalateTo: nullableString,
    }).strict().describe('Binding model and reasoning effort for the chapter worker. The orchestrator must pass both values when spawning the worker; top-level CLI settings do not reliably propagate to subagents.'),
  }).strict().optional(),
}).strict();

export const ChapterRuntimeContextListSchema = z.object({
  schemaVersion: z.literal('chapter-runtime-context-list-v3'),
  generatedFrom: nonEmptyString,
  totalChapters: z.number().int().positive(),
  chapters: z.array(CompactChapterSchema),
}).strict();
