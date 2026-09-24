#!/usr/bin/env node
// check-translation.mjs
//
// Validate that one report folder's `*.zh.yaml` mirrors are structurally
// identical to their English sources: same keys at every level, same array
// lengths, same numerics/booleans/IDs/refs/URLs verbatim. Only whitelisted
// leaves may differ from the English original. With `--strict`, also fail
// whitelisted leaves that still look untranslated.
//
// Batch-mode sweeps across every report live in check-translations.mjs,
// which imports checkFolder() from this file.
//
// Usage:
//   node check-translation.mjs <reportFolder> [--strict] [--require-final]
//
// Exit code: 0 ok, 1 failures present.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';

const REQUIRED_FINAL_BASENAMES = ['summary-card', 'full-report'];

function parseArgs(argv) {
  const args = { folder: null, strict: false, requireFinal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--strict') args.strict = true;
    else if (a === '--require-final') args.requireFinal = true;
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); usage(1); }
    else if (!args.folder) args.folder = a;
    else { console.error(`unexpected arg: ${a}`); usage(1); }
  }
  if (!args.folder) usage(1);
  return args;
}

function usage(code) {
  console.error('Usage: check-translation.mjs <reportFolder> [--strict] [--require-final]');
  process.exit(code);
}

function loadYaml(path) { return yaml.load(readFileSync(path, 'utf8')) ?? {}; }

