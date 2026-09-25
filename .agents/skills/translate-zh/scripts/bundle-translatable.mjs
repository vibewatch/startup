#!/usr/bin/env node
// bundle-translatable.mjs
//
// Export whitelisted translation leaves from a YAML artifact into one temporary
// sparse YAML bundle, then import translated values back into apply-translation
// JSON. The default export keeps the source document's nested shape but omits
// untranslated object keys. Arrays keep null placeholders where needed so index
// alignment remains unambiguous.
//
// Usage:
//   node bundle-translatable.mjs export <yamlPath> --out <bundle.yaml> [--include-mechanical]
//   node bundle-translatable.mjs import <yamlPath> <bundle.yaml> --out <translations.json>
//   node bundle-translatable.mjs split <bundle.yaml> --out-dir <dir> [--max-chars 45000] [--max-items 400]
//   node bundle-translatable.mjs merge <part.yaml...> --out <bundle.yaml>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';

function usage(code) {
  console.error('Usage:');
  console.error('  bundle-translatable.mjs export <yamlPath> --out <bundle.yaml> [--include-mechanical]');
  console.error('  bundle-translatable.mjs import <yamlPath> <bundle.yaml> --out <translations.json>');
  console.error('  bundle-translatable.mjs split <bundle.yaml> --out-dir <dir> [--max-chars 45000] [--max-items 400]');
  console.error('  bundle-translatable.mjs merge <part.yaml...> --out <bundle.yaml>');
  process.exit(code);
}

function readYaml(path) {
  if (!existsSync(path)) {
    console.error(`file not found: ${path}`);
    process.exit(1);
  }
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
}

function writeYaml(path, value) {
  writeFileSync(path, yaml.dump(value, { lineWidth: 120, noRefs: true, sortKeys: false }), 'utf8');
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parsePositiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
}

function parseExportArgs(argv) {
  const args = { input: null, out: null, includeMechanical: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--include-mechanical') args.includeMechanical = true;
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); usage(1); }
    else if (!args.input) args.input = a;
    else { console.error(`unexpected arg: ${a}`); usage(1); }
  }
  if (!args.input || !args.out) usage(1);
  args.input = resolve(args.input);
  args.out = resolve(args.out);
  return args;
}

function parseImportArgs(argv) {
  const args = { source: null, input: null, out: null, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); usage(1); }
    else args.positionals.push(a);
  }
  if (!args.out || args.positionals.length !== 2) usage(1);
  args.source = resolve(args.positionals[0]);
  args.input = resolve(args.positionals[1]);
  args.out = resolve(args.out);
  return args;
}

function parseSplitArgs(argv) {
  const args = { input: null, outDir: null, maxChars: 45000, maxItems: 400 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--max-chars') args.maxChars = parsePositiveInt(argv[++i], '--max-chars');
    else if (a === '--max-items') args.maxItems = parsePositiveInt(argv[++i], '--max-items');
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); usage(1); }
    else if (!args.input) args.input = a;
    else { console.error(`unexpected arg: ${a}`); usage(1); }
  }
  if (!args.input || !args.outDir) usage(1);
  args.input = resolve(args.input);
  args.outDir = resolve(args.outDir);
  return args;
}

function parseMergeArgs(argv) {
  const args = { inputs: [], out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); usage(1); }
    else args.inputs.push(resolve(a));
  }
  if (!args.inputs.length || !args.out) usage(1);
  args.out = resolve(args.out);
  return args;
}

function isMechanicalValue(path, value) {
  const joined = path.join('/');
  const inTableCell = /^tables\/\d+\/rows\//.test(joined);
  const inFigureRowValue = /^figures\/\d+\/data\/rows\/\d+\/values\/\d+(?:\/(?:label|detail|note|text))?$/.test(joined);
  if (!inTableCell && !inFigureRowValue) return false;
  const s = value.trim();
  if (!s) return true;
  if (/^(?:n\/a|na|null|none|unknown|tbd|—|–|-|T\+\d+)$/i.test(s)) return true;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(s)) return true;
  if (/^(?:Q[1-4]\s*)?\d{4}(?:[-/]\d{1,2})?(?:[-/]\d{1,2})?$/i.test(s)) return true;
  const numberish = /^[~≈<>≤≥]?\s*[$€£¥]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|x|bps?|K|M|B|T|bn|mm|USD|EUR|GBP|CNY))?(?:\s*[–-]\s*[~≈<>≤≥]?\s*[$€£¥]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|x|bps?|K|M|B|T|bn|mm|USD|EUR|GBP|CNY))?)*$/i;
  return numberish.test(s);
}

export function shouldExportLeaf(path, value, whitelist, options = {}) {
  if (typeof value !== 'string') return false;
  if (!value.trim()) return false;
  if (!isTranslatableLeaf(path, whitelist)) return false;
  if (!options.includeMechanical && isMechanicalValue(path, value)) return false;
  return true;
}

