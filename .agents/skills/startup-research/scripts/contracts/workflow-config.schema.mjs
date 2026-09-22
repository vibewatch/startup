// Executable schema for references/workflow-config.yaml.
//
// This module is the source of truth for workflow-config shape validation.
// utils.loadWorkflowConfig() uses normalizeWorkflowConfig(); check-workflow-config
// uses validateWorkflowConfig() so agents see every issue at once.

import { z } from 'zod';
import { FIGURE_TYPES } from '../../../../../website/src/lib/figures.mjs';
import { RESERVED_TYPE_LETTERS, SOURCE_TYPES } from '../validation-catalog.mjs';
import { validationIssue, zodIssues } from './validation-result.mjs';

const figureTypeSet = new Set(FIGURE_TYPES);

const nonEmptyString = z.string().trim().min(1, 'must be a non-empty string');
const stringArray = z.array(nonEmptyString);
const kebabKey = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case (a-z, 0-9, -)');
const inputKey = z.string().regex(/^[a-z][A-Za-z0-9-]*$/, 'must be an input key such as companyName or company-url');
const positiveInteger = z.number().int().positive('must be a positive integer');
const nonNegativeInteger = z.number().int().nonnegative('must be a non-negative integer');
const finiteNumber = z.number().finite('must be a finite number');
const rateNumber = z.number().min(0, 'must be between 0 and 1').max(1, 'must be between 0 and 1');

function enumMember(values, label) {
  const set = values instanceof Set ? values : new Set(values);
  return z.string().refine((value) => set.has(value), `${label} must be one of ${[...set].join('|')}`);
}

export const WorkflowInputSchema = z.object({
  type: z.enum(['string', 'url', 'boolean']),
  required: z.boolean(),
  description: nonEmptyString,
  default: z.any().optional(),
}).strict();

export const WorkflowConditionSchema = z.object({
  key: kebabKey,
  description: nonEmptyString,
  checkedBy: nonEmptyString,
}).strict();

export const WorkflowStepSchema = z.object({
  key: kebabKey,
  title: nonEmptyString,
  command: nonEmptyString.nullable().optional().describe('Shell command (with `<placeholders>`) the agent should run for this step. Set to null when the step is an agent-judgment preflight or planning action with no executable command (e.g. read references, decide whether to refresh); the agent must still satisfy the step\'s `produces` and `gate` before moving on.'),
  requires: stringArray.default([]),
  produces: stringArray.default([]),
  gate: nonEmptyString.nullable().optional(),
  notes: stringArray.default([]),
}).strict();

export const WorkflowPhaseSchema = z.object({
  key: kebabKey,
  title: nonEmptyString,
  objective: nonEmptyString,
  entryConditions: stringArray.default([]),
  exitConditions: stringArray.default([]),
  steps: z.array(WorkflowStepSchema).min(1, 'must include at least one step'),
}).strict();

export const WorkflowRuntimeSchema = z.object({
  inputs: z.record(inputKey, WorkflowInputSchema).refine((value) => Object.keys(value).length > 0, 'inputs must define at least one input'),
  conditions: z.array(WorkflowConditionSchema).default([]),
  phases: z.array(WorkflowPhaseSchema).min(1, 'workflow.phases must include at least one phase'),
}).strict();

export const AgentPolicySchema = z.object({
  volatileFacts: stringArray.default([]),
  // Lowercased substring tokens that mark a search query as volatile-fact-shaped.
  // Read by check-chapter.mjs `searchQueryFreshness` validator at runtime; if
  // a query contains any of these (case-insensitive substring match) it must
  // contain the year from runDate. The prior year may also appear for trailing
  // windows, but it does not replace the runDate year.
  volatileFactQueryTokens: stringArray.default([]),
  retryPolicy: z.object({
    maxChapterRetries: positiveInteger,
    requireMonotonicFailureDecrease: z.boolean(),
  }).strict(),
  researchRules: stringArray.default([]),
  chapterAuthoringRules: stringArray.default([]),
  hardRules: stringArray.default([]),
  finalResponseFields: stringArray.default([]),
}).strict();

export const GateDepthFloorSchema = z.object({
  minSectionBodyWords: finiteNumber,
  minSectionWordsTotal: finiteNumber,
  minTableRowsTotal: finiteNumber,
  minFigureDataPointsTotal: finiteNumber,
}).strict();

const gateNumericFields = {
  minSections: finiteNumber,
  maxSections: finiteNumber,
  minArtifacts: finiteNumber,
  maxTables: finiteNumber,
  maxFigures: finiteNumber,
  minResearchQuestions: finiteNumber,
  minQuestionTypeSpread: finiteNumber,
  minAdverseQuestions: finiteNumber,
  minLocalSources: finiteNumber,
  minLocalClaims: finiteNumber,
  minSourceDomains: finiteNumber,
  minNetNewSources: finiteNumber,
  minSourceTypeSpread: finiteNumber,
  minHighConfidenceCorroboration: finiteNumber,
  minSourcesPerEnumerationRow: finiteNumber,
};