function valueExcerpt(value) {
  if (value === undefined) return 'undefined';
  const json = JSON.stringify(value);
  const text = (json ?? String(value)).replace(/\s+/g, ' ');
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function latinWords(value) {
  return value.match(/[\p{L}][\p{L}\p{N}'+-]*/gu) ?? [];
}

const DESCRIPTOR_WORDS = new Set([
  'adoption',
  'enterprise',
  'global',
  'market',
  'open',
  'platform',
  'retail',
  'sample',
  'weights',
]);

function isTokenLike(value) {
  const s = value.trim();
  if (/^(?:n\/a|na|null|none|—|–|-|T\+\d+)$/i.test(s)) return true;
  return /^[A-Z0-9][A-Z0-9&+./_ -]{0,24}$/.test(s);
}

function isProperNounPhrase(value) {
  const words = latinWords(value);
  return words.length > 0
    && words.length <= 4
    && words.every((word) => /^\p{Lu}[\p{L}\p{N}.+-]*$/u.test(word) || /^(?=.*\d)[a-z][a-z0-9.+-]*$/i.test(word))
    && !words.some((word) => DESCRIPTOR_WORDS.has(word.toLowerCase()));
}

function isModelVersionToken(value) {
  const token = value.trim();
  if (!token || /\s/.test(token)) return false;
  return /^(?:[A-Za-z]+-?\d[A-Za-z0-9.-]*|[A-Za-z]\d[A-Za-z0-9.-]*)$/.test(token);
}

function isModelVersionList(value) {
  const tokens = value.split(/\s*(?:[,，、;；/+&])\s*/).filter(Boolean);
  return tokens.length >= 2 && tokens.every(isModelVersionToken);
}

function untranslatedMessage(en, zh) {
  const source = en.trim();
  const target = zh.trim();
  // Empty source (e.g. blank cells in a sparse heatmap) is preserved verbatim;
  // bundle-translatable.mjs skips it, and an empty ZH here is a faithful mirror.
  if (!source) return null;
  if (!target) return 'empty translation leaf; renderer would fall back to English';
  if (!/[A-Za-z]/.test(target)) return null;
  if (isTokenLike(target) || isProperNounPhrase(target) || isModelVersionList(target)) return null;

  const wordCount = latinWords(target).length;
  if (source === target && (target.length >= 20 || wordCount >= 3)) {
    return 'translation is identical to the English source';
  }
  if (!/[\u4e00-\u9fff]/.test(target) && (target.length >= 30 || wordCount >= 4)) {
    return 'translation contains no CJK characters';
  }
  return null;
}

// Walk both trees in lockstep, asserting structural identity. Returns a
// list of issues. `whitelist` is the path-pattern set of translatable
// leaves for this artifact.
function diff(en, zh, path, whitelist, issues, options) {
  if (Array.isArray(en)) {
    if (!Array.isArray(zh)) {
      issues.push({ path: path.join('/'), kind: 'shape', message: `expected array in zh, got ${typeof zh}` });
      return;
    }
    if (en.length !== zh.length) {
      issues.push({ path: path.join('/'), kind: 'shape', message: `array length mismatch (en=${en.length}, zh=${zh.length})` });
      return;
    }
    for (let i = 0; i < en.length; i += 1) diff(en[i], zh[i], [...path, i], whitelist, issues, options);
    return;
  }
  if (en && typeof en === 'object') {
    if (!zh || typeof zh !== 'object' || Array.isArray(zh)) {
      issues.push({ path: path.join('/'), kind: 'shape', message: `expected object in zh, got ${Array.isArray(zh) ? 'array' : typeof zh}` });
      return;
    }
    const enKeys = Object.keys(en);
    const zhKeys = new Set(Object.keys(zh));
    for (const key of enKeys) {
      if (!zhKeys.has(key)) {
        issues.push({ path: [...path, key].join('/'), kind: 'shape', message: 'key missing in zh' });
        continue;
      }
      diff(en[key], zh[key], [...path, key], whitelist, issues, options);
    }
    for (const key of Object.keys(zh)) {
      if (!enKeys.includes(key)) {
        issues.push({ path: [...path, key].join('/'), kind: 'shape', message: 'extra key in zh that is not in en' });
      }
    }
    return;
  }
  // Scalar leaf.
  const translatable = typeof en === 'string' && isTranslatableLeaf(path, whitelist);
  if (translatable) {
    if (zh === null || zh === undefined) {
      if (options.strict) issues.push({ path: path.join('/'), kind: 'translate', message: 'missing translation leaf; renderer would fall back to English', en, zh });
      return;
    }
    if (typeof zh !== 'string') {
      issues.push({ path: path.join('/'), kind: 'shape', message: `translatable leaf must be a string, got ${typeof zh}`, en, zh });
      return;
    }
    if (options.strict) {
      const message = untranslatedMessage(en, zh);
      if (message) issues.push({ path: path.join('/'), kind: 'translate', message, en, zh });
    }
    return;
  }
  // Non-translatable: must match verbatim.
  if (en === undefined && zh === undefined) return;
  if (Object.is(en, zh)) return;
  // Allow null vs undefined parity for optional fields.
  if (en == null && zh == null) return;
  issues.push({ path: path.join('/'), kind: 'preserve', message: 'non-translatable leaf changed', en, zh });
}

function checkPair(enPath, zhPath, options) {
  const en = loadYaml(enPath);
  const zh = loadYaml(zhPath);
  const whitelist = whitelistFor(en);
  const issues = [];
  diff(en, zh, [], whitelist, issues, options);
  return issues;
}

function findEnglishYamls(folder) {
  return readdirSync(folder)
    .filter((n) => n.endsWith('.yaml') && !n.endsWith('.zh.yaml') && !n.startsWith('.'))
    .map((n) => join(folder, n));
}

function checkFolder(folder, options) {
  const enFiles = findEnglishYamls(folder);
  const failures = [];
  let pairs = 0;
  if (options.requireFinal) {
    for (const basename of REQUIRED_FINAL_BASENAMES) {
      const enPath = join(folder, `${basename}.yaml`);
      const zhPath = join(folder, `${basename}.zh.yaml`);
      if (!existsSync(enPath)) {
        failures.push({ enPath, zhPath, issues: [{ path: basename, kind: 'missing', message: 'required English source file is missing' }] });
      } else if (!existsSync(zhPath)) {
        failures.push({ enPath, zhPath, issues: [{ path: basename, kind: 'missing', message: 'required Chinese mirror is missing' }] });
      }
    }
  }
  for (const enPath of enFiles) {
    const zhPath = enPath.replace(/\.yaml$/, '.zh.yaml');
    if (!existsSync(zhPath)) continue;
    pairs += 1;
    const issues = checkPair(enPath, zhPath, options);
    if (issues.length) {
      failures.push({ enPath, zhPath, issues });
    }
  }
  return { pairs, failures };
}

// Exposed for check-translations.mjs (the batch-mode wrapper).
export { checkFolder, untranslatedMessage, valueExcerpt };

// Only run the CLI when this file is executed directly (not when imported
// by check-translations.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const folder = resolve(args.folder);
  if (!existsSync(folder)) {
    console.error(`[check-translation] folder not found: ${folder}`);
    process.exit(1);
  }
  const options = { strict: args.strict, requireFinal: args.requireFinal };
  const { pairs, failures } = checkFolder(folder, options);
  if (failures.length) {
    for (const fail of failures) {
      console.error(`FAIL ${fail.zhPath}`);
      for (const issue of fail.issues.slice(0, 20)) {
        console.error(`  - [${issue.kind}] ${issue.path || '(root)'}: ${issue.message}`);
        if ('en' in issue || 'zh' in issue) {
          console.error(`      EN: ${valueExcerpt(issue.en)}`);
          console.error(`      ZH: ${valueExcerpt(issue.zh)}`);
        }
      }
      if (fail.issues.length > 20) console.error(`  ... +${fail.issues.length - 20} more`);
    }
    console.error(`[check-translation] ${failures.length} file(s) failed across ${pairs} translated pair(s).`);
    process.exit(1);
  }
  if (pairs === 0) {
    console.log('[check-translation] no .zh.yaml pairs found; nothing to check.');
    process.exit(0);
  }
  console.log(`[check-translation] \u2713 ${pairs} translated pair(s) verified.`);
}
