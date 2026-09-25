#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { isTranslatableLeaf, whitelistFor } from './whitelist.mjs';

function usage(code = 0) {
  console.error('Usage: check-translation-quality.mjs <english.yaml> <chinese.zh.yaml> [--strict-editor] [--format text|json]');
  process.exit(code);
}

const invariantToken = /\b(?:FY\s*)?(?:19|20)\d{2}E?\b/gi;
const calendarDateToken = /\b((?:19|20)\d{2})(?:-(\d{1,2})-(\d{1,2})\b|\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日)/gu;
const metricToken = /(?:[$€£¥₦]\s*)?\d+(?:[.,]\d+)*(?:[KMBT](?![a-z])|\s?(?:x|×|倍|%|bps|ARR|MRR|GMV|TPV|NPL|IRR))?/gi;
const stylePatterns = [
  /对于[^。！？；]{1,24}而言/u,
  /在[^。！？；]{1,20}方面/u,
  /通过[^。！？；，：]{1,24}来(?!自)/u,
  /在[^。！？；]{1,24}的过程中/u,
  /被设计为/u,
  /被要求/u,
  /被认为是/u,
  /正在[^。！？；，：]{1,16}(?<!集)中/u,
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
  { en: /\bestimated\b|\b(?:we|analysts?|reports?) estimate\b/i, zh: /估计|估算|预计|测算|推算/u },
  { en: /\bat least\b/i, zh: /至少|不低于/u },
  { en: /\bat most\b/i, zh: /至多|最多|不超过/u },
  { en: /\b(?:likely|probably)\b/i, zh: /可能|很可能|大概率|多半/u },
  {
    en: /\bclaims?\b/i,
    zh: /声称|称|说法|主张|表述|断言|声明|公司口径/u,
    exclude: /\b(?:(?:for|in|of|on)\s+claims?\s+(?:modeling|modelling|processing|handling|management|adjudication|submission|settlement)|patent\s+claims?\s+(?:drafting|construction|interpretation|scope)|small[- ]claims?\s+(?:processing|courts?)|clinical\s*,\s*claims?\s*,?\s+and\s+operational\s+(?:data|systems)|EHRs?\s*,\s*claims?\s+systems|fraud\s+claims?\s+handling|government\s+guarantee\s+claims?\s+status)\b/gi,
  },
  { en: /\bnot yet\b/i, zh: /尚未|还未|仍未|还没|目前没有|尚无|尚不|还不|仍不/u },
  { en: /\b(?:unproven|not proven)\b/i, zh: /未经证实|未获证实|未(?:被)?(?:证明|验证|证实)|未在规模上得到验证|无法证明|未经验证|未获验证/u },
  {
    en: /\bno public\b/i,
    zh: /没有公开|无公开|尚无公开|未见公开|(?:未|没有)(?:找到|发现)(?:针对[^。！？；，：]{1,40}的)?公开|未公开|(?:未|尚未|没有)(?:披露|发布)公开|公开(?:资料|信息|记录|文件|数据|证据)(?:中)?(?:未|尚未|没有|尚无)/u,
    exclude: /\bno public[- ]cloud(?:\s+LLM)?\s+APIs?\s+(?:are\s+)?allowed\b|\b(?:has|have)\s+no public\s+IP\s+address(?:es)?(?=\s*(?:[.;,]|$))/gi,
  },
  {
    en: /\bno public[- ]cloud(?:\s+LLM)?\s+APIs?\s+(?:are\s+)?allowed\b/i,
    zh: /(?:不允许|禁止|不得|不能|禁用)\s*(?:使用|接入|调用)?\s*(?:公有云|公共云)|(?:公有云|公共云)[^。！？；，]{0,24}(?:不允许|禁止|不得|不能)(?:使用|接入|调用)/u,
  },
  {
    en: /\b(?:has|have)\s+no public\s+IP\s+address(?:es)?(?=\s*(?:[.;,]|$))/i,
    zh: /(?<!并非|不是|非)(?:没有|无|不设|不具备)\s*(?:任何\s*)?(?:公共|公网|公有)\s*IP\b(?:\s*地址)?/u,
  },
];
const urlToken = /(?:https?:\/\/|www\.)[^\s<>()（）「」，。；：！？]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>()（）「」，。；：！？]*)?/gi;
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

function normalizeQuantityWords(value) {
  const units = { thousand: 'K', million: 'M', billion: 'B', trillion: 'T' };
  return value.replace(
    /([$€£¥₦]\s*)(\d+(?:[.,]\d+)*)(?:(\+)\s*|\s*-\s*)(thousand|million|billion|trillion)\b/gi,
    (_, currency, number, plus, unit) => `${currency}${number}${units[unit.toLowerCase()]}${plus ?? ''}`,
  ).replace(
    /\b(\d+(?:[.,]\d+)*)\s*(thousand|million|billion|trillion)\b/gi,
    (_, number, unit) => `${number}${units[unit.toLowerCase()]}`,
  ).replace(
    /\b(\d+(?:[.,]\d+)*)\s*(?:percent|per\s+cent)\b/gi,
    '$1%',
  );
}