export const CompleteGateSchema = z.object({
  ...gateNumericFields,
  maxResearchQuestions: finiteNumber.optional(),
  maxLocalSources: finiteNumber.optional(),
  maxLocalClaims: finiteNumber.optional(),
  minQuestionAnswerRate: rateNumber,
  minContentRequirementCoverage: rateNumber,
  requiredSourceTypes: z.array(enumMember(SOURCE_TYPES, 'sourceType')),
  depthFloor: GateDepthFloorSchema,
}).strict();

export const GateOverrideSchema = CompleteGateSchema.partial().extend({
  depthFloor: GateDepthFloorSchema.partial().strict().optional(),
}).strict();

export const ReportGateSchema = z.object({
  minDistinctDomains: positiveInteger.optional(),
  requireAdverseSource: z.boolean().optional(),
  maxPaywallPercent: rateNumber.optional(),
  minIndependentSourceShare: rateNumber.optional(),
  maxCompanyControlledSourceShare: rateNumber.optional(),
  crossChapterTolerances: z.object({
    metricDrift: rateNumber.optional(),
    keyFactOverlap: rateNumber.optional(),
    duplicateOverlap: rateNumber.optional(),
  }).strict().optional(),
}).strict();

export const AdverseDistributionSchema = z.object({
  requireAtLeastOneAdverseSource: z.array(kebabKey).default([]),
  warnIfChaptersWithAdverseSourceAtMost: nonNegativeInteger.optional(),
}).strict();

export const ResearchProfileSchema = z.object({
  description: nonEmptyString,
  defaultGate: GateOverrideSchema.default({}),
  reportGate: ReportGateSchema.default({}),
  maxPlannedTablesPerChapter: positiveInteger.optional(),
  maxPlannedFiguresPerChapter: positiveInteger.optional(),
  capChapterGateOverrides: z.boolean().default(false),
  clearRequiredSourceTypes: z.boolean().default(false),
}).strict();

const LEGACY_RESEARCH_PROFILES = {
  deep: {
    description: 'Legacy full-depth workflow snapshot.',
    defaultGate: {},
    reportGate: {},
    capChapterGateOverrides: false,
    clearRequiredSourceTypes: false,
  },
  fast: {
    description: 'Fast profile unavailable in this legacy workflow snapshot.',
    defaultGate: {},
    reportGate: {},
    capChapterGateOverrides: false,
    clearRequiredSourceTypes: false,
  },
};

export const PlannedTableSchema = z.object({
  name: nonEmptyString,
  requirement: nonEmptyString,
  enumeration: z.boolean().nullable().optional(),
  expectedMinRows: positiveInteger.nullable().optional(),
}).strict();

export const PlannedFigureSchema = z.object({
  name: nonEmptyString,
  requirement: nonEmptyString,
  acceptedTypes: z.array(enumMember(figureTypeSet, 'figureType')).min(1, 'acceptedTypes must include at least one figure type'),
}).strict();

export const ChapterConfigSchema = z.object({
  key: kebabKey,
  order: positiveInteger,
  letter: z.string().regex(/^[A-Z]$/, 'letter must be a single uppercase A-Z'),
  title: nonEmptyString,
  mission: nonEmptyString,
  optionalContext: z.array(kebabKey).default([]),
  contentRequirements: stringArray.default([]),
  plannedTables: z.array(PlannedTableSchema).default([]),
  plannedFigures: z.array(PlannedFigureSchema).default([]),
  evidenceStrategy: stringArray.default([]),
  qualityBar: stringArray.default([]),
  gate: GateOverrideSchema.optional(),
}).strict();

export const WorkflowConfigSchema = z.object({
  schemaVersion: z.literal('workflow-config-v1'),
  reportSchemaVersion: z.literal('report-v2'),
  activeResearchProfile: kebabKey.default('deep'),
  researchProfiles: z.record(kebabKey, ResearchProfileSchema).default(LEGACY_RESEARCH_PROFILES),
  workflow: WorkflowRuntimeSchema,
  agentPolicy: AgentPolicySchema,
  defaultGate: CompleteGateSchema,
  reportGate: ReportGateSchema.nullable().optional(),
  adverseDistribution: AdverseDistributionSchema.nullable().optional(),
  chapters: z.array(ChapterConfigSchema).min(1, 'chapters[] must be a non-empty array'),
}).strict();

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeGate(defaultGate, chapterGate) {
  return {
    ...deepClone(defaultGate),
    ...deepClone(chapterGate ?? {}),
    depthFloor: {
      ...(defaultGate?.depthFloor ?? {}),
      ...(chapterGate?.depthFloor ?? {}),
    },
  };
}

