#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';

const PAIRS = [
  ['summary-card.yaml', 'summary-card.zh.yaml'],
  ['full-report.yaml', 'full-report.zh.yaml'],
];

function mergeOverlay(source, translated, path, whitelist) {
  if (typeof source === 'string' && isTranslatableLeaf(path, whitelist)) {
    return typeof translated === 'string' ? translated : source;
  }
  if (Array.isArray(source)) {
    const translatedItems = Array.isArray(translated) ? translated : [];
    return source.map((value, index) => (
      mergeOverlay(value, translatedItems[index], [...path, index], whitelist)
    ));
  }
  if (source && typeof source === 'object') {
    const translatedObject = translated && typeof translated === 'object' && !Array.isArray(translated)
      ? translated
      : {};
    return Object.fromEntries(
      Object.entries(source).map(([key, value]) => [
        key,
        mergeOverlay(value, translatedObject[key], [...path, key], whitelist),
      ]),
    );
  }
  return source;
}

function syncPair(sourcePath, translatedPath) {
  const source = yaml.load(readFileSync(sourcePath, 'utf8')) ?? {};
  const translated = yaml.load(readFileSync(translatedPath, 'utf8')) ?? {};
  const next = mergeOverlay(source, translated, [], whitelistFor(source));
  const output = yaml.dump(next, { lineWidth: 120, noRefs: true, sortKeys: false });
  const current = readFileSync(translatedPath, 'utf8');
  if (output === current) return false;
  writeFileSync(translatedPath, output, 'utf8');
  return true;
}

export function syncPreservedFields(reportFolder) {
  const folder = resolve(reportFolder);
  const changed = [];
  for (const [sourceName, translatedName] of PAIRS) {
    const sourcePath = join(folder, sourceName);
    const translatedPath = join(folder, translatedName);
    if (!existsSync(sourcePath) || !existsSync(translatedPath)) continue;
    if (syncPair(sourcePath, translatedPath)) changed.push(translatedName);
  }
  return changed;
}

function reportFolders(root) {
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

function usage(code = 1) {
  console.error('Usage: sync-preserved-fields.mjs <report-folder> | --all <reports-folder>');
  process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let folders;
  if (args[0] === '--all' && args[1] && args.length === 2) {
    const root = resolve(args[1]);
    if (!existsSync(root)) usage();
    folders = reportFolders(root);
  } else if (args[0] && args.length === 1) {
    folders = [resolve(args[0])];
  } else {
    usage();
  }

  let changedFiles = 0;
  for (const folder of folders) {
    const changed = syncPreservedFields(folder);
    changedFiles += changed.length;
    for (const file of changed) {
      console.log(`[sync-preserved-fields] updated ${basename(folder)}/${file}`);
    }
  }
  console.log(`[sync-preserved-fields] ${changedFiles} overlay file(s) updated.`);
}