function normalizeWrittenPercentages(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return value.replace(
    /百分之(一百|[一二三四五六七八九]?十[一二三四五六七八九]?|[零〇一二三四五六七八九])(?:点([零〇一二三四五六七八九]+))?(?![零〇一二两三四五六七八九十百千万亿点\d])/gu,
    (_, integer, decimal) => {
      const [tens, ones] = integer.split('十');
      const amount = integer === '一百' ? 100 : integer.includes('十')
        ? (digits[tens] ?? 1) * 10 + (digits[ones] ?? 0)
        : digits[integer];
      return `${amount}${decimal ? `.${[...decimal].map((digit) => digits[digit]).join('')}` : ''}%`;
    },
  ).replace(
    /(超过|超|约|近|至少|至多|占比|占|低于|高于|不到|不足|多达|不低于|不超过)([一二三四五六七八九十])成(?![零〇一二两三四五六七八九十半\d])/gu,
    (_, prefix, digit) => `${prefix}${digit === '十' ? 100 : digits[digit] * 10}%`,
  );
}

function normalizeCalendarSpacing(value) {
  return value.replace(/\\[nr]/g, ' ').replace(
    /\b((?:FY\s*)?(?:19|20)\d{2}E?)(Q[1-4]|H[12])\b/gi,
    '$1 $2',
  );
}

function normalizedTokens(value) {
  const normalized = normalizeQuantityWords(normalizeCalendarSpacing(value));
  const years = (normalized.match(invariantToken) ?? [])
    .map((token) => token.replace(/^FY\s*/i, '').replace(/E$/i, '').replace(/\s+/g, ''));
  const dates = [...normalized.matchAll(calendarDateToken)].map((match) => (
    `${match[1]}-${(match[2] ?? match[4]).padStart(2, '0')}-${(match[3] ?? match[5]).padStart(2, '0')}`
  ));
  return [...years, ...dates];
}

function normalizedMetricTokens(value) {
  // Calendar labels are not ARR/GMV quantities, even when they precede the metric.
  const separated = normalizeQuantityWords(normalizeCalendarSpacing(value))
    .replace(/\bFY\s*((?:19|20)\d{2})E?\b/gi, '$1;')
    .replace(/\b(?:Q[1-4]|H[12])\b/gi, ';');
  // Retention-relative phrases imply percentages, unlike nearby customer/cohort counts.
  const retention = separated.replace(
    /\b((?:NRR|GRR|NDR)\s+(?:(?:is|in|the|low|mid|high|teens|trends?)\b[\s-]*)*(?:above|below|towards?|around|near|of|at)\s+(?:(?:low|mid|high)[ -]+)?)(\d{2,3}(?:\.\d+)?)(s)?(?=\s*(?:[,.;]|$))/gi,
    '$1$2%$3',
  );
  // A trailing multiplier or percentage applies to both endpoints of a range.
  const expanded = retention.replace(/\b(\d+(?:[.,]\d+)*)[\s-]*fold\b/gi, '$1x').replace(
    /(\d+(?:[.,]\d+)*)\s*([-–—])\s*(\d+(?:[.,]\d+)*)\s*(x|×|倍|%)/gi,
    '$1$4$2$3$4',
  );
  const years = new Set();
  return (expanded.match(metricToken) ?? [])
    .map((token) => token.replace(/\s+/g, '').replace(/,/g, '').replace(/[×倍]$/u, 'x').toLowerCase())
    // "2026 ARR" labels a year; a currency-prefixed amount is not a calendar label.
    .map((token) => token.replace(/^((?:19|20)\d{2})(?:arr|mrr|gmv|tpv|npl|irr)$/, '$1'))
    .filter((token) => /[$€£¥₦%]|bps|[kmbt]$|arr|mrr|gmv|tpv|npl|irr|x$|×$/i.test(token) || /^(?:19|20)\d{2}$/.test(token))
    .filter((token) => {
      if (!/^(?:19|20)\d{2}$/.test(token)) return true;
      if (years.has(token)) return false;
      years.add(token);
      return true;
    })
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
    let targetMetrics = normalizedMetricTokens(zh);
    // Resolve written ratios only against an otherwise mismatched numeric anchor.
    if (JSON.stringify(sourceMetrics) !== JSON.stringify(targetMetrics)) {
      targetMetrics = normalizedMetricTokens(normalizeWrittenPercentages(zh));
    }
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
      const sourceText = rule.exclude ? en.replace(rule.exclude, '') : en;
      if (rule.en.test(sourceText) && !rule.zh.test(zh) && !rule.en.test(zh)) {
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
    const leaked = (zh.replace(urlToken, '').match(/\b[a-z][a-z-]{3,}\b/g) ?? [])
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