function duplicateIssues(values, label) {
  const out = [];
  const seen = new Map();
  values.forEach((value, index) => {
    if (value === undefined || value === null || value === '') {
      out.push(validationIssue({ path: label, message: `${label} contains an empty value`, dimension: 'workflowConfigShape' }));
      return;
    }
    if (seen.has(value)) {
      out.push(validationIssue({
        path: label,
        message: `${label} contains duplicate value ${value}`,
        dimension: 'workflowConfigShape',
        firstIndex: seen.get(value),
        duplicateIndex: index,
      }));
    } else {
      seen.set(value, index);
    }
  });
  return out;
}

function semanticIssues(config) {
  const issues = [];
  const checkEvidenceCaps = (gate, path) => {
    for (const [minKey, maxKey] of [
      ['minResearchQuestions', 'maxResearchQuestions'],
      ['minLocalSources', 'maxLocalSources'],
      ['minLocalClaims', 'maxLocalClaims'],
    ]) {
      if (
        typeof gate?.[minKey] === 'number'
        && typeof gate?.[maxKey] === 'number'
        && gate[minKey] > gate[maxKey]
      ) {
        issues.push(validationIssue({
          path: `${path}.${maxKey}`,
          message: `${maxKey} must be greater than or equal to ${minKey}`,
          dimension: 'workflowConfigShape',
          fix: `Raise ${maxKey} or lower ${minKey}.`,
        }));
      }
    }
  };
  const chapters = config.chapters ?? [];
  issues.push(...duplicateIssues(chapters.map((chapter) => chapter.order), 'chapters[].order'));
  issues.push(...duplicateIssues(chapters.map((chapter) => chapter.key), 'chapters[].key'));
  issues.push(...duplicateIssues(chapters.map((chapter) => chapter.letter), 'chapters[].letter'));

  const knownKeys = new Set(chapters.map((chapter) => chapter.key));
  const knownConditions = new Set((config.workflow?.conditions ?? []).map((condition) => condition.key));
  const knownInputs = new Set(Object.keys(config.workflow?.inputs ?? {}));
  if (!config.researchProfiles?.[config.activeResearchProfile]) {
    issues.push(validationIssue({
      path: 'activeResearchProfile',
      message: `references unknown research profile "${config.activeResearchProfile}"`,
      dimension: 'workflowConfigShape',
      fix: 'Set activeResearchProfile to a key declared under researchProfiles.',
    }));
  }
  for (const requiredProfile of ['deep', 'fast']) {
    if (!config.researchProfiles?.[requiredProfile]) {
      issues.push(validationIssue({
        path: `researchProfiles.${requiredProfile}`,
        message: `missing required ${requiredProfile} research profile`,
        dimension: 'workflowConfigShape',
        fix: `Declare researchProfiles.${requiredProfile}.`,
      }));
    }
  }
  checkEvidenceCaps(config.defaultGate, 'defaultGate');
  for (const [profileName, profile] of Object.entries(config.researchProfiles ?? {})) {
    checkEvidenceCaps(profile.defaultGate, `researchProfiles.${profileName}.defaultGate`);
  }

  for (const [index, chapter] of chapters.entries()) {
    const chapterPath = `chapters.${index}`;
    if (RESERVED_TYPE_LETTERS.has(chapter.letter)) {
      issues.push(validationIssue({
        path: `${chapterPath}.letter`,
        message: `letter "${chapter.letter}" collides with reserved type letters (${[...RESERVED_TYPE_LETTERS].join(', ')})`,
        dimension: 'workflowConfigShape',
        fix: 'Choose a unique chapter letter that is not S, C, T, F, or Q.',
      }));
    }
    for (const [refIndex, ref] of (chapter.optionalContext ?? []).entries()) {
      if (!knownKeys.has(ref)) {
        issues.push(validationIssue({
          path: `${chapterPath}.optionalContext.${refIndex}`,
          message: `references unknown chapter key "${ref}"`,
          dimension: 'workflowConfigShape',
          fix: 'Use a configured chapter key or remove the optionalContext entry.',
        }));
      }
    }
    for (const [tableIndex, planned] of (chapter.plannedTables ?? []).entries()) {
      if (planned.enumeration === true && !(Number.isInteger(planned.expectedMinRows) && planned.expectedMinRows > 0)) {
        issues.push(validationIssue({
          path: `${chapterPath}.plannedTables.${tableIndex}.expectedMinRows`,
          message: `plannedTables[${planned.name}] enumeration:true requires positive integer expectedMinRows`,
          dimension: 'workflowConfigShape',
          fix: 'Add expectedMinRows to every enumeration table plan.',
        }));
      }
    }
  }

  for (const [index, ref] of (config.adverseDistribution?.requireAtLeastOneAdverseSource ?? []).entries()) {
    if (!knownKeys.has(ref)) {
      issues.push(validationIssue({
        path: `adverseDistribution.requireAtLeastOneAdverseSource.${index}`,
        message: `references unknown chapter key "${ref}"`,
        dimension: 'workflowConfigShape',
        fix: 'Use one of the configured chapter keys.',
      }));
    }
  }

  for (const [phaseIndex, phase] of (config.workflow?.phases ?? []).entries()) {
    for (const [condIndex, condition] of [...(phase.entryConditions ?? []), ...(phase.exitConditions ?? [])].entries()) {
      if (!knownConditions.has(condition)) {
        issues.push(validationIssue({
          path: `workflow.phases.${phaseIndex}.conditions.${condIndex}`,
          message: `phase "${phase.key}" references unknown condition "${condition}"`,
          dimension: 'workflowConfigShape',
          fix: 'Declare the condition in workflow.conditions[] or remove the reference.',
        }));
      }
    }
    for (const [stepIndex, step] of (phase.steps ?? []).entries()) {
      for (const [reqIndex, req] of (step.requires ?? []).entries()) {
        const isInput = knownInputs.has(req);
        const isCondition = knownConditions.has(req);
        const isArtifactToken = /^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)*$/.test(req);
        if (!isInput && !isCondition && !isArtifactToken) {
          issues.push(validationIssue({
            path: `workflow.phases.${phaseIndex}.steps.${stepIndex}.requires.${reqIndex}`,
            message: `unknown requirement token "${req}"`,
            dimension: 'workflowConfigShape',
            fix: 'Use an input key, a declared condition key, or a dotted artifact token.',
          }));
        }
      }
    }
  }

  return issues;
}

