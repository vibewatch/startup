#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { EXIT } from './utils.mjs';

const nonEmpty = z.string().trim().min(1);
const providerSchema = z.object({
  role: nonEmpty,
  env: nonEmpty,
  supportsAnonymous: z.boolean(),
}).strict();
const searchSchema = z.object({
  schemaVersion: z.literal('search-strategy-v1'),
  principles: z.array(nonEmpty).min(1),
  providers: z.record(nonEmpty, providerSchema),
  routing: z.record(nonEmpty, z.array(nonEmpty).min(1)),
  budgets: z.object({
    cacheTtlHours: z.number().positive(),
    profiles: z.record(nonEmpty, z.object({
      globalQueries: z.number().int().positive(),
      freshQueriesPerChapter: z.number().int().positive(),
      refreshQueriesPerChapter: z.number().int().positive(),
      maxGapQueriesPerChapter: z.number().int().nonnegative(),
      maxResultsPerQuery: z.number().int().min(1).max(10),
      concurrency: z.number().int().positive(),
    }).strict()),
  }).strict(),
  chapterFocus: z.record(nonEmpty, z.array(nonEmpty).length(2)),
  quality: z.object({
    requireIntents: z.array(nonEmpty).min(1),
    highReputationDomains: z.array(nonEmpty),
    lowSignalDomains: z.array(nonEmpty),
    sourceFunnel: z.array(nonEmpty).min(1),
  }).strict(),
}).strict();
const modelProfileSchema = z.object({
  defaultCopilotModel: nonEmpty,
  reasoningEffort: nonEmpty,
  escalateTo: nonEmpty,
  rationale: nonEmpty,
}).strict();
const modelSchema = z.object({
  schemaVersion: z.literal('model-routing-v1'),
  reviewedAt: z.union([z.string(), z.date()]),
  policy: z.array(nonEmpty).min(1),
  profiles: z.record(nonEmpty, modelProfileSchema),
  apiAlternatives: z.record(nonEmpty, z.object({
    recommendation: nonEmpty,
    useFor: nonEmpty,
  }).strict()),
}).strict();

function load(path) {
  return yaml.load(readFileSync(resolve(path), 'utf8'));
}

const search = searchSchema.safeParse(load('.agents/skills/startup-research/references/search-strategy.yaml'));
const models = modelSchema.safeParse(load('.agents/skills/startup-research/references/model-routing.yaml'));
const workflow = load('.agents/skills/startup-research/references/workflow-config.yaml');
const issues = [];
if (!search.success) issues.push(...search.error.issues.map((issue) => `search-strategy.yaml ${issue.path.join('.')}: ${issue.message}`));
if (!models.success) issues.push(...models.error.issues.map((issue) => `model-routing.yaml ${issue.path.join('.')}: ${issue.message}`));
if (search.success) {
  const providers = new Set(Object.keys(search.data.providers));
  for (const profile of ['fast', 'deep']) {
    if (!search.data.budgets.profiles[profile]) {
      issues.push(`search-strategy.yaml budgets.profiles: missing required ${profile} profile`);
    }
    const workflowProfiles = new Set(Object.keys(workflow.researchProfiles ?? {}));
    for (const profile of Object.keys(search.data.budgets.profiles)) {
      if (!workflowProfiles.has(profile)) {
        issues.push(`search-strategy.yaml budgets.profiles.${profile}: missing matching workflow-config researchProfiles.${profile}`);
      }
    }
  }
  for (const [intent, route] of Object.entries(search.data.routing)) {
    for (const provider of route) {
      if (!providers.has(provider)) issues.push(`search-strategy.yaml routing.${intent}: unknown provider ${provider}`);
    }
  }
  for (const intent of search.data.quality.requireIntents) {
    if (!search.data.routing[intent]) issues.push(`search-strategy.yaml quality.requireIntents: missing routing.${intent}`);
  }
  const workflowChapterKeys = new Set(
    (workflow.chapters ?? []).map((chapter) => chapter.key),
  );
  for (const chapterKey of workflowChapterKeys) {
    if (!search.data.chapterFocus[chapterKey]) {
      issues.push(`search-strategy.yaml chapterFocus: missing ${chapterKey}`);
    }
  }
  for (const chapterKey of Object.keys(search.data.chapterFocus)) {
    if (!workflowChapterKeys.has(chapterKey)) {
      issues.push(`search-strategy.yaml chapterFocus.${chapterKey}: unknown analysis chapter`);
    }
  }
}
if (issues.length) {
  console.error('[check-automation-config] failures');
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(EXIT.failure);
}
console.log(`[check-automation-config] ✓ ${Object.keys(search.data.providers).length} search providers; ${Object.keys(models.data.profiles).length} model profiles.`);
