#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';

function usage(code = 0) {
  console.error('Usage: check-translation-quality.mjs <english.yaml> <chinese.zh.yaml> [--strict-editor] [--format text|json]');
  process.exit(code);
}

const invariantToken = /\b(?:19|20)\d{2}\b|\b\d{4}-\d{2}-\d{2}\b/g;
const metricToken = /(?:[$€£¥₦]\s*)?\d+(?:[.,]\d+)*(?:\s?(?:%|bps|[KMBT]|x|×|ARR|MRR|GMV|TPV|NPL|IRR))?/gi;
const stylePatterns = [
  /对于[^。！？；]{1,24}而言/u,
  /在[^。！？；]{1,20}方面/u,
  /通过[^。！？；]{1,24}来/u,
  /在[^。！？；]{1,24}的过程中/u,
  /被设计为/u,
  /被要求/u,
  /被认为是/u,
  /正在[^。！？；]{1,16}中/u,
  /做出决定/u,
  /进行尝试/u,
  /产生影响/u,
  /实现增长/u,
];
const strictEditorStylePatterns = [
  /对[^。！？；]{1,24}来说/u,
  /进行(?:验证|分析|评估|测试)/u,
  /形成(?:机制|优势|闭环)/u,
  /实现(?:提升|改善)/u,
  /这意味着/u,
  /这表明/u,
  /呈现[^。！？；]{1,16}特征/u,
  /围绕[^。！？；]{1,16}展开/u,
  /在[^。！？；]{1,16}层面/u,
  /体现了/u,
  /这构成了/u,
  /最(?:晚|迟)截至/u,
  /未达到至少/u,
];
const hedgeRules = [
  { en: /\b(?:approximately|roughly)\b/i, zh: /约|大约|大致|近似/u },
  { en: /\b(?:reportedly|according to reports)\b/i, zh: /据报道|据报|据称|报道称/u },
  { en: /\bestimated\b|\b(?:we|analysts?|reports?) estimate\b/i, zh: /估计|估算|预计|测算/u },
  { en: /\bat least\b/i, zh: /至少|不低于/u },
  { en: /\bat most\b/i, zh: /至多|最多|不超过/u },
  { en: /\b(?:likely|probably)\b/i, zh: /可能|很可能|大概率|多半/u },
  { en: /\breportedly\b/i, zh: /据报道|据称/u },
  { en: /\bclaims?\b/i, zh: /声称|称|说法|主张/u },
  { en: /\bnot yet\b/i, zh: /尚未|还未|仍未|目前没有|尚无/u },
  { en: /\b(?:unproven|not proven)\b/i, zh: /未经证实|未获证实|尚未证明|无法证明/u },
  { en: /\bno public\b/i, zh: /没有公开|无公开|尚无公开|未见公开/u },
];
const descriptorWords = new Set([
  'business',
  'company',
  'customer',
  'customers',
  'enterprise',
  'global',
  'growth',
  'market',
  'platform',
  'pricing',
  'product',
  'products',
  'revenue',
  'risk',
  'risks',
  'technology',
]);
const glossaryPath = new URL('../references/glossary.zh.yaml', import.meta.url);
const glossary = yaml.load(readFileSync(glossaryPath, 'utf8')) ?? {};
const glossaryEntries = Object.entries({
  ...(glossary.metrics ?? {}),
  ...(glossary.diligence ?? {}),
  ...(glossary.domain ?? {}),
}).filter(([en, zh]) => en.includes(' ') && typeof zh === 'string' && zh.length >= 1);

function load(path) {
  return yaml.load(readFileSync(path, 'utf8')) ?? {};
}

function normalizedTokens(value) {
  return (value.match(invariantToken) ?? []).map((token) => token.replace(/\s+/g, '').toLowerCase());
}

function normalizedMetricTokens(value) {
  return (value.match(metricToken) ?? [])
    .map((token) => token.replace(/\s+/g, '').replace(/,/g, '').toLowerCase())
    .filter((token) => /[$€£¥₦%]|bps|[kmbt]$|arr|mrr|gmv|tpv|npl|irr|x$|×$|\d{4}/i.test(token))
    .sort();
}

function pushIssue(issues, issue) {
  issues.push({ severity: 'error', ...issue });
}

function pushWarning(issues, issue) {
  issues.push({ severity: 'warning', ...issue });
}

function isLongProse(path, value) {
  const leaf = String(path.at(-1) ?? '');
  return value.length >= 60 && !['label', 'title'].includes(leaf) && !path.includes('columns');
}