export function validateWorkflowConfig(config) {
  const parsed = WorkflowConfigSchema.safeParse(config);
  const issues = parsed.success ? [] : zodIssues(parsed.error, {
    dimension: 'workflowConfigShape',
    codePrefix: 'workflowConfig',
    source: 'references/workflow-config.yaml',
    fix: 'Edit references/workflow-config.yaml to match scripts/contracts/workflow-config.schema.mjs.',
  });
  if (!parsed.success) return { ok: false, value: null, issues };
  issues.push(...semanticIssues(parsed.data));
  return { ok: issues.length === 0, value: parsed.data, issues };
}

export function normalizeWorkflowConfig(config) {
  const result = validateWorkflowConfig(config);
  if (!result.ok) {
    const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    throw new Error(`[workflow-config] ${detail}`);
  }
  const parsed = result.value;
  const chapters = parsed.chapters
    .map((chapter) => {
      const order = Number(chapter.order);
      const key = String(chapter.key);
      return {
        key,
        order,
        letter: chapter.letter,
        file: `${String(order).padStart(2, '0')}-${key}.yaml`,
        title: chapter.title,
        mission: chapter.mission,
        optionalContext: chapter.optionalContext ?? [],
        contentRequirements: chapter.contentRequirements ?? [],
        plannedTables: chapter.plannedTables ?? [],
        plannedFigures: chapter.plannedFigures ?? [],
        evidenceStrategy: chapter.evidenceStrategy ?? [],
        qualityBar: chapter.qualityBar ?? [],
        gate: mergeGate(parsed.defaultGate, chapter.gate ?? {}),
      };
    })
    .sort((a, b) => a.order - b.order);

  const adverseRequiredKeys = new Set(parsed.adverseDistribution?.requireAtLeastOneAdverseSource ?? []);
  for (const chapter of chapters) {
    // Effective per-chapter floors. Both are derived once here so the runtime
    // context emitted to the agent and the gate enforced by check-chapter
    // reference the same numbers — no Math.max() recomputation downstream.
    //   minAdverseSources: 1 when the chapter is listed under
    //     adverseDistribution.requireAtLeastOneAdverseSource, else 0.
    //   minArtifacts: at least the planned table+figure count, so a chapter
    //     with 10 planned artifacts cannot pass with the defaultGate floor of 6.
    const plannedArtifacts = (chapter.plannedTables?.length ?? 0) + (chapter.plannedFigures?.length ?? 0);
    chapter.gate = {
      ...chapter.gate,
      minAdverseSources: adverseRequiredKeys.has(chapter.key) ? 1 : 0,
      minArtifacts: Math.max(chapter.gate.minArtifacts, plannedArtifacts),
    };
  }

  return { ...parsed, chapters, adverseDistribution: parsed.adverseDistribution ?? null, reportGate: parsed.reportGate ?? null };
}
