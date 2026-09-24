#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const reportsRoot = resolve('reports');
const apply = process.argv.slice(2).includes('--apply');
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--apply');

if (unknownArgs.length) {
  console.error(`Usage: migrate-report-yaml.mjs [--apply]\nUnknown argument(s): ${unknownArgs.join(', ')}`);
  process.exit(1);
}

const profileBlock = [
  'activeResearchProfile: deep',
  'researchProfiles:',
  '  deep:',
  '    description: Historical full-depth snapshot migrated from pre-profile workflow configuration.',
  '    defaultGate: {}',
  '    reportGate: {}',
  '    capChapterGateOverrides: false',
  '    clearRequiredSourceTypes: false',
  '  fast:',
  '    description: Fast profile unavailable for reports created before profile routing.',
  '    defaultGate: {}',
  '    reportGate: {}',
  '    capChapterGateOverrides: false',
  '    clearRequiredSourceTypes: false',
];

function migrateSnapshot(text, path) {
  const doc = yaml.load(text) ?? {};
  const additions = [];
  if (!doc.activeResearchProfile) additions.push(profileBlock[0]);
  if (!doc.researchProfiles) additions.push(...profileBlock.slice(1));
  if (doc.researchProfiles && (!doc.researchProfiles.deep || !doc.researchProfiles.fast)) {
    throw new Error(`${path}: partial researchProfiles cannot be migrated automatically`);
  }
  if (!additions.length) return text;
  const lines = text.split('\n');
  const insertAfter = lines.findIndex((line) => /^reportSchemaVersion:\s*/.test(line));
  if (insertAfter === -1) throw new Error(`${path}: missing reportSchemaVersion`);
  lines.splice(insertAfter + 1, 0, ...additions);
  return lines.join('\n');
}

function removeObsoleteFigureLayouts(text) {
  return text
    .split('\n')
    .filter((line) => {
      if (/^\s+["']?layout["']?:\s*["']?(?:compact|standard|wide)["']?,?\s*$/.test(line)) return false;
      return true;
    })
    .join('\n');
}

if (!existsSync(reportsRoot)) {
  console.error(`[migrate-report-yaml] missing reports directory: ${reportsRoot}`);
  process.exit(1);
}

let changedFiles = 0;
let migratedSnapshots = 0;
let removedLayouts = 0;

for (const runId of readdirSync(reportsRoot).sort()) {
  const folder = join(reportsRoot, runId);
  if (!statSync(folder).isDirectory()) continue;
  for (const name of readdirSync(folder).filter((entry) => entry.endsWith('.yaml'))) {
    const path = join(folder, name);
    const before = readFileSync(path, 'utf8');
    let after = before;
    if (name === '.workflow-snapshot.yaml') {
      const migrated = migrateSnapshot(after, path);
      if (migrated !== after) migratedSnapshots += 1;
      after = migrated;
    }
    const withoutLayouts = removeObsoleteFigureLayouts(after);
    removedLayouts += after.split('\n').length - withoutLayouts.split('\n').length;
    after = withoutLayouts;
    if (after === before) continue;
    changedFiles += 1;
    if (apply) {
      yaml.load(after);
      writeFileSync(path, after, 'utf8');
    }
  }
}

const action = apply ? 'migrated' : 'need migration';
console.log(`[migrate-report-yaml] ${changedFiles} file(s) ${action}; ${migratedSnapshots} workflow snapshot(s), ${removedLayouts} obsolete figure layout field(s).`);
if (!apply && changedFiles > 0) process.exit(1);
