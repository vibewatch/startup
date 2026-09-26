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
const quantityPowers = { k: 3, m: 6, b: 9, t: 12, 千: 3, 万: 4, 亿: 8, 万亿: 12 };
const stylePatterns = [
  /对于[^。！？；]{1,24}而言/u,
  /在[^。！？；]{1,20}(?:(?<!买)方面|方面(?!前))/u,
  /通过[^。！？；，：]{1,24}(?<!带)来(?!自|源)/u,
  /在[^。！？；]{1,24}的过程中/u,
  /被设计为/u,
  /被要求/u,
  /被认为是/u,
  /正在[^。！？；，：]{1,16}(?<!集)中(?=\s*(?:[。！？；，：]|$))/u,
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
  /在[^。！？；，：]{1,16}层面/u,
  /体现了/u,
  /这构成了/u,
  /最(?:晚|迟)截至/u,
  /未达到至少/u,
];
const insuranceClaimHeads = '(?:intake|communications?|orchestration|automation|processing|handling|journeys?|platforms?|systems?(?:-of-record)?|workflows?|intelligence|infrastructure|organizations?|executives?|officers?|leaders?|modules?|messaging|experiences?|stack|volume|throughput|transformation|severity|types?|facts|participants|sales|enablement|audit|budgets?|cost|core|domain|pain|software|tech|operating|management|tooling|operations|scale|possibilities|AI|CX|lifecycle|submission|creation|work|quality|logic|coding|corrections?|accuracy|errors?|status|issues|datasets|context|data|rates?|preparation|production|routing|APIs?|histor(?:y|ies)|growth|visibility)';
const insuranceClaimModifiers = '(?:(?:AI(?:-native)?|digital|agentic|enterprise|incumbent|legacy|modern|full|complete|cloud(?:-native)?|core|narrow|broader|automated|conversational|messy|intelligent|insurance|strong|pilot|P&C|annual|manual|transactional|preventable|touchless|clean|API-based|AI-driven|rules-driven|usage-based|payer-by-payer)[ -]+)*';
const insuranceClaimNouns = new RegExp([
  `^claims?(?=[ -]+${insuranceClaimHeads}\\b)`,
  `\\b(?:across|around|for|in|on|as|of|with|without|within|through|from|by|into|over|whether|because|where|buy|sells|satisfy|captures?|supports?|shows?|show(?:s|ed)? that|adopt|request|automates?|automating|correct|autocorrects?|influence|scale|exports?|disrupts?|causing|handle)\\s+${insuranceClaimModifiers}claims?(?=[ -]+${insuranceClaimHeads}\\b)`,
  `\\b(?:a|an|the|its|their|all|enough|insurance|P&C)\\s+claims?(?=[ -]+${insuranceClaimHeads}\\b)`,
  `\\b(?:broader|modern|full|complete|AI-native|cloud-native|mission-critical|legacy|messy|existing|automatable|automated|faster|better|heavier|digitally native|annual|manual|transactional|preventable|touchless|clean|API-based|AI-driven|rules-driven|usage-based|payer-by-payer|minimum|scaled|false-positive)[ -]+${insuranceClaimModifiers}claims?(?=[ -]+${insuranceClaimHeads}\\b)`,
  `\\bclaims?(?=-(?:${insuranceClaimHeads}|only)\\b)|\\b(?:cross|per|agentic|digital|property)-claims?\\b`,
  '\\b(?:across|outside|beyond|around|and)\\s+claims(?=\\s*(?:[.,;:]|$))',
  '\\bclaims\\s+(?:is|plus)\\b',
  `\\bto claims(?=\\s+${insuranceClaimHeads}\\b)`,
  '\\b(?:start of the claim|a claim from FNOL|insurance carriers and claims organizations|signal that claims AI|carrier, claim type|chief claims officer|use cases, claims automation|tens-of-millions claim volume|no public claims list price|enterprise AI claims budgets|incumbent claims platforms and adjacent AI vendors|appraisal, or cloud claims operations)\\b',
  '^enterprise claims sales\\b',
  '^claim, photo\\b',
  '\\$\\s*\\d+(?:[.,]\\d+)*(?:[KMBT]|\\s+(?:million|billion|trillion))\\s+(?:(?:of|in)\\s+)?(?:processed\\s+claims?\\b|(?:annual\\s+)?claims?(?=\\s+(?:volume|annually)\\b|/year\\b))',
  '\\bclaim/remit\\b|\\bclaims/denial\\b',
  '^claims\\s+(?:are\\s+)?submitted\\b',
  '\\b(?:billing|eligibility|authorizations|portal)\\s*,\\s*claims(?=\\s*,)',
  '\\b(?:encounter, claim, and financial APIs|encounter and claim APIs|automated billing and claim operations|rapid visit and claim growth|sensitive data and claims workflows|payment systems, and claims workflows|customer count, and claims volume|contract type, claim volume|capital and claim volume|contracted revenue growth, claim volume|automation to claim creation|clearinghouse and claims workflow|encounter / claim workflow|into payer-ready claims|dominates revenue or claim volume)\\b',
  '\\b(?:resubmit claims by hand|payers adjudicate claims|scale claims quickly|claims and reimbursements|routes claims, eligibility data|automating claims, eligibility|request claims, collections)\\b',
  '\\b(?:eligibility(?: checks| verification)?|coding|creation|configured rules)\\s*,\\s*(?:and\\s+)?claims?(?=\\s+(?:submission|workflow|context|data)\\s*(?:[,;.]|$))',
  '\\btransaction routing, claim(?= status, remittance\\b)|\\buptime, claims(?= accuracy, (?:concentration|or incident history)\\b)',
  '\\bcustomer case study; claims(?= submission\\b)|\\bthis matters: claims(?= automation\\b)',
  ';\\s*claims(?= volume is approximate\\b)',
  '\\b(?:genomics to|from policy to|propagated to|propagate data to) claims(?=\\s*(?:[.,;:]|$))',
  '\\bcoverage\\s+(?:limits?\\s*,\\s*(?:exclusions?\\s*,\\s*and\\s+claims?\\s+procedures?|claims?\\s+triggers?)|terms\\s+and\\s+claims?\\s+histor(?:y|ies))\\b',
].join('|'), 'gi');
const hedgeRules = [
  {
    en: /\b(?:approximately|roughly)\b/i,
    zh: /约|大约|大致|粗略|近似/u,
    alternative: (source, target) => /大体/u.test(target)
      && !/\b(?:approximately|roughly)\s*(?:[$€£¥₦+-]?\s*\d|half\b|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b)/i.test(source),
  },
  {
    en: /\b(?:reportedly|according to reports)\b/i,
    zh: /据报道|据报|据称|报道称/u,
    alternative: (_, target) => /(?:^|[。！？；，：])\s*报称|(?<!根|并非|不是|没有|非|未|不|无)(?:据|根据)(?:独立|媒体|公开)报道/u.test(target),
  },
  { en: /\bestimated\b|\b(?:we|analysts?|reports?) estimate\b/i, zh: /估计|估算|预计|测算|推算|(?<!并非|不是|无需|没有|未经|未|不|无)预估/u },
  { en: /\bat least\b/i, zh: /至少|不低于/u },
  { en: /\bat most\b(?!\s+recent\b)/i, zh: /至多|最多|不超过/u },
  {
    en: /\b(?:likely|probably)\b/i,
    zh: /可能|很可能|大概率|多半|(?<!并非|不是|无需|没有|未经|未|不|无)预计/u,
    alternative: (source, target) => /\blikely[- ](?:entrants?|entry)\b/i.test(source)
      && !/\b(?:likely|probably)\b/i.test(source.replace(/\blikely[- ](?:entrants?|entry)\b/gi, ''))
      && /(?<!并非|不是|没有|不存在|不属于|非|未|不|无)潜在进入者/u.test(target),
  },
  {
    en: /\bclaims?\b|\bclaimed\s+scale\b/i,
    zh: /声称|称|说法|主张|表述|断言|声明|自述|公司口径|网站口径|反方观点/u,
    alternative: (_, target) => /(?<!并非|不是|非)公司披露的(?:汇总|增长)口径|(?<!并非|不是|非)管理层口径/u.test(target),
    excludeContext: insuranceClaimNouns,
    exclude: /\b(?:(?:for|in|of|on)\s+claims?\s+(?:modeling|modelling|processing|handling|management|adjudication|submission|settlement|opening|setup|negotiation)|patent\s+claims?\s+(?:drafting|construction|interpretation|scope)|small[- ]claims?\s+(?:processing|courts?)|clinical\s*,\s*claims?\s*,?\s+and\s+operational\s+(?:data|systems)|EHRs?\s*,\s*claims?\s+systems|fraud\s+claims?\s+handling|government\s+guarantee\s+claims?\s+status|insurance\s+coverage\s+limits?\s+and\s+claims\s+history|premium\s+and\s+claims\s+expenditure|high[- ]cost\s+claims?\s+(?:concentration|categories)|million[- ]dollar[- ]plus\s+claims|highest[- ]ROI\s+claims|claims[- ]data[- ]driven|\d+(?:\.\d+)?%\s+claims\s+cost\s+reduction|real[- ]time\s+claims\s+data|claims\s+data\s+latency(?=\s*(?:[.;]|$))|do(?:es)?\s+not\s+reveal\s+claims?\s+quality\s+or\s+jurisdictions|qualitative\s+directional\s+claim|(?:personal|bodily)[ -]injury\s+claims?|(?:anchor|inflate|weaken)\s+claims?\s+values?|claims?-inflation|InsurTech\s+claims?\s+processing|insurance\s+carriers?\s+claims?\s+automation|claims?\s+setup(?=\s*,\s*care\s+coordination\b)|per\s+claims?|open\s+claims|return(?:s|ing)?\s+claims?\s+numbers|handle\s+claims?\s+negotiation|trained\s+on\s+(?:hundreds|thousands|millions)\s+of\s+claims|malpractice\s+claims|customer\s+compensation\s+claims|billing\s+documentation\s*[;,]\s*claims?\s+validation|claims?\s+denial\s+reduction\s+data|not\s+marketing\s+claims)\b/gi,
  },
  {
    en: /\bnot yet\b/i,
    zh: /尚未|还未|仍未|还没|目前没有|尚无|尚缺|尚不|还不|仍不|(?<!并非|不是)还看不到/u,
    alternative: (source, target) => /\bnot yet available\b/i.test(source)
      && /(?<!并非|不是|非)暂无[^。！？；，：]{0,24}(?:数据|信息|记录|结果|指标)(?=[。！？；，：]|$)/u.test(target),
  },
  {
    en: /\b(?:unproven|not proven)\b/i,
    zh: /未经证实|未获证实|未(?:被)?(?:证明|验证|证实)|未在规模上得到验证|无法证明|未经验证|未获验证/u,
    alternative: (_, target) => /(?<!并非|不是|非|尚)(?:尚未跑通|未跑通|尚无公开验证|未获公开验证|还不足以证明|尚?未经证明|尚?未规模化验证|尚?未(?:在|按)[^。！？；，：]{1,24}(?:得到)?(?:验证|证实|证明))/u.test(target),
  },
  {
    en: /\bno public\b/i,
    zh: /没有(?:与[^。！？；，：]{1,40}的)?公开|无公开|尚无公开|未见公开|(?<!并非|不是)未见任何公开|(?:未|没有)(?:找到|发现)\s*(?:(?:针对[^。！？；，：]{1,40}|[A-Za-z][A-Za-z0-9 .&+-]{0,60})的\s*)?公开|未公开|未确认有公开|(?:未|尚未|没有)(?:披露|发布)公开|公开(?:资料|信息|记录|文件|数据|证据|材料|来源)(?:中)?(?:未|尚未|没有|尚无|无法)/u,
    alternative: (source, target) => /(?<!并非|不是|非|尚)尚?未见[^。！？；，：]{1,24}公开(?:第三方)?审计|(?<!并非|不是)(?:没有(?:披露任何|可验证的)公开|没有发现[^。！？；，：]{1,40}上的公开|(?:未|没有)发现\s+[A-Za-z][A-Za-z0-9 .&+-]{0,60}\s+公开|未(?:提及|披露任何)公开|公开(?:渠道|披露|层面)(?:未|没有)|公开资料不显示)/u.test(target)
      || (/\bno public\b[^.;!?]{0,120}\bfiled\b/i.test(source) && /(?<!并非|不是|非)未提交公开/u.test(target))
      || (/\bno public\b[^.;!?]{0,120}\bconfirmed\b/i.test(source) && /(?<!并非|不是|非)未确认公开/u.test(target)),
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
const relativePathToken = /(?<![^\s("'`（“‘「，：,;；:])\/[a-z0-9][a-z0-9/_-]*/gi;
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

function expandSourceFiscalYears(target, source) {
  if (!/\bFY\s*\d{2}\b/i.test(target)) return target;
  const fiscalYears = new Set([...source.matchAll(/\b(?:FY\s*|fiscal(?:\s+year)?\s+)((?:19|20)\d{2})\b/gi)]
    .map((match) => match[1]));
  const years = [...new Set(normalizedTokens(source).filter((token) => /^\d{4}$/.test(token)))];
  return target.replace(/\bFY\s*(\d{2})\b/gi, (token, suffix) => {
    const matches = years.filter((year) => year.endsWith(suffix));
    return matches.length === 1 && fiscalYears.has(matches[0]) ? `FY${matches[0]}` : token;
  });
}

const calendarMonths = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const datedCountEnd = String.raw`(?=\s*(?:$|[,;.，。；、)\]）】]|and\s+(?:${calendarMonths.join('|')})\b|[和及与]\s*(?:19|20)\d{2}\s*年))`;
const datedCountSuffix = String.raw`\s*[×x]\s*([1-9]\d*)(?!\w|\s*[.,]\s*\d)${datedCountEnd}`;
const englishDatedCount = new RegExp(String.raw`\b((${calendarMonths.join('|')})\s+((?:19|20)\d{2}))${datedCountSuffix}`, 'giu');
const chineseDatedCount = new RegExp(String.raw`(?<!\d)(((?:19|20)\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月)${datedCountSuffix}`, 'giu');

function normalizedDatedCounts(value) {
  if (!/[×x]\s*[1-9]/iu.test(value)) return { text: value, tokens: [] };
  const tokens = [];
  const record = (date, year, month, count) => {
    tokens.push(`dated-count:${year}-${month}:${count}`);
    return date;
  };
  const text = value.replace(
    englishDatedCount,
    (_, date, month, year, count) => record(date, year, calendarMonths.indexOf(month.toLowerCase()) + 1, count),
  ).replace(
    chineseDatedCount,
    (_, date, year, month, count) => record(date, year, Number(month), count),
  );
  return { text, tokens };
}

function normalizedMetricTokens(value, { includePlainNumbers = false } = {}) {
  const dated = normalizedDatedCounts(value);
  // Calendar and version-style labels are not ARR/GMV quantities.
  const separated = normalizeQuantityWords(normalizeCalendarSpacing(dated.text))
    .replace(/\bFY\s*((?:19|20)\d{2})E?\b/gi, '$1;')
    .replace(/\b(?:Q[1-4]|H[12])\b/gi, ';')
    .replace(/\b(v\d+)\b(?=\s+(?:ARR|MRR|GMV|TPV|NPL|IRR)\b)/gi, '$1;');
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
    .filter((token) => includePlainNumbers || /[$€£¥₦%]|bps|[kmbt]$|arr|mrr|gmv|tpv|npl|irr|x$|×$/i.test(token) || /^(?:19|20)\d{2}$/.test(token))
    .filter((token) => {
      if (!/^(?:19|20)\d{2}$/.test(token)) return true;
      if (years.has(token)) return false;
      years.add(token);
      return true;
    })
    .concat(dated.tokens)
    .sort();
}

function shiftDecimal(number, power) {
  const [integer, fraction = ''] = number.replace(/,/g, '').split('.');
  const digits = `${integer}${fraction}`;
  const point = integer.length + power;
  const decimal = point <= 0 ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${'0'.repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, tail = ''] = decimal.split('.');
  const trimmed = tail.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${trimmed ? `.${trimmed}` : ''}`;
}

function normalizedDollarMetrics(value) {
  let converted = 0;
  let unsupported = false;
  const expanded = normalizeQuantityWords(value).replace(
    /(?<![\w.,])(?:(\$)\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(万亿|亿|万|千|[KMBT])?|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(万亿|亿|万|千)?\s*美元)(?!\w|[.,]\d)/giu,
    (match, dollar, prefixNumber, prefixUnit, suffixNumber, suffixUnit, offset, text) => {
      const before = text.slice(0, offset);
      const after = text.slice(offset + match.length);
      if (/[-−+–—负]\s*$/u.test(before) || /^\s*[-−–—]/u.test(after)
          || /^\s*(?:[%％×倍]|(?:ARR|MRR|GMV|TPV|NPL|IRR|bps|x)\b)/iu.test(after)
          || /\d[\d.,]*\s*(?:[KMBT]|万亿|亿|万|千)?\s*(?:美元)?\s*(?:to|至|到)\s*$/iu.test(before)
          || /^\s*(?:to|至|到)\s*[$\d]/iu.test(after)
          || dollar && /\b(?:EUR|GBP|JPY|CNY|RMB|HKD|AUD|CAD|SGD|INR|KRW|TWD|CHF|NGN|NZD)\s*$/i.test(before)
          || dollar && /^\s*(?:EUR|GBP|JPY|CNY|RMB|HKD|AUD|CAD|SGD|INR|KRW|TWD|CHF|NGN|NZD)\b/i.test(after)
          || /[(（]\s*$/u.test(before) && /^\s*[)）]/u.test(after)) {
        unsupported = true;
        return match;
      }
      const unit = prefixUnit ?? suffixUnit;
      converted += 1;
      return `$${shiftDecimal(prefixNumber ?? suffixNumber, (unit ? quantityPowers[unit.toLowerCase()] : 0) - 6)}M `;
    },
  );
  return converted && !unsupported
    ? normalizedCountMetrics(expanded, { normalizeMonths: true, allowUnconverted: true })
    : null;
}

function normalizedCountMetrics(value, { normalizeMonths = false, allowUnconverted = false, normalizeGroupedCounts = false } = {}) {
  const dated = normalizedDatedCounts(value);
  value = dated.text;
  const monthAnchors = new Set();
  const calendar = normalizeMonths ? value.replace(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\b/gi,
    (_, month, year) => {
      const number = calendarMonths.indexOf(month.toLowerCase()) + 1;
      monthAnchors.add(`month:${year}-${number}`);
      return `${year};${number};`;
    },
  ) : value;
  if (normalizeMonths) {
    for (const [, year, month] of value.matchAll(/(?<!\d)((?:19|20)\d{2})\s*年\s*(0?[1-9]|1[0-2])\s*月/gu)) {
      monthAnchors.add(`month:${year}-${Number(month)}`);
    }
    const years = [...new Set(normalizedTokens(value).filter((token) => /^(?:19|20)\d{2}$/.test(token)))];
    // An omitted repeated year is unambiguous only within a single-year leaf.
    if (years.length === 1) {
      for (const [, month] of value.matchAll(/(?<![\d.])(0?[1-9]|1[0-2])\s*月/gu)) {
        monthAnchors.add(`month:${years[0]}-${Number(month)}`);
      }
    }
  }
  const normalized = normalizeQuantityWords(normalizeCalendarSpacing(normalizeWrittenPercentages(calendar)));
  let converted = 0;
  let unsupported = false;
  const expanded = normalized.replace(
    /(?<![\w.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(?:多|余)?\s*(万亿|亿|万|千)(?![十百千万亿兆])|([KMBT])(?![a-z])|(?<=\d,\d{3})(?![\w.,]))/giu,
    (match, number, chineseUnit, englishUnit, offset, text) => {
      const before = text.slice(0, offset);
      const after = text.slice(offset + match.length);
      const unit = chineseUnit ?? englishUnit;
      if (!unit && !normalizeGroupedCounts) return match;
      if (/(?:\p{Sc}|\b(?:USD|EUR|GBP|JPY|CNY|RMB|HKD|AUD|CAD|SGD|INR|KRW|TWD|CHF|NGN))\s*$/iu.test(before)
          || /^\s*(?:\p{Sc}|(?:USD|EUR|GBP|JPY|CNY|RMB|HKD|AUD|CAD|SGD|INR|KRW|TWD|CHF|NGN|dollars?|euros?|pounds?|yuan|yen|rupees?|won)\b|美元|美金|元|欧元|英镑|港币|港元|日元|人民币|新台币|台币|澳元|加元|新加坡元|新币|瑞郎|卢比|卢布|韩元|奈拉)/iu.test(after)) {
        return match;
      }
      if (!unit && (/^\s*(?:[十百千万亿兆]|[KMBT](?![a-z])|(?:ARR|MRR|GMV|TPV|NPL|IRR)\b)/iu.test(after)
          || /[(（]\s*$/u.test(before) && /^\s*[)）]/u.test(after))) {
        return match;
      }
      if (/^\s*(?:[%％×倍]|(?:bps|x|percent)\b)/iu.test(after)) {
        unsupported = true;
        return match;
      }
      // Shared-unit ranges and signed counts need more context than a scalar conversion.
      const afterPlusWord = after.replace(/^\s*-plus\b/i, '');
      if (/[-−+–—]\s*$/u.test(before)
          || /\d[\d.,]*\s*(?:to|and|or|至|到|和|或)\s*$/iu.test(before)
          || /^\s*[-−+–—]/u.test(afterPlusWord)) {
        unsupported = true;
        return match;
      }
      // Shift decimal text exactly; large counts must not lose integer precision.
      converted += 1;
      return `${shiftDecimal(number, (unit ? quantityPowers[unit.toLowerCase()] : 0) - 6)}M `;
    },
  );
  return (converted || allowUnconverted) && !unsupported
    ? [...normalizedMetricTokens(expanded, { includePlainNumbers: true }), ...monthAnchors, ...dated.tokens].sort()
    : null;
}

function equivalentTripledMetrics(source, target) {
  if (!/\btripl(?:e|ed|ing)\b/i.test(source)) return false;
  const quantities = normalizeQuantityWords(`${source}\n${target}`);
  if (/\b(?:nearly|almost|roughly|about|approximately|over|more than|less than|at least|at most)\s+tripl(?:e|ed|ing)\b/i.test(source)
      || /\b(?:doubl(?:e|ed|es|ing)|quadrupl(?:e|ed|es|ing)|quintupl(?:e|ed|es|ing)|twice|thrice)\b/i.test(source)
      || /(?:增加|增长|提高|提升|上涨|上升|扩大|翻)(?:了)?\s*(?:约|大约)?\s*\d+(?:\.\d+)?\s*(?:x\b|×|倍)/iu.test(target)
      || /(?:超过|超出|不到|不足|接近|大约|约|至少|至多|最多|多于|少于)\s*\d+(?:\.\d+)?\s*(?:x\b|×|倍)|\d+(?:\.\d+)?\s*(?:x\b|×|倍)\s*(?:以上|以下|左右|上下|多|余)/iu.test(target)
      || /[-+−–—]\s*\d+(?:[.,]\d+)*\s*(?:x\b|×|倍)|\d+(?:[.,]\d+)*\s*(?:x\b|×|倍)\s*[-+−–—]/iu.test(quantities)
      || /[-+−–—]\s*[$€£¥₦]\s*\d|[(（]\s*[$€£¥₦]\s*\d+(?:[.,]\d+)*\s*[KMBT]?\s*[)）]/iu.test(quantities)) return false;
  const expanded = source.replace(
    /(?<![\w./@-])(?:tripled|tripling|triple(?=\s+(?:the|its|their|our)\b))\b(?![-/]|\.[a-z]|\s+(?:down|up)\b)/gi,
    '3x',
  );
  if (expanded === source || /\btripl(?:e|ed|ing)\b/i.test(expanded)) return false;
  return [false, true].some((normalizeGroupedCounts) => {
    const options = { normalizeMonths: true, allowUnconverted: true, normalizeGroupedCounts };
    const sourceTokens = normalizedCountMetrics(expanded, options);
    const targetTokens = normalizedCountMetrics(target, options);
    return sourceTokens && targetTokens && JSON.stringify(sourceTokens) === JSON.stringify(targetTokens);
  });
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
  const numericTarget = expandSourceFiscalYears(zh, en);
  const targetTokens = normalizedTokens(numericTarget);
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
    let targetMetrics = normalizedMetricTokens(numericTarget);
    // Resolve written ratios only against an otherwise mismatched numeric anchor.
    if (JSON.stringify(sourceMetrics) !== JSON.stringify(targetMetrics)) {
      targetMetrics = normalizedMetricTokens(normalizeWrittenPercentages(numericTarget));
    }
    if (JSON.stringify(sourceMetrics) !== JSON.stringify(targetMetrics)) {
      const equivalentCounts = [false, true].some((normalizeGroupedCounts) => [false, true].some((normalizeMonths) => {
        const sourceCounts = normalizedCountMetrics(en, { normalizeMonths, normalizeGroupedCounts });
        const targetCounts = normalizedCountMetrics(numericTarget, { normalizeMonths, normalizeGroupedCounts });
        return sourceCounts && targetCounts && JSON.stringify(sourceCounts) === JSON.stringify(targetCounts);
      }));
      const sourceDollars = equivalentCounts ? null : normalizedDollarMetrics(en);
      const targetDollars = equivalentCounts ? null : normalizedDollarMetrics(numericTarget);
      const equivalentDollars = sourceDollars && targetDollars
        && JSON.stringify(sourceDollars) === JSON.stringify(targetDollars);
      if (!equivalentCounts && !equivalentDollars && !equivalentTripledMetrics(en, numericTarget)) {
        pushIssue(issues, {
          path: path.join('/'),
          kind: 'semantic',
          code: 'metric-preservation',
          message: `metric tokens changed from [${sourceMetrics.join(', ')}] to [${targetMetrics.join(', ')}]`,
        });
      }
    }
  }
  if (isLongProse(path, en)) {
    for (const rule of hedgeRules) {
      const withoutContext = rule.excludeContext ? en.replace(rule.excludeContext, '') : en;
      const sourceText = rule.exclude ? withoutContext.replace(rule.exclude, '') : withoutContext;
      if (rule.en.test(sourceText) && !rule.zh.test(zh)
          && !rule.alternative?.(sourceText, zh) && !rule.en.test(zh)) {
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
    const sourcePaths = new Set([...en.matchAll(relativePathToken)]
      .filter((match) => !/(?:\d(?:[KMBT]|\s*(?:thousand|million|billion|trillion))?\+?|\p{Sc})\s*$/iu.test(en.slice(0, match.index)))
      .map((match) => match[0]));
    const descriptorText = zh.replace(urlToken, '').replace(relativePathToken, (route) => sourcePaths.has(route) ? '' : route);
    const leaked = (descriptorText.match(/\b[a-z][a-z-]{3,}\b/g) ?? [])
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