function walkList(node, path, whitelist, out, options) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) walkList(node[i], [...path, i], whitelist, out, options);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) walkList(value, [...path, key], whitelist, out, options);
    return;
  }
  if (!shouldExportLeaf(path, node, whitelist, options)) return;
  out.push({ path: path.join('/'), source: node, target: '' });
}

function buildSparse(node, path, whitelist, options) {
  if (Array.isArray(node)) {
    const children = node.map((value, index) => buildSparse(value, [...path, index], whitelist, options));
    if (!children.some((child) => child !== undefined)) return undefined;
    return children.map((child) => (child === undefined ? null : child));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const child = buildSparse(value, [...path, key], whitelist, options);
      if (child !== undefined) out[key] = child;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return shouldExportLeaf(path, node, whitelist, options) ? node : undefined;
}

function collectStringLeaves(node, path, out) {
  if (typeof node === 'string') {
    if (node.trim()) out.push({ path, value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) collectStringLeaves(node[i], [...path, i], out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collectStringLeaves(value, [...path, key], out);
  }
}

function ensureArrayLength(node, length) {
  while (node.length < length) node.push(null);
}

function setSparseAtPath(root, path, value) {
  if (!path.length) return value;
  let node = root;
  for (let i = 0; i < path.length; i += 1) {
    const part = path[i];
    const last = i === path.length - 1;
    if (last) {
      if (Array.isArray(node)) {
        ensureArrayLength(node, part + 1);
        node[part] = value;
      } else {
        node[part] = value;
      }
      break;
    }

    const nextPart = path[i + 1];
    if (Array.isArray(node)) {
      ensureArrayLength(node, part + 1);
      if (node[part] === null || node[part] === undefined) node[part] = typeof nextPart === 'number' ? [] : {};
      node = node[part];
    } else {
      if (node[part] === null || node[part] === undefined) node[part] = typeof nextPart === 'number' ? [] : {};
      node = node[part];
    }
  }
  return root;
}

function buildSparseFromLeaves(leaves) {
  const first = leaves[0]?.path?.[0];
  const root = typeof first === 'number' ? [] : {};
  for (const leaf of leaves) setSparseAtPath(root, leaf.path, leaf.value);
  return root;
}

function leafSize(leaf) {
  return leaf.path.join('/').length + leaf.value.length + 16;
}

function mergeSparse(base, overlay) {
  if (overlay === null || overlay === undefined) return base;
  if (typeof overlay === 'string') return overlay;

  if (Array.isArray(overlay)) {
    const out = Array.isArray(base) ? [...base] : [];
    for (let i = 0; i < overlay.length; i += 1) {
      if (overlay[i] === null || overlay[i] === undefined) continue;
      out[i] = mergeSparse(out[i], overlay[i]);
    }
    return out;
  }

  if (overlay && typeof overlay === 'object') {
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(overlay)) {
      if (value === null || value === undefined) continue;
      out[key] = mergeSparse(out[key], value);
    }
    return out;
  }

  return base;
}

function exportBundle(argv) {
  const args = parseExportArgs(argv);
  const doc = readYaml(args.input);
  const whitelist = whitelistFor(doc);
  const options = { includeMechanical: args.includeMechanical };

  const bundle = buildSparse(doc, [], whitelist, options) ?? {};

  writeYaml(args.out, bundle);
  process.stderr.write(`[bundle] wrote ${args.out} (sparse format)\n`);
}

function collectSparseTranslations(sourceNode, translatedNode, path, whitelist, out, issues) {
  if (translatedNode === null || translatedNode === undefined) return;

  if (typeof translatedNode === 'string') {
    if (typeof sourceNode !== 'string') {
      issues.push(`${path.join('/') || '(root)'}: translated scalar does not match source shape`);
      return;
    }
    if (!isTranslatableLeaf(path, whitelist)) {
      issues.push(`${path.join('/') || '(root)'}: path is not whitelisted for translation`);
      return;
    }
    if (!translatedNode.trim()) return;
    out.push({ path: path.join('/'), source: sourceNode, target: translatedNode });
    return;
  }

  if (Array.isArray(translatedNode)) {
    if (!Array.isArray(sourceNode)) {
      issues.push(`${path.join('/') || '(root)'}: translated array does not match source shape`);
      return;
    }
    if (translatedNode.length > sourceNode.length) {
      issues.push(`${path.join('/') || '(root)'}: translated array is longer than source array`);
      return;
    }
    for (let i = 0; i < translatedNode.length; i += 1) {
      collectSparseTranslations(sourceNode[i], translatedNode[i], [...path, i], whitelist, out, issues);
    }
    return;
  }

  if (translatedNode && typeof translatedNode === 'object') {
    if (!sourceNode || typeof sourceNode !== 'object' || Array.isArray(sourceNode)) {
      issues.push(`${path.join('/') || '(root)'}: translated object does not match source shape`);
      return;
    }
    for (const [key, value] of Object.entries(translatedNode)) {
      if (!(key in sourceNode)) {
        issues.push(`${[...path, key].join('/')}: key is not present in source`);
        continue;
      }
      collectSparseTranslations(sourceNode[key], value, [...path, key], whitelist, out, issues);
    }
    return;
  }

  issues.push(`${path.join('/') || '(root)'}: unsupported translated value type ${typeof translatedNode}`);
}

function importBundle(argv) {
  const args = parseImportArgs(argv);
  const bundle = readYaml(args.input);

  const source = readYaml(args.source);
  const whitelist = whitelistFor(source);
  const issues = [];
  const translations = [];
  collectSparseTranslations(source, bundle, [], whitelist, translations, issues);
  if (issues.length) {
    console.error('sparse bundle shape/import error(s):');
    for (const issue of issues.slice(0, 20)) console.error(`  - ${issue}`);
    if (issues.length > 20) console.error(`  ... +${issues.length - 20} more`);
    process.exit(1);
  }

  if (!Array.isArray(translations)) {
    console.error('failed to produce translation array');
    process.exit(1);
  }

  writeJson(args.out, translations);
  process.stderr.write(`[bundle] wrote ${args.out} (${translations.length} translation(s))\n`);
}

function splitBundle(argv) {
  const args = parseSplitArgs(argv);
  const bundle = readYaml(args.input);
  const leaves = [];
  collectStringLeaves(bundle, [], leaves);

  const batches = [];
  let current = [];
  let chars = 0;

  function flush() {
    if (!current.length) return;
    batches.push({ leaves: current, chars });
    current = [];
    chars = 0;
  }

  for (const leaf of leaves) {
    const nextSize = leafSize(leaf);
    if (current.length && (current.length >= args.maxItems || chars + nextSize > args.maxChars)) flush();
    current.push(leaf);
    chars += nextSize;
  }
  flush();

  mkdirSync(args.outDir, { recursive: true });

  const manifest = {
    sourceBundle: args.input,
    totalLeaves: leaves.length,
    settings: { maxChars: args.maxChars, maxItems: args.maxItems },
    parts: [],
  };

  for (let i = 0; i < batches.length; i += 1) {
    const name = `part.${String(i).padStart(3, '0')}.yaml`;
    const path = resolve(args.outDir, name);
    const partial = buildSparseFromLeaves(batches[i].leaves);
    writeYaml(path, partial);
    manifest.parts.push({ file: name, leaves: batches[i].leaves.length, chars: batches[i].chars });
  }
  writeJson(resolve(args.outDir, 'manifest.json'), manifest);
  process.stderr.write(`[bundle] split ${leaves.length} leaf/leaves into ${batches.length} part(s) under ${args.outDir}\n`);
}

function mergeBundles(argv) {
  const args = parseMergeArgs(argv);
  const partsDir = dirname(args.inputs[0]);
  const manifestPath = resolve(partsDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const manifest = readYaml(manifestPath);
    const expected = Array.isArray(manifest.parts)
      ? manifest.parts.map((part) => resolve(partsDir, part.file))
      : [];
    const provided = new Set(args.inputs);
    const missing = expected.filter((input) => !provided.has(input) || !existsSync(input));
    const unexpected = args.inputs.filter((input) => !expected.includes(input));
    if (missing.length || unexpected.length || args.inputs.length !== expected.length) {
      console.error('merge input does not match split manifest:');
      for (const input of missing.slice(0, 10)) console.error(`  - missing ${input}`);
      for (const input of unexpected.slice(0, 10)) console.error(`  - unexpected ${input}`);
      process.exit(1);
    }
    args.inputs = expected;
  }
  let merged;
  for (const input of args.inputs) {
    merged = mergeSparse(merged, readYaml(input));
  }
  if (existsSync(manifestPath)) {
    const manifest = readYaml(manifestPath);
    const leaves = [];
    collectStringLeaves(merged ?? {}, [], leaves);
    if (leaves.length !== manifest.totalLeaves) {
      console.error(`merged leaf count mismatch (manifest=${manifest.totalLeaves}, merged=${leaves.length})`);
      process.exit(1);
    }
  }
  writeYaml(args.out, merged ?? {});
  process.stderr.write(`[bundle] merged ${args.inputs.length} part(s) into ${args.out}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'export') exportBundle(rest);
  else if (command === 'import') importBundle(rest);
  else if (command === 'split') splitBundle(rest);
  else if (command === 'merge') mergeBundles(rest);
  else usage(command === '-h' || command === '--help' ? 0 : 1);
}