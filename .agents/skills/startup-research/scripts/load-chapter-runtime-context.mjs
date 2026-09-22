#!/usr/bin/env node
// Load the per-chapter runtime context used by the startup-research skill.
//
// This emits ONLY the per-chapter and per-run deltas: the chapter brief, the
// neighbouring chapters, run identity, refresh cache, and earlier-chapter
// rollups. The static frame (agent policy, gates, ID system, validator
// dimensions, renderer contracts) lives in references/rules.md and
// references/contracts.md and is generated from the same sources of truth —
// read those once at session start instead of re-shipping them per chapter.
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  EXIT,
  isRunId,
  loadWorkflowConfig,
  modelRoutingPath,
  readYaml,
  companySlugFromRunId,
  researchCacheDir,
  runDateFromRunId,
  tryReadYaml,
  workflowConfigPath,
  workflowSnapshotPathFor,
} from './utils.mjs';
import { RESTRICTED_ACCESS_STATUSES } from './validation-catalog.mjs';

function usage() {
  console.error(`Usage: node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs [--order <n> | --key <key> | --file <artifact.yaml> | --list] [--report-folder <path>] [--include-context]

Examples:
    node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --list
    node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --order 1 --report-folder reports/20260503145959-openai
    node .agents/skills/startup-research/scripts/load-chapter-runtime-context.mjs --order 4 --include-context --report-folder reports/20260503145959-openai

  Selectors are interchangeable: --order matches by chapter.order (1-based), --key by chapter.key ("company-overview" / "market-analysis" / ...),
  and --file by chapter.file ("01-company-overview.yaml" / ...). Pick whichever the loop already has on hand. SKILL.md uses --order in its narrative;
  --key/--file are equivalent and useful in retry loops where the chapter key or file path is what failed.

  --report-folder alone projects run identity (run.runDate) and runCache.refreshContext.
  Add --include-context to also project earlier-chapter rollups (contextChapters, cumulativeContext);
  omit it for the first chapter or for parallel drafting to avoid stale rollups.`);
  process.exit(EXIT.failure);
}

function parseArgs(argv) {
  const args = {
    order: null,
    key: null,
    file: null,
    list: false,
    includeContext: false,
    reportFolder: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage();
    else if (arg === '--order') args.order = Number(argv[++i]);
    else if (arg === '--key') args.key = argv[++i] ?? null;
    else if (arg === '--file') args.file = argv[++i] ?? null;
    else if (arg === '--list') args.list = true;
    else if (arg === '--include-context') args.includeContext = true;
    else if (arg === '--report-folder') args.reportFolder = argv[++i] ?? null;
    else usage();
  }

  const selectors = [Number.isFinite(args.order), Boolean(args.key), Boolean(args.file), args.list].filter(Boolean).length;
  if (selectors > 1) usage();
  if (args.order !== null && !Number.isInteger(args.order)) usage();
  if (!selectors) args.list = true;

  return args;
}

function compactChapter(chapter) {
  return {
    key: chapter.key,
    order: chapter.order,
    letter: chapter.letter,
    file: chapter.file,
    title: chapter.title,
    mission: chapter.mission,
    optionalContext: chapter.optionalContext ?? [],
    contentRequirements: chapter.contentRequirements ?? [],
    plannedTables: chapter.plannedTables ?? [],
    plannedFigures: chapter.plannedFigures ?? [],
    evidenceStrategy: chapter.evidenceStrategy ?? [],
    qualityBar: chapter.qualityBar ?? [],
    // gate already carries gate.minAdverseSources (and any other workflow-
    // config-derived floors) because normalizeWorkflowConfig in utils.mjs
    // injects them — the same gate object check-chapter reads, so the runtime context
    // the agent receives and the check it must clear can never drift apart.
    gate: chapter.gate,
  };
}

function compactContextChapter(reportFolder, contextFile) {
  const path = join(reportFolder, contextFile);
  const result = tryReadYaml(path);
  if (!result.ok) {
    const status = result.error.startsWith('ENOENT') ? 'missing' : 'parseError';
    return { file: contextFile, status, ...(status === 'parseError' ? { error: result.error } : {}), sections: [], tables: [], figures: [] };
  }
  const doc = result.value;
  return {
    file: contextFile,
    status: 'loaded',
    artifact: doc.artifact ?? null,
    title: doc.chapter?.title ?? null,
    summary: doc.chapter?.summary ?? null,
    sections: (doc.sections ?? []).map((section) => ({
      id: section.id,
      title: section.title,
      claimRefs: section.claimRefs ?? [],
    })),
    tables: (doc.tables ?? []).map((table) => ({
      id: table.id,
      title: table.title,
      claimRefs: table.claimRefs ?? [],
    })),
    figures: (doc.figures ?? []).map((figure) => ({
      id: figure.id,
      title: figure.title,
      type: figure.type,
      claimRefs: figure.claimRefs ?? [],
    })),
  };
}

