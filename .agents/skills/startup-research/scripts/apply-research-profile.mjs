#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import yaml from 'js-yaml';
import { validateWorkflowConfig } from './contracts/workflow-config.schema.mjs';
import {
  EXIT,
  isFinalizedReportFolder,
  isRunId,
  workflowConfigPath,
  workflowSnapshotPathFor,
} from './utils.mjs';

function usage(code = EXIT.ok) {
  console.error('Usage: apply-research-profile.mjs --report-folder <path> [--profile fast|deep]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { folder: '', profile: 'deep' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--report-folder') args.folder = argv[++i] ?? '';
    else if (arg === '--profile') args.profile = argv[++i] ?? '';
    else if (arg === '-h' || arg === '--help') usage();
    else usage(EXIT.failure);
  }
  if (!args.folder || !['fast', 'deep'].includes(args.profile)) usage(EXIT.failure);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const folder = resolve(args.folder);
if (!isRunId(basename(folder))) {
  console.error(`[apply-research-profile] report folder must end in a valid runId: ${folder}`);
  process.exit(EXIT.failure);
}
if (isFinalizedReportFolder(folder)) {
  console.error(`[apply-research-profile] refusing to change the contract of finalized report: ${folder}`);
  process.exit(EXIT.failure);
}

const snapshotPath = workflowSnapshotPathFor(folder);
if (existsSync(snapshotPath)) {
  const existing = yaml.load(readFileSync(snapshotPath, 'utf8'));
  const existingProfile = existing?.activeResearchProfile ?? 'deep';
  if (existingProfile !== args.profile) {
    console.error(`[apply-research-profile] existing ${existingProfile} snapshot conflicts with requested ${args.profile} profile: ${snapshotPath}`);
    process.exit(EXIT.failure);
  }
  console.log(JSON.stringify({
    profile: args.profile,
    reportFolder: folder,
    snapshot: snapshotPath,
    reused: true,
  }));
  process.exit(EXIT.ok);
}

const config = yaml.load(readFileSync(workflowConfigPath, 'utf8'));
const profile = config.researchProfiles?.[args.profile];
if (!profile) {
  console.error(`[apply-research-profile] profile is not configured: ${args.profile}`);
  process.exit(EXIT.failure);
}
config.activeResearchProfile = args.profile;
if (Object.keys(profile.defaultGate ?? {}).length) {
  config.defaultGate = {
    ...config.defaultGate,
    ...profile.defaultGate,
    depthFloor: {
      ...config.defaultGate.depthFloor,
      ...(profile.defaultGate.depthFloor ?? {}),
    },
  };
}
if (Object.keys(profile.reportGate ?? {}).length) {
  config.reportGate = {
    ...config.reportGate,
    ...profile.reportGate,
    crossChapterTolerances: {
      ...(config.reportGate?.crossChapterTolerances ?? {}),
      ...(profile.reportGate.crossChapterTolerances ?? {}),
    },
  };
}
for (const chapter of config.chapters ?? []) {
  if (profile.capChapterGateOverrides && chapter.gate) {
    for (const [key, cap] of Object.entries(profile.defaultGate ?? {})) {
      if (key === 'depthFloor' || typeof cap !== 'number') continue;
      if (typeof chapter.gate[key] === 'number') {
        chapter.gate[key] = Math.min(chapter.gate[key], cap);
      }
    }
  }
  if (profile.clearRequiredSourceTypes && chapter.gate?.requiredSourceTypes) {
    chapter.gate.requiredSourceTypes = [];
  }
  if (profile.maxPlannedTablesPerChapter) {
    chapter.plannedTables = chapter.plannedTables.slice(0, profile.maxPlannedTablesPerChapter);
  }
  if (profile.maxPlannedFiguresPerChapter) {
    chapter.plannedFigures = chapter.plannedFigures.slice(0, profile.maxPlannedFiguresPerChapter);
  }
}

const validation = validateWorkflowConfig(config);
if (!validation.ok) {
  for (const issue of validation.issues) {
    console.error(`[apply-research-profile] ${issue.path}: ${issue.message}`);
  }
  process.exit(EXIT.failure);
}

writeFileSync(snapshotPath, yaml.dump(config, {
  lineWidth: 120,
  noRefs: true,
  sortKeys: false,
}), 'utf8');
console.log(JSON.stringify({
  profile: args.profile,
  reportFolder: folder,
  snapshot: snapshotPath,
  gate: {
    minResearchQuestions: config.defaultGate.minResearchQuestions,
    minLocalSources: config.defaultGate.minLocalSources,
    minLocalClaims: config.defaultGate.minLocalClaims,
    minSourceDomains: config.defaultGate.minSourceDomains,
    minNetNewSources: config.defaultGate.minNetNewSources,
    minDistinctDomains: config.reportGate.minDistinctDomains,
    maxPlannedTablesPerChapter: profile.maxPlannedTablesPerChapter ?? null,
    maxPlannedFiguresPerChapter: profile.maxPlannedFiguresPerChapter ?? null,
  },
}));