function walk(en, zh, path, whitelist, issues, options) {
  if (Array.isArray(en)) {
    for (let i = 0; i < en.length; i += 1) walk(en[i], zh?.[i], [...path, i], whitelist, issues, options);
    return;
  }
  if (en && typeof en === 'object') {
    for (const [key, value] of Object.entries(en)) walk(value, zh?.[key], [...path, key], whitelist, issues, options);
    return;
  }
  if (typeof en !== 'string' || typeof zh !== 'string' || !isTranslatableLeaf(path, whitelist)) return;
  const targetTokens = normalizedTokens(zh);
  const missingNumbers = normalizedTokens(en).filter((token) => !targetTokens.includes(token));
  if (missingNumbers.length) {
    pushIssue(issues, {
      path: path.join('/'),
      kind: 'semantic',
      code: 'year-preservation',
      message: `missing year/date token(s): ${[...new Set(missingNumbers)].join(', ')}`,
    });
  }
  if (options.strictEditor) {
    const sourceMetrics = normalizedMetricTokens(en);
    const targetMetrics = normalizedMetricTokens(zh);
    if (JSON.stringify(sourceMetrics) !== JSON.stringify(targetMetrics)) {
      pushIssue(issues, {
        path: path.join('/'),
        kind: 'semantic',
        code: 'metric-preservation',
        message: `metric tokens changed from [${sourceMetrics.join(', ')}] to [${targetMetrics.join(', ')}]`,
      });
    }
  }
  if (isLongProse(path, en)) {
    for (const rule of hedgeRules) {
      if (rule.en.test(en) && !rule.zh.test(zh) && !rule.en.test(zh)) {
        pushIssue(issues, {
          path: path.join('/'),
          kind: 'semantic',
          code: 'hedge-preservation',
          message: `uncertainty qualifier was not preserved: ${rule.en}`,
        });
      }
    }
  }
  for (const pattern of stylePatterns) {
    if (pattern.test(zh)) {
      pushIssue(issues, {
        path: path.join('/'),
        kind: 'style',
        code: 'translationese',
        message: `translationese pattern: ${pattern}`,
      });
    }
    if (options.strictEditor) {
      for (const pattern of strictEditorStylePatterns) {
        if (pattern.test(zh)) {
          pushIssue(issues, {
            path: path.join('/'),
            kind: 'style',
            code: 'editor-translationese',
            message: `strict editorial rewrite required: ${pattern}`,
          });
        }
      }
    }
  }
  if (/[\u4e00-\u9fff][,;:][\u4e00-\u9fff]/u.test(zh)) {
    pushWarning(issues, {
      path: path.join('/'),
      kind: 'style',
      code: 'halfwidth-punctuation',
      message: 'half-width punctuation appears between Chinese characters',
    });
  }
  if (/的[^。！？；]{0,10}的[^。！？；]{0,10}的/u.test(zh)) {
    pushWarning(issues, {
      path: path.join('/'),
      kind: 'style',
      code: 'dense-de-chain',
      message: 'three 的 particles appear in a short span; flatten the noun phrase',
    });
  }
  if (/[\u4e00-\u9fff]/u.test(zh)) {
    const leaked = (zh.match(/\b[a-z][a-z-]{3,}\b/g) ?? [])
      .map((word) => word.toLowerCase())
      .filter((word) => descriptorWords.has(word));
    if (leaked.length) {
      pushWarning(issues, {
        path: path.join('/'),
        kind: 'style',
        code: 'descriptor-leak',
        message: `ordinary English descriptor remains untranslated: ${[...new Set(leaked)].join(', ')}`,
      });
    }
  }
  for (const [sourceTerm, canonicalZh] of glossaryEntries) {
    if (
      new RegExp(`\\b${sourceTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(en)
      && !zh.includes(canonicalZh)
    ) {
      pushWarning(issues, {
        path: path.join('/'),
        kind: 'glossary',
        code: 'glossary-drift',
        message: `expected canonical rendering for "${sourceTerm}": ${canonicalZh}`,
      });
    }
  }
}

export function checkPairQuality(en, zh, options = {}) {
  const issues = [];
  walk(en, zh, [], whitelistFor(en), issues, { strictEditor: options.strictEditor === true });
  return issues;
}

export function editorialQualityImproved(before, after) {
  if (after.errorCount !== 0) return false;
  return after.warningCount === 0 || after.warningCount < before.warningCount;
}

function runCli() {
  const argv = process.argv.slice(2);
  let format = 'text';
  const strictEditorIndex = argv.indexOf('--strict-editor');
  const strictEditor = strictEditorIndex !== -1;
  if (strictEditor) argv.splice(strictEditorIndex, 1);
  const formatIndex = argv.indexOf('--format');
  if (formatIndex !== -1) {
    format = argv[formatIndex + 1] ?? '';
    argv.splice(formatIndex, 2);
  }
  const [enPath, zhPath, extra] = argv;
  if (!enPath || !zhPath || extra || !['text', 'json'].includes(format)) usage(1);
  const en = load(enPath);
  const zh = load(zhPath);
  const issues = checkPairQuality(en, zh, { strictEditor });
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  if (format === 'json') {
    console.log(JSON.stringify({
      ok: errors.length === 0,
      errorCount: errors.length,
      warningCount: warnings.length,
      issues,
    }, null, 2));
    process.exit(errors.length ? 1 : 0);
  }
  if (errors.length) {
    console.error(`FAIL ${zhPath}`);
    for (const issue of errors.slice(0, 50)) {
      console.error(`  - [${issue.kind}] ${issue.path}: ${issue.message}`);
    }
    if (errors.length > 50) console.error(`  ... +${errors.length - 50} more`);
    process.exit(1);
  }
  for (const issue of warnings.slice(0, 20)) {
    console.warn(`WARN [${issue.kind}] ${issue.path}: ${issue.message}`);
  }
  if (warnings.length > 20) console.warn(`WARN ... +${warnings.length - 20} more`);
  console.log(`[check-translation-quality] ✓ hard quality gates passed; ${warnings.length} advisory finding(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) runCli();