// Aggregates cumulative diligence signal from chapters that come BEFORE the
// chapter currently being authored. Surfaces (advisory only) two metrics:
//   - cumulativeUnresolvedQuestions: sum of researchQuestions whose status is
//     not `answered` across earlier chapters.
//   - cumulativeRestrictedAccessPct: share of localEvidence.sources whose
//     accessStatus is paywall|js-only|broken|rate-limited across earlier
//     chapters.
// Returned as a runtime-context field; never gates anything.
//
// `partial` and `warnings` flag the case where one or more earlier chapters
// could not be loaded (most commonly because the agent is drafting chapters
// in parallel and a prior file is not on disk yet). Without this flag a
// subagent that mechanically passes --include-context would treat the
// cumulative metrics as authoritative when they are actually computed over
// an incomplete set of siblings.
function cumulativeContext(reportFolder, currentOrder, allChapters) {
  let unanswered = 0;
  let totalSources = 0;
  let restricted = 0;
  const seen = [];
  for (const ch of allChapters) {
    if (ch.order >= currentOrder) continue;
    const result = tryReadYaml(join(reportFolder, ch.file));
    if (!result.ok) {
      // Keep the field set stable across loaded/missing entries so consumers
      // can read entry.unanswered without checking entry.status first.
      seen.push({ file: ch.file, status: 'missing', unanswered: null, sources: null, restricted: null });
      continue;
    }
    const doc = result.value ?? {};
    const sources = doc.localEvidence?.sources ?? [];
    const questions = doc.localEvidence?.researchQuestions ?? [];
    const chUnanswered = questions.filter((q) => q?.status !== 'answered').length;
    const chRestricted = sources.filter((s) => RESTRICTED_ACCESS_STATUSES.has(s?.accessStatus)).length;
    unanswered += chUnanswered;
    totalSources += sources.length;
    restricted += chRestricted;
    seen.push({ file: ch.file, status: 'loaded', unanswered: chUnanswered, sources: sources.length, restricted: chRestricted });
  }
  const missing = seen.filter((entry) => entry.status !== 'loaded');
  const warnings = missing.length > 0
    ? [{
        code: 'cumulativeContextPartial',
        message: `--include-context aggregated ${seen.length - missing.length}/${seen.length} earlier chapters; ${missing.length} are missing or unreadable. Treat the rollup as incomplete (most likely parallel drafting).`,
        missingFiles: missing.map((entry) => entry.file),
      }]
    : [];
  return {
    note: 'Advisory metrics aggregated from earlier chapters; does not gate this chapter.',
    partial: missing.length > 0,
    warnings,
    cumulativeUnresolvedQuestions: unanswered,
    cumulativeRestrictedAccessPct: totalSources ? +(restricted / totalSources).toFixed(3) : 0,
    earlierChapters: seen,
  };
}

// Run identity derived from the report folder name. Split out from runCache
// because none of these come from `.research-cache/` — they are slices of the
// runId itself. `runtimeContext.run.runDate` is the single canonical clock
// anchor chapter doc heads must copy as `runDate`; source-discovery query
// planning derives any year/month tokens from this value before searching.
function runIdentity(reportFolder) {
  const runId = basename(reportFolder);
  if (!isRunId(runId)) {
    return { runId, companySlug: null, runDate: null };
  }
  const runDate = runDateFromRunId(runId);
  return {
    runId,
    companySlug: companySlugFromRunId(runId),
    runDate,
  };
}

// Per-run scratch surfaced into the chapter runtime context. create-report-run.mjs writes
// these into .research-cache/<runId>/ but historically they were never
// loaded back, so an agent invoking --refresh would never see the context.
// Surface it inside the runtime context so the agent reads the same file the
// orchestrator wrote.
//   refreshContext: prior-run summary card snapshot used as background /
//     diff context only; volatile facts must still be re-fetched.
function runCacheContext(reportFolder) {
  const runId = basename(reportFolder);
  // Be permissive about --report-folder: if the basename is not a runId
  // (developer pointing at a scratch folder), return an empty cache slot
  // instead of crashing the chapter runtime context loader.
  if (!isRunId(runId)) {
    return { cacheDir: null, refreshContext: null };
  }
  const cacheDir = researchCacheDir(runId);
  const out = {
    cacheDir,
    refreshContext: null,
  };
  const refresh = tryReadYaml(join(cacheDir, 'refresh-context.yaml'));
  if (refresh.ok) out.refreshContext = refresh.value;
  return out;
}

function buildRuntimeContext(config, chapter, generatedFrom = workflowConfigPath) {
  const chapters = config.chapters;
  const index = chapters.findIndex((item) => item.order === chapter.order);
  const out = {
    schemaVersion: 'chapter-runtime-context-v3',
    generatedFrom,
    totalChapters: chapters.length,
    previousChapter: index > 0 ? compactChapter(chapters[index - 1]) : null,
    chapter: compactChapter(chapter),
    nextChapter: index < chapters.length - 1 ? compactChapter(chapters[index + 1]) : null,
  };
  // Project the per-chapter retry budget so subagent workers see the
  // enforcement contract without re-reading rules.md. workflow-config.schema
  // makes both fields required, so we emit the policy block unconditionally.
  const retryPolicy = config.agentPolicy.retryPolicy;
  const workerProfile = config.activeResearchProfile === 'fast'
    ? 'chapter-synthesis-fast'
    : 'chapter-synthesis';
  const workerRoute = readYaml(modelRoutingPath).profiles?.[workerProfile];
  if (!workerRoute?.defaultCopilotModel || !workerRoute?.reasoningEffort) {
    throw new Error(`[chapter] missing model route for ${workerProfile}`);
  }
  out.policy = {
    retryPolicy: {
      maxChapterRetries: retryPolicy.maxChapterRetries,
      requireMonotonicFailureDecrease: retryPolicy.requireMonotonicFailureDecrease,
    },
    workerRouting: {
      profile: workerProfile,
      model: workerRoute.defaultCopilotModel,
      reasoningEffort: workerRoute.reasoningEffort,
      escalateTo: workerRoute.escalateTo ?? null,
    },
  };
  return out;
}

function selectChapter(config, args) {
  if (Number.isFinite(args.order)) return config.chapters.find((chapter) => chapter.order === args.order) ?? null;
  if (args.key) return config.chapters.find((chapter) => chapter.key === args.key) ?? null;
  if (args.file) return config.chapters.find((chapter) => chapter.file === args.file) ?? null;
  return null;
}

function orderedList(config, generatedFrom = workflowConfigPath) {
  return {
    schemaVersion: 'chapter-runtime-context-list-v3',
    generatedFrom,
    totalChapters: config.chapters.length,
    chapters: config.chapters.map(compactChapter),
  };
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadWorkflowConfig({ reportFolder: args.reportFolder });
  const snapshotPath = args.reportFolder ? workflowSnapshotPathFor(args.reportFolder) : '';
  const generatedFrom = snapshotPath && existsSync(snapshotPath)
    ? snapshotPath
    : workflowConfigPath;

  if (args.list) {
    printJson(orderedList(config, generatedFrom));
    return;
  }

  const chapter = selectChapter(config, args);
  if (!chapter) {
    console.error('[chapter] no chapter matched the provided selector');
    process.exit(EXIT.failure);
  }
  if (args.includeContext && !args.reportFolder) {
    console.error('[chapter] --include-context requires --report-folder <path>');
    process.exit(EXIT.failure);
  }
  const runtimeContext = buildRuntimeContext(config, chapter, generatedFrom);
  // run identity (run.runDate) and runCache (refresh-context) are always
  // emitted when --report-folder is supplied, regardless of --include-context.
  // The agent needs run.runDate as the canonical clock anchor for chapter doc
  // heads and source-discovery query planning even on the first chapter or
  // during parallel drafting (when --include-context is intentionally omitted
  // to avoid projecting a stale cumulative rollup of unfinished sibling
  // chapters).
  if (args.reportFolder) {
    runtimeContext.run = runIdentity(args.reportFolder);
    runtimeContext.runCache = runCacheContext(args.reportFolder);
  }
  // contextChapters and cumulativeContext aggregate sibling chapters and
  // therefore go stale during parallel drafting; gate them on --include-context.
  if (args.includeContext) {
    const fileByKey = new Map(config.chapters.map((item) => [item.key, item.file]));
    runtimeContext.contextChapters = (chapter.optionalContext ?? []).map((key) => {
      const file = fileByKey.get(key);
      if (!file) return { key, status: 'unknownKey', sections: [], tables: [], figures: [] };
      return { key, ...compactContextChapter(args.reportFolder, file) };
    });
    runtimeContext.cumulativeContext = cumulativeContext(args.reportFolder, chapter.order, config.chapters);
  }
  printJson(runtimeContext);
}

main();