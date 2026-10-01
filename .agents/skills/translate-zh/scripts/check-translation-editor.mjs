#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { checkPairQuality, editorialQualityImproved } from './check-translation-quality.mjs';
import { untranslatedMessage } from './check-translation.mjs';

function fullReport(subtitle) {
  return {
    schemaVersion: 'report-v2',
    artifact: 'full-report',
    subtitle,
  };
}

const source = fullReport('Approximately $10M revenue in 2025 is not yet audited.');
const clean = fullReport('2025 年收入约 $10M，尚未经审计。');
const changedMetric = fullReport('2025 年收入约 $11M，尚未经审计。');
const translationese = fullReport('对于投资者而言，2025 年收入约 $10M，尚未经审计。');
const strictTranslationese = fullReport('2025 年收入约 $10M，这表明公司尚未经审计。');
const suffixBoundarySource = fullReport('Founded in 2016, the baseline includes 170M members.');
const suffixBoundaryClean = fullReport('公司成立于 2016 年，基准口径覆盖 170M 名会员。');
const nominalClaimSource = fullReport('The reviewed insurance data provides an adversarial baseline for claims modeling.');
const assertionSource = fullReport('The company claims its new system improves the operational baseline for claims modeling.');
const fiscalYearSource = fullReport('Cumulative revenue milestones are due by the end of fiscal year 2029.');
const negativeExamples = [
  ['No public GMV, conversion, or basket-size uplift is disclosed.', '公开资料未披露 GMV、转化率或客单价提升。', '公开资料披露了 GMV、转化率和客单价提升。'],
  ['The contract provides no public renewal or customer spending data.', '合同的续约与客户支出数据未公开。', '合同的续约与客户支出数据已公开。'],
  ['FedRAMP authorization timeline: no public milestone disclosed; could be 12–36 months away.', 'FedRAMP 授权时间表：公司未披露公开里程碑，可能还需 12–36 个月。', 'FedRAMP 授权时间表：公司已披露公开里程碑，可能还需 12–36 个月。'],
  ["No public milestone disclosed; only 'in assessment' status available.", '尚未发布公开里程碑；只有「评估中」状态。', '已发布公开里程碑；只有「评估中」状态。'],
  ['Regulatory data residency (GDPR, MiFID II, OSFI); no public cloud LLM API allowed.', '监管要求数据驻留（GDPR、MiFID II、OSFI）；不允许使用公有云 LLM API。', '监管要求数据驻留（GDPR、MiFID II、OSFI）；允许使用公有云 LLM API。'],
  ['Regulatory data residency requires private infrastructure; no public-cloud APIs are allowed.', '监管要求数据驻留并使用私有基础设施；公有云 API 不得使用。', '监管要求数据驻留并使用私有基础设施；公有云 API 可以使用。'],
  ['No public cloud performance data has been disclosed for this platform.', '该平台的公有云性能数据未公开。', '该平台的公有云性能数据已公开。'],
  ['Beta access only; pricing unknown; reliability unproven at scale.', '仅限 beta 接入；定价未知；规模化可靠性未验证。', '仅限 beta 接入；定价未知；规模化可靠性已验证。'],
  ['It looks like a future leader, but not yet like a company ready for the public markets.', '公司看似有望成为未来的领头羊，但还不像已做好上市准备。', '公司看似有望成为未来的领头羊，也已做好上市准备。'],
  ['Small teams do not yet need a full product-development system of record.', '小团队尚不需要完整的产品开发记录系统。', '小团队需要完整的产品开发记录系统。'],
  ['The evidence supports the thesis at the workflow level, but not yet at the scale of a fully underwritten category leader.', '证据支持工作流需求，但还没到能充分支撑品类龙头投资判断的程度。', '证据支持工作流需求，也充分支撑了品类龙头的投资判断。'],
  ['The homepage highlights enterprise compliance. Those claims alone do not prove broad enterprise penetration.', '官网强调企业合规；这些表述本身不能证明公司已广泛渗透企业市场。', '企业合规水平很高，但这本身不能证明公司已广泛渗透企业市场。'],
];
const multiplierSource = fullReport('Harvey pricing is 5-10x Spellbook and 2-5x CoCounsel.');
const patentSource = fullReport('Trademark search analysis, patent claim drafting, freedom-to-operate research');
const patentAssertionSource = fullReport('The company claims its new product improves patent claim drafting.');
const noPublicIpSource = 'The architecture documentation says these warehouses have no public IP addresses.';
const noPublicIpAndMilestoneSource = `${noPublicIpSource} The IPO timeline has no public milestone disclosed.`;
const legalClaimNounPairs = [
  ['The founder observed a family member navigate a personal injury claim.', '创始人曾目睹家人处理人身伤害索赔。'],
  ['The workflow supports bodily-injury claims.', '该流程支持人身伤害索赔。'],
  ['InsurTech claims processing platforms serve insurers.', 'InsurTech 理赔处理平台服务保险公司。'],
  ['AI letters may inflate or anchor claim values; certifications do not address claim-inflation or bias concerns.', 'AI 索赔函可能抬高或锚定索赔金额；认证不能回应索赔膨胀或偏见担忧。'],
  ['Treatment gaps weaken claim value; insurers are more sophisticated in claims processing.', '治疗缺口会削弱索赔价值；保险公司的理赔处理也更成熟。'],
  ['Insurance carrier claims automation, AI reserve setting, fraud detection', '保险公司理赔自动化、AI 准备金设定、欺诈检测'],
  ['Legal staff: claim setup, care coordination, records retrieval', '法律人员：索赔建档、护理协调、病历调取'],
  ['AI agents for claim opening, coverage confirmation, client check-ins', '用于索赔建档、确认保险范围和客户回访的 AI 智能体'],
  ['Staff calls carrier; 16+ minutes per claim average (EvenUp estimate)', '员工致电保险公司；平均每案 16+ 分钟（EvenUp 估计）'],
  ['Agents open claims in parallel, returning claim numbers.', '智能体并行开立理赔，返回理赔编号。'],
  ['Staff handle claim negotiation and optional lien resolution.', '员工处理索赔谈判和可选留置权解决。'],
  ['PI-specific flows trained on thousands of claims', 'PI 专用流程用数千宗索赔训练'],
  ['Incorrect citations could expose attorneys to malpractice claims.', '错误引用可能让律师面临执业过失索赔。'],
  ['Reputational risk; likely customer compensation claims; pause adoption pending resolution.', '声誉风险；可能引发客户赔偿索赔；问题解决前暂停采用。'],
].map(([en, zh]) => [`${en} This is a diligence observation.`, `${zh} 这是尽调观察。`]);

function entryMultiplePair({ header = 'Exit Multiple at 5.6B Entry', target = '以 $5.6B 入场的退出倍数',
  valuationHeader = 'Valuation by 2028', values = ['$8B–$15B', '$2B–$4B'], notes = '', duplicateColumn = false } = {}) {
  const en = { ...fullReport(''), tables: [{
    columns: [valuationHeader, header, ...(duplicateColumn ? [valuationHeader] : [])],
    rows: values.map(value => [value, '1.4×', ...(duplicateColumn ? [value] : [])]),
    notes,
  }] };
  const zh = structuredClone(en);
  zh.tables[0].columns[1] = target;
  return [en, zh];
}

const checks = [
  ...[
    ...[
      ['No public pricing or customer-specific qualification data retained', '未留存公开定价或客户特定认证数据'],
      ['No public quote sheet or exhaustive installed-base list retained', '未留存公开报价单或完整装机基础清单'],
      ['No public production deployment references or quote examples retained', '未留存公开的生产部署引用或报价示例'],
      ['No public software architecture or cybersecurity detail retained', '未留存公开的软件架构或网络安全细节'],
      ['No public certification file package or field-service documentation retained', '未留存公开认证文件包或现场服务文档'],
    ].map(([en, zh]) => [en, zh, false]),
    ['No public quote sheet retained.', '已留存公开报价单。', true],
    ['No public quote sheet retained.', '并非未留存公开报价单。', true],
    ['No public quote sheet retained.', '不是 未留存公开报价单。', true],
    ['No public quote sheet retained.', '未留存历史缓存，报价资料齐全。', true],
    ['No public quote sheet retained; no public audit disclosed.', '未留存公开报价单；审计齐全。', true],
    ['No public quote sheet exists.', '未留存公开报价单。', true],
    ['No public customer information may be retained.', '未留存公开客户信息。', true],
    ['No public quote sheet was not retained.', '未留存公开报价单。', true],
    ['No public list price appeared in the retained materials.', '留存材料没有出现公开标价。', false],
    ['No public list price appeared in the retained materials.', '留存材料并非没有出现公开标价。', true],
    ['No public list price appeared in the retained materials.', '留存材料没有出现旧报价，公开标价齐全。', true],
    ['No public list price appeared in the retained materials; no public audit exists.', '留存材料没有出现公开标价；审计齐全。', true],
    ['No public list price exists.', '留存材料没有出现公开标价。', true],
    ['The concentration risk is plausibly material but not yet quantifiable.', '集中度风险可能有实质影响，只是目前还无法量化。', false],
    ['The concentration risk is not yet quantifiable.', '目前还无法量化。', false],
    ['The concentration risk is not yet quantifiable.', '并非目前还无法量化。', true],
    ['The concentration risk is not yet quantifiable.', '目前已经可以量化。', true],
    ['The concentration risk is not yet quantifiable and revenue is not yet disclosed.', '目前还无法量化；收入齐全。', true],
    ['The business is not yet profitable.', '目前还无法量化。', true],
    ['No public customer-count or ACV disclosure by industrial vertical', '没有按工业垂直披露公开客户数或 ACV', false],
    ['No public customer-count or ACV disclosure by industrial vertical', '并非没有按工业垂直披露公开客户数或 ACV', true],
    ['No public customer-count or ACV disclosure by industrial vertical', '没有按时披露公开客户数或 ACV', true],
    ['No public customer-count or ACV disclosure by industrial vertical', '没有按工业垂直披露公开收入或 ACV', true],
    ['No public customer-count or ACV disclosure by industrial vertical; no public audit.', '没有按工业垂直披露公开客户数或 ACV；审计齐全。', true],
    ['No public renewal, churn, or expansion-rate data for health-system accounts', '没有医疗系统账户的公开续约、流失或扩张率数据', false],
    ['No public renewal data for health-system accounts.', '并非没有医疗系统账户的公开续约数据。', true],
    ['No public renewal data for health-system accounts.', '没有医疗系统账户，但有公开续约数据。', true],
    ['No public renewal data for health-system accounts; no public audit.', '没有医疗系统账户的公开续约数据；审计齐全。', true],
    ['No public hardware failure-rate, MTBF, or warranty-claim disclosure', '未公开硬件故障率、MTBF 或保修索赔披露', false],
    ['No public warranty-claim disclosure. The company claims superior reliability.', '未公开保修索赔信息；可靠性优越。', true],
    ['The warranty provider claims disclosure is complete.', '保修供应商的披露完整。', true],
    ['Positions are qualitative judgments derived from claim evidence, not statistical probabilities.', '位置是基于已列证据作出的定性判断，并非统计概率。', false],
    ['Positions are qualitative judgments derived from claim evidence, not statistical probabilities.', '位置是基于已列证据作出的定性判断，是统计概率。', true],
    ['Positions are qualitative judgments derived from claim evidence, not statistical probabilities.', '位置是基于已列证据作出的定性判断，并非不是统计概率。', true],
    ['Positions are qualitative judgments derived from claim evidence, not statistical probabilities. The company claims superior accuracy.', '位置是基于已列证据作出的定性判断，并非统计概率；准确率更高。', true],
    ['This table captures only controls visible in retained public materials; absence claims refer to missing public evidence, not to proof that private controls do not exist.', '本表只收录留存公开材料中可见的控制；“缺失”指缺少公开证据，不等于证明私有控制不存在。', false],
    ['This table captures only controls visible in retained public materials; absence claims refer to missing public evidence, not to proof that private controls do not exist.', '本表只收录留存公开材料中可见的控制；“缺失”指缺少公开证据，证明私有控制不存在。', true],
    ['This table captures only controls visible in retained public materials; absence claims refer to missing public evidence, not to proof that private controls do not exist.', '本表只收录留存公开材料中可见的控制；“缺失”指缺少公开证据，不等于证明私有控制存在。', true],
    ['Absence claims refer to missing public evidence, not to proof that private controls do not exist. The company claims superior controls.', '“缺失”指缺少公开证据，不等于证明私有控制不存在；控制优越。', true],
  ].flatMap(([en, zh, expected]) => ['prose', 'table', 'figure'].map(surface => {
    const wrap = value => surface === 'prose' ? fullReport(value)
      : surface === 'table' ? { ...fullReport(''), tables: [{ rows: [[value]] }] }
        : { ...fullReport(''), figures: [{ approximationNotes: value }] };
    const source = `${en.replace(/\.$/u, '')}. This is an observation from the retained diligence review.`;
    const target = `${zh.replace(/。$/u, '')}。这是留存尽调报告中的观察。`;
    return [
      checkPairQuality(wrap(source), wrap(target), { strictEditor: true }).some(issue => issue.code === 'hedge-preservation') === expected,
      `retained evidence, scope and nominal claims (${surface}): ${en} / ${zh}`,
    ];
  })),
  ...[
    ...[
      ['Jan', 1], ['Feb', 2], ['Mar', 3], ['Apr', 4], ['Jun', 6], ['Jul', 7],
      ['Aug', 8], ['Sep', 9], ['Sept', 9], ['Oct', 10], ['Nov', 11], ['Dec', 12],
    ].flatMap(([month, number]) => [
      [`Revenue tripled in ${month} 2025.`, `2025 年 ${number} 月收入增至 3 倍。`, false],
      [`Revenue tripled in ${month.toLowerCase()}. 2025.`, `2025 年 ${number} 月收入增至 3 倍。`, false],
    ]),
    ['Flagship at commercial scale; tripled sales in 12 months to Apr 2025', '商业规模旗舰产品；截至 2025 年 4 月的 12 个月内，销售额增至原来的 3 倍', false],
    ['Revenue tripled in Apr. 2025.', '2025 年 4 月收入增至 3 倍。', false],
    ['Revenue tripled in May 2025.', '2025 年 5 月收入增至 3 倍。', false],
    ['Revenue tripled in Jan 1900.', '1900 年 1 月收入增至 3 倍。', false],
    ['Revenue tripled in Dec 2099.', '2099 年 12 月收入增至 3 倍。', false],
    ['Revenue tripled in Apr 2025 and usage tripled in May 2026.', '2025 年 4 月收入增至 3 倍，2026 年 5 月用量增至 3 倍。', false],
    ['Revenue tripled from $10M to $30M in Apr 2025.', '2025 年 4 月收入从 $10M 增至 $30M，为原来的 3 倍。', false],
    ['Revenue tripled in Jan 2025 after 9007199254740993 events.', '9007199254740993 次事件后，2025 年 1 月收入增至 3 倍。', false],
    ['Revenue tripled; filings: Aug 2015 ×2 and Sep 2016 ×3.', '收入增至 3 倍；备案：2015 年 8 月 ×2 及 2016 年 9 月 ×3。', false],
    ['Revenue tripled in April 2025.', 'Apr. 2025 收入增至 3 倍。', false],
    ['Revenue tripled in Apr 2025.', 'apr. 2025 收入增至 3 倍。', false],
    ['Revenue tripled in Apr 2025 and usage tripled in May 2025.', '2025 年 4 月收入增至 3 倍，5 月用量增至 3 倍。', false],
    ['Revenue tripled under the APR 2025 label.', 'APR 2025 口径下，收入增至 3 倍。', false],
    ['Revenue tripled in Apr 2025.', '2025 年 5 月收入增至 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年收入增至 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2026 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入增至 4 倍。', true],
    ['Revenue tripled in Apr 2025 and usage tripled in May 2026.', '2025 年 5 月收入增至 3 倍，2026 年 4 月用量增至 3 倍。', true],
    ['Revenue tripled in Apr 2025 after 12 deployments.', '13 次部署后，2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled in Jan 2025 after 9007199254740993 events.', '9007199254740992 次事件后，2025 年 1 月收入增至 3 倍。', true],
    ['Revenue tripled from $10M to $30M in Apr 2025.', '2025 年 4 月收入从 $11M 增至 $30M，为原来的 3 倍。', true],
    ['Revenue tripled from $10M to $30M in Apr 2025.', '2025 年 4 月收入从 €10M 增至 €30M，为原来的 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入增长 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入翻了 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入增至约 3 倍。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入增至 3 倍以上。', true],
    ['Revenue tripled in Apr 2025.', '2025 年 4 月收入增至 -3 倍。', true],
    ['Revenue nearly tripled in Apr 2025.', '2025 年 4 月收入接近 3 倍。', true],
    ['Revenue tripled and costs doubled in Apr 2025.', '2025 年 4 月收入增至 3 倍，成本上升。', true],
    ['Revenue tripled; filings: Aug 2015 ×2.', '收入增至 3 倍；备案：2015 年 8 月 ×3。', true],
    ['Revenue tripled under APR 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled under JAN 2025.', '2025 年 1 月收入增至 3 倍。', true],
    ['Revenue tripled under ApR 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled under ſep 2025.', '2025 年 9 月收入增至 3 倍。', true],
    ['Revenue tripled in Apr.2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled under release-Apr 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; file /Apr 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; identifier @Apr 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; file Apr 2025.pdf.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; path Apr 2025/data.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; version Apr 2025E.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled; label $ Apr 2025 and 5M.', '2025 年 4 月收入增至 3 倍，另有 $5M。', true],
    ['Revenue tripled; label GBP Apr 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['Revenue tripled in April 2025.', 'May 2025 收入增至 3 倍。', true],
    ['Revenue tripled in April 2025.', 'APR 2025 收入增至 3 倍。', true],
    ['Revenue tripled in April. 2025.', '2025 年 4 月收入增至 3 倍。', true],
    ['345 million transactions in Apr 2025.', '2025 年 4 月交易 3.45 亿笔。', true],
    ['$5M revenue in Apr 2025.', '2025 年 4 月收入 500 万美元。', true],
  ].flatMap(([en, zh, expected]) => ['prose', 'table', 'figure'].map(surface => {
    const wrap = value => surface === 'prose' ? fullReport(value)
      : surface === 'table' ? { ...fullReport(''), tables: [{ rows: [[value]] }] }
        : { ...fullReport(''), figures: [{ data: { nodes: [{ label: value }] } }] };
    return [
      checkPairQuality(wrap(en), wrap(zh), { strictEditor: true }).some(issue => issue.code === 'metric-preservation') === expected,
      `tripling month abbreviations retain dates, quantities and boundaries (${surface}): ${en} / ${zh}`,
    ];
  })),
  [
    checkPairQuality(
      fullReport('Reportedly, revenue tripled in Apr 2025; the result remains an unaudited estimate.'),
      fullReport('2025 年 4 月收入增至 3 倍；这一结果仍为未经审计的估算。'),
      { strictEditor: true },
    ).some(issue => issue.code === 'hedge-preservation'),
    'tripling month equivalence must not clear an omitted reported attribution',
  ],
  ...[
    ['Request top-10 ARR share and account-level expansion history.', '索取前 10 大客户 ARR 占比和账户级扩张历史。', false],
    ['Top-20 ARR, renewal dates, margin profile, and hyperscaler exposure', '前 20 大 ARR、续约日期、利润率画像和超大规模云厂商敞口', false],
    ['Request top 20 MRR concentration.', '索取前 20 大账户 MRR 集中度。', false],
    ['Request top-10 GMV share.', '索取前 10 品牌 GMV 份额。', false],
    ['Request top-10 TPV and revenue share.', '索取前 10 大客户 TPV 和收入占比。', false],
    ['Request top-10 ARR concentration.', '索取前 10 大 ARR 集中度。', false],
    ['No top-10 ARR share disclosed.', '未披露前 10 大客户 ARR 占比。', false],
    ['Request top-10 ARR share and top-5 MRR share.', '索取前 10 大客户 ARR 占比和前 5 大客户 MRR 占比。', false],
    ['Request top-10 ARR share and top-10 ARR concentration.', '索取前 10 大客户 ARR 占比及前 10 大客户 ARR 集中度。', false],
    ['Request top-10 ARR share in April 2025 and May 2026 for 42 accounts totaling $5M.', '索取 2025 年 4 月和 2026 年 5 月的前 10 大客户 ARR 占比，覆盖 42 个账户，合计 $5M。', false],
    ['Request top-9007199254740993 ARR share.', '索取前 9007199254740993 大客户 ARR 占比。', false],
    ['Request top-10 ARR share.', '索取前 20 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取前 10 大客户 MRR 占比。', true],
    ['Request top-10 ARR share.', '索取 10 个客户的 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取此前 10 个客户的 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取此前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取目前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取的不是前 10 大客户 ARR 占比。', true],
    ['Request not top-10 ARR share but a total.', '索取前 10 大客户 ARR 占比及总量。', true],
    ['Request top-10 ARR share and top-10 ARR concentration.', '索取前 10 大客户 ARR 占比及集中度。', true],
    ['Request top-10 ARR share and top-5 MRR share.', '索取前 5 大客户 ARR 占比及前 10 大客户 MRR 占比。', true],
    ['Request top-10 ARR share for 42 accounts.', '索取 41 个账户的前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share totaling $5M.', '索取前 10 大客户 ARR 占比，合计 $6M。', true],
    ['Request top-10 ARR share totaling $5M.', '索取前 10 大客户 ARR 占比，合计 €5M。', true],
    ['Request top-10 ARR share totaling USD $5M.', '索取前 10 大客户 ARR 占比，合计 CAD $5M。', true],
    ['Request top-10 ARR share totaling US$5M.', '索取前 10 大客户 ARR 占比，合计 AU$5M。', true],
    ['Request top-10 ARR share totaling $5M.', '索取前 10 大客户 ARR 占比，合计 $5M 加元。', true],
    ['Request top-10 ARR share totaling ₹5M.', '索取前 10 大客户 ARR 占比，合计 ₽5M。', true],
    ['Request top-10 ARR share totaling ₹5M.', '索取前 10 大客户 ARR 占比，合计 ₹5M。', true],
    ['Request top-10 ARR share across 5M to 10M users.', '索取前 10 大客户 ARR 占比，涉及 5M 和 10M 用户。', true],
    ['Request top-10 ARR share; growth is 50%+.', '索取前 10 大客户 ARR 占比；增速为 50%。', true],
    ['Request top-10 ARR share in April 2025.', '索取 2025 年 5 月的前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share in April 2025 and May 2026.', '索取 2025 年 5 月和 2026 年 4 月的前 10 大客户 ARR 占比。', true],
    ['Request top-9007199254740993 ARR share.', '索取前 9007199254740992 大客户 ARR 占比。', true],
    ['Request top-10 ARR share; cash flow was -$5M.', '索取前 10 大客户 ARR 占比；现金流为 $5M。', true],
    ['Request top-10 ARR share; cash flow was ($5M).', '索取前 10 大客户 ARR 占比；现金流为 $5M。', true],
    ['Request top-10 ARR share above 50%.', '索取前 10 大客户 ARR 占比 50%。', true],
    ['Request at least top-10 ARR share.', '索取前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取至少前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取约前 10 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取前 10 大客户 ARR 占比超过 50%。', true],
    ['Request top-10 and top-20 ARR share.', '索取前 10 和前 20 大客户 ARR 占比。', true],
    ['Request top-10 ARR share.', '索取前十大客户 ARR 占比。', true],
    ['Request top-01 ARR share.', '索取前 1 大客户 ARR 占比。', true],
    ['Request top-2.5 ARR share.', '索取前 2.5 大客户 ARR 占比。', true],
    ['Request top-10–20 ARR share.', '索取前 10–20 大客户 ARR 占比。', true],
    ['Request top-10 to 20 ARR share.', '索取前 10 到 20 大客户 ARR 占比。', true],
    ['The route is /top-10 ARR.', '索取前 10 大客户 ARR。', true],
    ['The file is top-10 ARR.csv.', '索取前 10 大客户 ARR。', true],
    ['There are 10 clients; request top-20 ARR share.', '客户为 1前20大ARR0。', true],
    ['Request top-10 ARR share across 5M users.', '用户为 5前10大ARRM。', true],
    ['Request top-10 ARR share totaling $5M.', '金额为 $前10大ARR5M。', true],
    ['Request top-10 ARR share across 5M users.', '用户为 5 前10大ARR M。', true],
    ['Request top-10 ARR share totaling $5M.', '金额为 $前10大ARR 5M。', true],
  ].flatMap(([en, zh, expected]) => ['prose', 'table', 'figure'].map(surface => {
    const wrap = value => surface === 'prose' ? fullReport(value)
      : surface === 'table' ? { ...fullReport(''), tables: [{ rows: [[value]] }] }
        : { ...fullReport(''), figures: [{ data: { nodes: [{ label: value }] } }] };
    return [
      checkPairQuality(wrap(en), wrap(zh), { strictEditor: true }).some(issue => issue.code === 'metric-preservation') === expected,
      `ranked financial labels retain rank, metric identity and other quantities (${surface}): ${en} / ${zh}`,
    ];
  })),
  [
    checkPairQuality(
      fullReport('Reportedly, top-10 ARR concentration remains an estimate rather than an audited result.'),
      fullReport('前 10 大客户 ARR 集中度仍是估算，尚非审计结果。'),
      { strictEditor: true },
    ).some(issue => issue.code === 'hedge-preservation'),
    'ranked-label normalization must not clear a separate omitted attribution',
  ],
  ...[
    ['The credit gap is £65 billion.', '信贷缺口为 £65bn。', false],
    ['The credit gap is £65bn.', '信贷缺口为 £65B。', false],
    ['Revenue is €1.25 billion and funding is $2 billion.', '收入为 €1.25bn，融资为 $2bn。', false],
    ['The amount is £1,500 billion.', '金额为 £1500bn。', false],
    ['The amount is £9007199254740993 billion.', '金额为 £9007199254740993bn。', false],
    ['The amount is £9007199254740993 billion.', '金额为 £9007199254740992bn。', true],
    ['Revenue was £65 billion in April 2025.', '2025 年 4 月收入为 £65bn。', false],
    ['The two markets each represent £65 billion, including 5 clients.', '两个市场分别为 £65bn，各含 5 个客户。', false],
    ['Revenue is £65bn.', '收入为 £65。', true],
    ['Revenue is £65bn.', '收入为 £65M。', true],
    ['Revenue is £65bn.', '收入为 €65B。', true],
    ['Revenue is £65 billion.', '收入为 £66bn。', true],
    ['Revenue is £65 billion.', '收入为 £65bn2。', true],
    ['Revenue is £65 billion.', '收入为 £65bn.5。', true],
    ['Revenue is £65 billion.', '收入为 £65bna。', true],
    ['Revenue is £650bn.', '收入为 £65,0B。', true],
    ['Revenue is £650 billion.', '收入为 £65,0bn。', true],
    ['Revenue is £65 billion.', '收入为 £65bps。', true],
    ['Revenue is £65bn and funding is £65bn.', '收入与融资为 £65B。', true],
    ['The market is £65 billion, including 5 clients.', '市场为 £65bn，含 6 个客户。', true],
    ['Revenue was £65 billion in April 2025.', '2025 年 5 月收入为 £65bn。', true],
    ['Revenue was £65 billion in April 2025 and £66 billion in May 2026.', '2025 年 5 月收入为 £65bn，2026 年 4 月收入为 £66bn。', true],
    ['Losses are -£65bn.', '亏损为 -£65B。', true],
    ['Revenue is £65bn.', '收入为 -£65B。', true],
    ['Revenue is -£65B.', '收入为 £65bn。', true],
    ['Losses are (£65bn).', '亏损为（£65B）。', true],
    ['Revenue ranges from £1bn to £2bn.', '收入区间为 £1B 至 £2B。', true],
    ['Revenue ranges from £1bn–£2bn.', '收入区间为 £1B–£2B。', true],
    ['Revenue is £65bn+.', '收入为 £65B。', true],
    ['Revenue is >£65bn.', '收入为 £65B。', true],
    ['Revenue is approximately £65 billion.', '收入约为 £65bn。', true],
    ['Funding is CAD $65bn.', '融资为 USD $65B。', true],
    ['Funding is US$65B.', '融资为 AU$65bn。', true],
    ['Funding is $65 billion.', '融资为 $65bn 加元。', true],
    ['There are 1.5 million accounts.', '共有 1.5 百万账户。', false],
    ['There are 1.5 million accounts and a £500k threshold.', '共有 1.5 百万账户，门槛为 £500k。', false],
    ['There are 1.5 million accounts and 5 clients.', '共有 1.5 百万账户和 5 个客户。', false],
    ['There are 1.5 million accounts.', '共有 1.6 百万账户。', true],
    ['There are 1.5 million accounts and 5 clients.', '共有 1.5 百万账户和 6 个客户。', true],
    ['There are -1.5 million accounts.', '共有 -1.5 百万账户。', true],
    ['Revenue is £1.5 million.', '收入为 1.5 百万英镑。', true],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table', 'figure'].map(surface => {
    const wrap = value => surface === 'prose' ? fullReport(value)
      : surface === 'table' ? { ...fullReport(''), tables: [{ rows: [[value]] }] }
        : { ...fullReport(''), figures: [{ data: { nodes: [{ label: value }] } }] };
    return [
      checkPairQuality(wrap(en), wrap(zh), { strictEditor })
        .some(issue => issue.code === 'metric-preservation') === (strictEditor && expected),
      `bounded currency-billion aliases and million counts (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
    ];
  }))),
  ...[
    ['Company campaign claim; independent verification not available in public sources', '公司活动口径；公开来源无法独立验证', false],
    ['Company campaign claim; independent verification not available in public sources', '公司活动口径；公开来源无法独立验证。这是尽调观察。', false],
    ['Company campaign claim; independent verification not available in public sources', '并非公司活动口径；公开来源无法独立验证', true],
    ['Company campaign claim; independent verification not available in public sources', '这不是公司活动口径；公开来源无法独立验证', true],
    ['Company campaign claim; independent verification not available in public sources', '活动表现很好；公开来源无法独立验证', true],
    ['Independent campaign claim; independent verification not available in public sources', '公司活动口径；公开来源无法独立验证', true],
    ['Company campaign claim; the company claims every account is active and profitable.', '公司活动口径；所有账户都活跃且盈利。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `campaign attribution stays source-scoped (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Gross profit', '毛利率', true],
    ['Gross profit', '毛利润率', true],
    ['Gross profit', '毛利', false],
    ['Gross profit', '毛利润', false],
    ['Gross profit', '毛利额', false],
    ['Revenue model bridge and missing gross-profit inputs', '收入模型链路与缺失的毛利率输入项', true],
    ['Public evidence supports the operating sequence, but the conversion from activity to recognized revenue and gross profit is not disclosed.', '公开证据支持这条运营链路，但未披露业务活动如何转化为确认收入和毛利率。', true],
    ['Public evidence supports the operating sequence, but the conversion from activity to recognized revenue and gross profit is not disclosed.', '公开证据支持这条运营链路，但未披露业务活动如何转化为确认收入和毛利。', false],
    ['Gross profit and gross margin', '毛利和毛利率', false],
    ['Gross profit margin', '毛利率', false],
    ['Gross profit after risk margin', '扣除风险成本后的毛利率', false],
    ['Gross profit after risk', '扣除风险成本后的毛利率', true],
    ['Gross profit after risk; margin remains undisclosed', '扣除风险成本后的毛利率；利润率仍未披露', true],
    ['Gross profit after risk margin and gross profit', '扣除风险成本后的毛利率', true],
    ['Gross margin', '毛利率', false],
    ['Gross profit divided by revenue', '毛利率', false],
    ['The ratio of gross profit to revenue', '毛利率', false],
    ['Gross profit / revenue', '毛利率', false],
    ['Gross profit is 40% of revenue', '毛利率为 40%', false],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table', 'figure'].map(surface => {
    const wrap = value => surface === 'prose' ? fullReport(value)
      : surface === 'table' ? { ...fullReport(''), tables: [{ rows: [[value]] }] }
        : { ...fullReport(''), figures: [{ data: { nodes: [{ label: value }] } }] };
    return [
      checkPairQuality(wrap(en), wrap(zh), { strictEditor })
        .some(issue => issue.code === 'metric-head-preservation') === (strictEditor && expected),
      `gross-profit amounts remain distinct from margins in strict editing (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
    ];
  }))),
  ...[
    ['Leverage excluding claims on central banks is disclosed.', '剔除对央行债权口径的杠杆率已披露。', false],
    ['Leverage excluding central-bank claims is disclosed.', '剔除对央行债权口径的杠杆率已披露。', false],
    ['The central bank claims that the lender faces no capital constraint.', '该贷款机构不存在资本约束。', true],
    ['The central bank claims that the lender faces no capital constraint.', '央行声称该贷款机构不存在资本约束。', false],
    ['Leverage excluding claims on central banks is disclosed; the company claims it faces no capital constraint.', '剔除对央行债权口径的杠杆率已披露；公司不存在资本约束。', true],
    ['Leverage excluding claims on central banks is disclosed; the company claims it faces no capital constraint.', '剔除对央行债权口径的杠杆率已披露；公司声称不存在资本约束。', false],
    ['Leverage excluding central-bank claims is disclosed and the company claims it faces no capital constraint.', '剔除对央行债权口径的杠杆率已披露，公司不存在资本约束。', true],
    ['Leverage excluding central-bank claims is disclosed and the company claims it faces no capital constraint.', '剔除对央行债权口径的杠杆率已披露，公司声称不存在资本约束。', false],
    ['The financing does not establish continuity of historical shareholder claims.', '融资不能证明历史股东权益延续。', false],
    ['The financing does not establish continuity of shareholder claims.', '融资不能证明股东权益延续。', false],
    ['The shareholder claims that every investor receives a guaranteed return.', '每位投资者都能获得保证回报。', true],
    ['The shareholder claims that every investor receives a guaranteed return.', '股东声称每位投资者都能获得保证回报。', false],
    ['The financing does not establish continuity of historical shareholder claims; the company claims every investor earns a guaranteed return.', '融资不能证明历史股东权益延续；每位投资者都能获得保证回报。', true],
    ['The financing does not establish continuity of historical shareholder claims; the company claims every investor earns a guaranteed return.', '融资不能证明历史股东权益延续；公司声称每位投资者都能获得保证回报。', false],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table'].map(surface => [
    checkPairQuality(
      surface === 'prose' ? fullReport(en) : { ...fullReport(''), tables: [{ rows: [[en]] }] },
      surface === 'prose' ? fullReport(zh) : { ...fullReport(''), tables: [{ rows: [[zh]] }] },
      { strictEditor },
    ).some(issue => issue.code === 'hedge-preservation') === expected,
    `financial claims nouns do not exempt a separate assertion (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
  ]))),
  ...[
    [
      'This analysis uses an inference-led market lens, not a claim that Groq currently offers only inference.',
      '本分析以推理业务为主线，但并不表明 Groq 目前仅提供推理服务。',
      [
        'Groq 目前仅提供推理服务。',
        '并非不代表 Groq 目前仅提供推理服务。',
        '不代表 Groq 目前仅提供训练服务。',
        '不代表其他公司的业务；Groq 目前仅提供推理服务。',
      ],
    ],
    [
      'The ordering is an analytical dependency map, not a claim that every Groq workload traverses both LPU and NVIDIA hardware.',
      '该排序是分析性的依赖关系图，不代表 Groq 的每种工作负载都会同时经过 LPU 和 NVIDIA 硬件。',
      [
        '该排序表明 Groq 的每种工作负载都会同时经过 LPU 和 NVIDIA 硬件。',
        '并非不代表 Groq 的每种工作负载都会同时经过 LPU 和 NVIDIA 硬件。',
        '不代表 Groq 的每种工作负载都会同时经过 LPU 和 CPU 硬件。',
        '不代表其他公司的架构；Groq 的每种工作负载都会同时经过 LPU 和 NVIDIA 硬件。',
      ],
    ],
    [
      'No claim of fairness, post-money basis, investor returns or confirmed cash availability is established by the financing mark.',
      '融资估值本身不能证明定价公允、投后口径、投资者回报或现金确实可用。',
      [
        '融资估值本身能证明定价公允、投后口径、投资者回报或现金确实可用。',
        '并非融资估值本身不能证明定价公允、投后口径、投资者回报或现金确实可用。',
        '收入规模本身不能证明定价公允、投后口径、投资者回报或现金确实可用。',
        '融资估值本身不能证明定价公允、投后口径、投资者回报或现金已确认到账。',
        '融资估值本身不能证明定价公允、投后口径或现金确实可用。',
      ],
    ],
  ].flatMap(([en, faithful, unsafe]) => [
    [en, faithful, false],
    ...unsafe.map(zh => [en, zh, true]),
    [`${en} The company claims every customer renews.`, `${faithful} 每个客户都续约。`, true],
    [`${en} The company claims every customer renews.`, `${faithful} 公司声称每个客户都续约。`, false],
    ['The company claims every customer renews. This assertion requires independent customer-cohort evidence.', faithful, true],
  ].flatMap(([source, target, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table'].map(surface => [
    checkPairQuality(
      surface === 'prose' ? fullReport(source) : { ...fullReport(''), tables: [{ rows: [[source]] }] },
      surface === 'prose' ? fullReport(target) : { ...fullReport(''), tables: [{ rows: [[target]] }] },
      { strictEditor },
    ).some(issue => issue.code === 'hedge-preservation') === expected,
    `scoped inference, hardware and financing disclaimers preserve predicates and separate assertions (${surface}, strict=${strictEditor}): ${source} / ${target}`,
  ])))),
  ...[
    ['Comparable copyright claims impose cost.', '类似版权索赔带来成本。'],
    ['The copyright claim resolved against the company.', '版权索赔以不利于公司的结果解决。'],
    ['Review copyright litigation and any similar claims.', '审阅版权诉讼及任何类似索赔。'],
    ['False YouTube claims, wrongful uploads, contract inducement.', '虚假 YouTube 认领、错误上传、合同诱导。'],
    ['Wrongful / duplicate YouTube claims from bad metadata or split errors.', '元数据或分账错误导致错误或重复的 YouTube 认领。'],
    ['Confirm docket status, claims surviving, and reserves.', '确认案卷状态、仍存续的诉请及准备金。'],
    ['Request the claim-review process.', '索取索赔审核流程。'],
    ['Litigation requires disciplined claim governance.', '诉讼要求严格管理索赔。'],
    ['Require a claim-governance overhaul.', '要求全面改进索赔治理。'],
    ['A settlement in a rights-claim case.', '权利索赔案件的和解。'],
    ['Fingerprint assets; claim and monetize UGC.', '为资产生成指纹；认领 UGC 并变现。'],
  ].flatMap(([en, zh]) => [
    [en, zh, false],
    [`${en} The company claims its system never makes errors.`, `${zh} 系统从不出错。`, true],
    [`${en} The company claims its system never makes errors.`, `${zh} 公司声称系统从不出错。`, false],
  ]).concat([
    ['YouTube claims its system never makes errors.', 'YouTube 的系统从不出错。', true],
    ['The company claims governance is flawless.', '治理毫无问题。', true],
    ['The company claims review takes one day.', '审核只需一天。', true],
    ['The company claims it can monetize UGC perfectly.', '公司能完美变现 UGC。', true],
    ['The company claims copyright protection is universal.', '版权保护适用于所有内容。', true],
  ]).flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table'].map(surface => [
    checkPairQuality(
      surface === 'prose' ? fullReport(`${en} This is a source-reviewed diligence observation.`) : { ...fullReport(''), tables: [{ rows: [[`${en} This is a source-reviewed diligence observation.`]] }] },
      surface === 'prose' ? fullReport(zh) : { ...fullReport(''), tables: [{ rows: [[zh]] }] },
      { strictEditor },
    ).some(issue => issue.code === 'hedge-preservation') === expected,
    `copyright and rights-workflow nouns must not exempt a separate assertion (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
  ]))),
  ...[
    ['Request claims frequency, hub replacement rates, and reserve methodology.', '索取索赔频率、Hub 更换率和准备金方法。', false],
    ['Request claim frequency.', '索取理赔频率。', false],
    ['The company claims frequency is low.', '频率很低。', true],
    ['Request claims frequency; the company claims every device lasts forever.', '索取理赔频率；每台设备都能永久使用。', true],
    ['Request claims frequency; the company claims every device lasts forever.', '索取理赔频率；公司声称每台设备都能永久使用。', false],
    ['Request annual churn and warranty-claim rate.', '索取年度流失率和保修索赔率。', false],
    ['Review warranty-claims history.', '审阅保修索赔历史。', false],
    ['The warranty claim proves every device lasts forever.', '每台设备都能永久使用。', true],
    ['Review warranty-claim rate; the company claims every device lasts forever.', '审阅保修索赔率；每台设备都能永久使用。', true],
    ['Review warranty-claim rate; the company claims every device lasts forever.', '审阅保修索赔率；公司声称每台设备都能永久使用。', false],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '未按细分披露公开收入、用户数或复购情况。', false],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '已按细分披露公开收入、用户数或复购情况。', true],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '并非未按细分披露公开收入、用户数或复购情况。', true],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '未按细分披露公开收入、用户数或复购情况的判断不成立。', true],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '未按期披露公开收入、用户数或复购情况。', true],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment.', '未按细分准备数据；公开收入、用户数和复购情况均已披露。', true],
    ['No public revenue, user-count, or repeat-purchase disclosure by segment; no public IPO milestone.', '未按细分披露公开收入、用户数或复购情况；IPO 时间已公布。', true],
    ['No public IPO milestone.', '未按细分披露公开收入、用户数或复购情况。', true],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['prose', 'table'].map(surface => [
    checkPairQuality(
      surface === 'prose' ? fullReport(`${en} This is a source-reviewed diligence observation.`) : { ...fullReport(''), tables: [{ rows: [[`${en} This is a source-reviewed diligence observation.`]] }] },
      surface === 'prose' ? fullReport(zh) : { ...fullReport(''), tables: [{ rows: [[zh]] }] },
      { strictEditor },
    )
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `warranty-frequency requests and scoped segment disclosures retain their meanings (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
  ]))),
  ...[
    ['No single public issue is a clear thesis-breaker today, but privacy consent controls and claims-reduction proof must be verified before underwriting aggressive growth. The report treats unsupported private metrics as diligence asks, not as assumed strengths.',
      '当前尚无单一公开问题足以彻底推翻投资逻辑，但在将激进增长计入投资判断前，必须先核查隐私知情同意管控与理赔压降证据。本报告将缺乏支撑的未公开指标视为尽调问询项，而非预设为既有优势。', false],
    ['Claims-reduction proof must be verified.', '必须核查理赔减少的证据。', false],
    ['Reduced claims, safer driving, and better operations feed renewal', '理赔减少、驾驶更安全、运营更好，反过来推动续约', false],
    ['The company claims reductions exceed 25%.', '减少幅度超过 25%。', true],
    ['The company claims reduced costs.', '成本有所降低。', true],
    ['The company claims a reduction in claims.', '理赔有所减少。', true],
    ['Claims-reduction proof is required; the company claims every fleet benefits.', '需要理赔减少的证据；所有车队均能受益。', true],
    ['Claims-reduction proof is required; the company claims every fleet benefits.', '需要理赔减少的证据；公司声称所有车队均能受益。', false],
    ['Reduced claims, safer driving, and better operations feed renewal; the company claims it guarantees renewal.', '理赔减少、驾驶更安全、运营更好，推动续约；续约有保证。', true],
    ['Reduced claims, safer driving, and better operations feed renewal; the company claims it guarantees renewal.', '理赔减少、驾驶更安全、运营更好，推动续约；公司声称续约有保证。', false],
    ['The company claims reduced claims, safer driving, and better operations feed renewal.', '理赔减少、驾驶更安全、运营更好，推动续约。', true],
    ['The company claims reduced claims, safer driving, and better operations feed renewal.', '公司声称，理赔减少、驾驶更安全、运营更好，推动续约。', false],
    ['Reduced claims its customer outcomes are proven.', 'Reduced 的客户成效已经得到验证。', true],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['callout', 'table', 'figure'].map(surface => {
    const document = text => ({
      ...fullReport(''),
      ...(surface === 'callout' ? { chapters: [{ sections: [{ blocks: [{ type: 'callout', body: text }] }] }] }
        : surface === 'table' ? { tables: [{ rows: [[text]] }] }
          : { figures: [{ type: 'flow', data: { nodes: [{ id: 'n1', detail: text }] } }] }),
    });
    return [
      checkPairQuality(document(`${en} This is a source-reviewed diligence observation.`), document(zh), { strictEditor })
        .some(issue => issue.code === 'hedge-preservation') === expected,
      `claims-reduction nouns must not erase assertion verbs (${surface}, strict=${strictEditor}): ${en} / ${zh}`,
    ];
  }))),
  ...[
    ['Dismissed with prejudice.', '有偏见驳回。', true],
    ['Voluntary dismissal with prejudice.', '自愿带偏见撤诉。', true],
    ['The case was dismissed with prejudice by stipulated order.', '案件依双方约定有偏见地驳回。', true],
    ['The court dismissed non-competition and non-solicitation claims against an advisor with prejudice.', '法院有偏见地驳回了针对顾问的诉讼请求。', true],
    ['With-prejudice dismissal.', '有偏见的驳回。', true],
    ['The case was withdrawn with prejudice.', '案件以带偏见撤诉终结。', true],
    ['Dismissed with prejudice.', '案件被驳回，同一请求不得再诉。', false],
    ['Dismissed with prejudice.', '以不得再诉方式驳回。', false],
    ['Voluntary dismissal with prejudice.', '不可再诉的自愿撤诉。', false],
    ['Dismissed with prejudice by stipulated order.', '法院依双方约定驳回，同一请求不得再诉。', false],
    ['Dismissed with prejudice.', '案件带既判力驳回。', false],
    ['Dismissed with prejudice.', '案件终局驳回。', false],
    ['The case was dismissed with prejudice. Clinical trials remain vulnerable to sponsor bias.', '案件有偏见驳回。临床试验仍容易受到赞助方偏差影响。', true],
    ['The case was dismissed with prejudice. Clinical trials remain vulnerable to sponsor bias.', '案件被驳回，同一请求不得再诉。临床试验仍容易受到赞助方偏差影响。', false],
    ['Dismissed without prejudice.', '案件被驳回，但不影响再诉。', false],
    ['Dismissed with prejudice; new claims on different grounds remain possible.', '同一请求不得再诉，但仍可能基于不同理由提出新请求。', false],
    ['Dismissed with prejudice.', '同一请求不得再诉，并非有偏见地驳回。', false],
    ['Dismissed with prejudice.', '同一请求不得再诉，不是「带偏见撤诉」。', false],
    ['Dismissed with prejudice.', '这一术语不等于有偏见驳回。', false],
    ['Dismissed with prejudice.', '这一术语并不意味着“有偏见驳回”。', false],
    ['Dismissed with prejudice.', '案件并非不是有偏见驳回。', true],
    ['Dismissed with prejudice.', '案件并非 不是「有偏见驳回」。', true],
    ['The first case was dismissed with prejudice; the second was also dismissed with prejudice.', '第一案并非有偏见驳回，同一请求不得再诉；第二案有偏见驳回。', true],
    ['The court was biased when it dismissed the case with prejudice.', '法院有偏见地驳回案件，同一请求不得再诉。', false],
    ['The court unfairly dismissed the case with prejudice.', '法院有偏见地驳回案件，同一请求不得再诉。', false],
    ['The case was dismissed with prejudice. The judge was biased.', '法官有偏见地驳回案件，同一请求不得再诉。', false],
    ['The judge was biased. The case was dismissed with prejudice.', '法官有偏见地驳回案件，同一请求不得再诉。', false],
    ['The case was dismissed with prejudice. The court was accused of unfair treatment.', '法院遭指控有偏见地驳回案件，同一请求不得再诉。', false],
    ['The judgment found discriminatory treatment before dismissal with prejudice.', '判决认定此前存在歧视，随后作出有偏见的驳回。', false],
    ['The court dismissed the case because the judge was biased.', '法院有偏见地驳回案件。', false],
  ].flatMap(([en, zh, expected]) => [false, true].flatMap(strictEditor => ['subtitle', 'table'].map(surface => {
    const source = surface === 'subtitle' ? fullReport(en) : { ...fullReport(''), tables: [{ rows: [[en]] }] };
    const target = surface === 'subtitle' ? fullReport(zh) : { ...fullReport(''), tables: [{ rows: [[zh]] }] };
    return [
      checkPairQuality(source, target, { strictEditor }).some(issue => issue.code === 'legal-terminology') === expected,
      `literal legal-bias guard distinguishes refiling restrictions and explicit bias discussion (strict=${strictEditor}, surface=${surface}): ${en} / ${zh}`,
    ];
  }))),
  ...[
    ['Customer validates fabric claim in gym, yoga studio, or daily life.', '客户在健身房、瑜伽馆或日常生活中验证面料承诺。', false],
    ['The customer validates the fabric claim in daily life.', '客户在日常生活中验证面料承诺。', false],
    ['Customer validates fabric claim in daily life.', '客户在日常生活中使用面料。', true],
    ['Customer validates fabric claim in daily life.', '并非客户在日常生活中验证面料承诺。', true],
    ['Customer validates fabric claim in daily life.', '客户在日常生活中没有验证面料承诺。', true],
    ['Customer validates fabric claim in daily life.', '客户在日常生活中验证面料承诺的判断不成立。', true],
    ['Customer validates fabric claim in daily life.', '客户在日常生活中运动；其他人验证面料承诺。', true],
    ['The company claims its fabric lasts longer.', '客户在日常生活中验证面料承诺。', true],
    ['Customer validates fabric claim in daily life; the company claims every customer renews.', '客户在日常生活中验证面料承诺；每个客户都续约。', true],
    ['Customer validates fabric claim in daily life; the company claims every customer renews.', '客户在日常生活中验证面料承诺；公司声称每个客户都续约。', false],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `customer testing of a fabric promise remains distinct from an unattributed assertion (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['客户通过从大型券商和经纪交易商转来的 W-2 顾问触达。', false],
    ['公司通过转来的顾问连接客户。', false],
    ['公司通过来自券商的顾问连接客户。', false],
    ['公司通过资本周转来改善现金流。', true],
    ['公司通过资产流转来减少占用。', true],
    ['公司通过转来的顾问来获取客户。', true],
    ['公司通过从券商转来的顾问连接客户；团队通过服务来吸引客户。', true],
    ['公司通过转来的顾问连接客户；其他团队通过资金周转来改善现金流。', true],
    ['公司通过顾问带来客户。', false],
  ].flatMap(([zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport('The advisor network and capital turnover support the business.'), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'translationese') === expected,
    `purpose-marker soundcheck retains genuine turnover constructions but not the modifier 转来的 (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Goldman filed arbitration claims against departing advisors.', 'Goldman 对离职顾问提出仲裁请求。', false],
    ['Goldman Sachs arbitration claims against advisor recruits.', 'Goldman Sachs 对被招募顾问提出仲裁请求。', false],
    ['Goldman filed an arbitration claim against an advisor.', 'Goldman 对一名顾问提出仲裁请求。', false],
    ['The court dismissed non-competition and non-solicitation claims against an advisor.', '法院驳回了针对顾问的竞业限制和禁止招揽诉讼请求。', false],
    ['The court dismissed non-competition and non-solicitation claims against an advisor; the company claims all clients stayed.', '法院驳回了针对顾问的竞业限制和禁止招揽诉讼请求；所有客户都留了下来。', true],
    ['The court dismissed non-competition and non-solicitation claims against an advisor; the company claims all clients stayed.', '法院驳回了针对顾问的竞业限制和禁止招揽诉讼请求；公司声称所有客户都留了下来。', false],
    ['The company claims non-competition agreements remain enforceable.', '竞业限制协议仍可执行。', true],
    ['Goldman filed arbitration claims against departing advisors; the company claims all clients stayed.', 'Goldman 对离职顾问提出仲裁请求；所有客户都留了下来。', true],
    ['Goldman filed arbitration claims against departing advisors; the company claims all clients stayed.', 'Goldman 对离职顾问提出仲裁请求；公司声称所有客户都留了下来。', false],
    ['The arbitration provider claims all clients stayed.', '仲裁服务商的所有客户都留了下来。', true],
    ['The arbitration provider claims, without evidence, all clients stayed.', '仲裁服务商的所有客户都留了下来。', true],
    ['AI governance is weak at most RIAs.', '多数 RIA 的 AI 治理薄弱。', false],
    ['AI governance is weak at most RIAs; at most 35% have formal policies.', '多数 RIA 的 AI 治理薄弱；35% 有正式政策。', true],
    ['AI governance is weak at most RIAs; at most 35% have formal policies.', '多数 RIA 的 AI 治理薄弱；最多 35% 有正式政策。', false],
    ['At most 35% of RIAs have formal policies.', '35% 的 RIA 有正式政策。', true],
    ['At most 35% of RIAs have formal policies.', '不超过 35% 的 RIA 有正式政策。', false],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `arbitration demands and majority locations remain distinct from assertions and caps (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['The champion at most confirmed sites is a physician.', '多数已确认站点的推动者是医生。', false],
    ['The champion at most confirmed sites is a physician; at most two sites have contracts.', '多数已确认站点的推动者是医生；两个站点有合同。', true],
    ['The champion at most confirmed sites is a physician; at most two sites have contracts.', '多数已确认站点的推动者是医生；最多两个站点有合同。', false],
    ['The company has at most 20 confirmed sites.', '公司有 20 个已确认站点。', true],
    ['The company has at most 20 confirmed sites.', '公司最多有 20 个已确认站点。', false],
    ['Payer denials documented in >20% of claims.', '>20% 的理赔有支付方拒付记录。', false],
    ['Major payer denials are documented in 20.5% of claims.', '20.5% 的理赔有主要支付方拒付记录。', false],
    ['Payer denials documented in >20% of claims; the company claims every appeal succeeds.', '>20% 的理赔有支付方拒付记录；每次申诉均成功。', true],
    ['Payer denials documented in >20% of claims; the company claims every appeal succeeds.', '>20% 的理赔有支付方拒付记录；公司声称每次申诉均成功。', false],
    ['The company claims payer denials affect >20% of requests.', '支付方拒付影响 >20% 的请求。', true],
    ['The insurer claims, without evidence, all appeals succeed.', '保险公司的所有申诉均成功。', true],
    ['No public data on installed base or market share.', '没有关于装机量或市场份额的公开数据。', false],
    ['No public data on installed base or market share.', '未见关于装机量或市场份额的公开数据。', false],
    ['No public data on installed base.', '已有关于装机量的公开数据。', true],
    ['No public data on installed base.', '并非没有关于装机量的公开数据。', true],
    ['No public data on installed base.', '不是 未见关于装机量的公开数据。', true],
    ['No public data on installed base.', '没有关于装机量的公开数据的判断不成立。', true],
    ['No public data on installed base.', '没有关于装机量的内部信息；装机量的公开数据可查。', true],
    ['No public data on installed base; no public revenue disclosure.', '没有关于装机量的公开数据；收入已披露。', true],
    ['No public milestone is disclosed.', '没有关于装机量的公开数据。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `majority locations, payer-denial nouns and scoped public-data gaps retain their predicates (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['No public source reviewed confirms the financing round.', '已审阅公开来源均未确认该轮融资。', false],
    ['No public source in the research corpus - including Alpha and Beta - confirms the financing round.', '但研究语料中的公开来源——包括 Alpha、Beta——都没有确认该轮融资。', false],
    ['No public source reviewed confirms the financing round.', '已审阅公开来源均已确认该轮融资。', true],
    ['No public source reviewed confirms the financing round.', '并非已审阅公开来源均未确认该轮融资。', true],
    ['No public source reviewed confirms the financing round.', '不是 已审阅公开来源均未确认该轮融资。', true],
    ['No public source reviewed confirms the financing round.', '已审阅公开来源均未确认该轮融资的判断不成立。', true],
    ['No public source reviewed confirms the financing round.', '已审阅公开来源均未找到文件；其他机构确认了融资。', true],
    ['No public source reviewed confirms the financing round; no public revenue data exists.', '已审阅公开来源均未确认该轮融资；收入已披露。', true],
    ['No public revenue data exists.', '已审阅公开来源均未确认该轮融资。', true],
    ['No public benchmark by file size, archive depth, or false-positive rate.', '未按文件大小、压缩包深度或误报率公开基准。', false],
    ['No public benchmark by file size.', '已按文件大小公开基准。', true],
    ['No public benchmark by file size.', '并非未按文件大小公开基准。', true],
    ['No public benchmark by file size.', '并非尚未按文件大小公开基准。', true],
    ['No public benchmark by file size.', '未按文件大小公开基准的判断不成立。', true],
    ['No public benchmark by file size.', '未按期公开基准。', true],
    ['No public benchmark by file size.', '未按时公开基准。', true],
    ['No public benchmark by file size.', '未按计划公开基准。', true],
    ['No public benchmark by file size.', '未按文件大小提供数据；基准已公开。', true],
    ['No public benchmark by file size; no public revenue data exists.', '未按文件大小公开基准；收入已披露。', true],
    ['No public revenue data exists.', '未按文件大小公开基准。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '这是运营模型，并不是说每个客户都严格按同一采购顺序推进。', false],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '这不代表每个客户都按同一采购顺序进行。', false],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '每个客户都严格按同一采购顺序推进。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '公司声称每个客户都严格按同一采购顺序推进。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '并非不代表每个客户都严格按同一采购顺序推进。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '并非并不是说每个客户都严格按同一采购顺序推进。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '并不是说每个客户都严格按同一采购顺序推进的判断不成立。', true],
    ['This is an operating model, not a claim that every customer follows the exact same procurement sequence.', '并不是说每个客户都采用同一产品；采购顺序相同。', true],
    ['This is not a claim that every customer follows the exact same procurement sequence; the company claims every customer renews.', '并不是说每个客户都严格按同一采购顺序推进；每个客户都会续约。', true],
    ['This is not a claim that every customer follows the exact same procurement sequence; the company claims every customer renews.', '并不是说每个客户都严格按同一采购顺序推进；公司声称每个客户都会续约。', false],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `source confirmation, segmented benchmarks and procurement disclaimers retain their predicates (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['This is a valuation view, not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '这是估值判断，而不是公司已经凭披露基本面赚到公开市场软件倍数。', false],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '并不代表公司已经凭借披露的基本面获得上市软件企业的估值倍数。', false],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '不代表该公司已经凭已披露的基本面获得了上市软件公司的估值倍数。', false],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '公司已经凭披露基本面赚到公开市场软件倍数。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '公司声称已经凭披露基本面赚到公开市场软件倍数。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '并非不代表公司已经凭披露基本面赚到公开市场软件倍数。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '不是 而不是公司已经凭披露基本面赚到公开市场软件倍数。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '而不是公司已经凭披露基本面赚到公开市场软件倍数的判断不成立。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '而不是公司已经凭营销材料赚到公开市场软件倍数。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals.', '而不是公司已经凭披露基本面赚到利润；公开市场软件倍数已经实现。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals; the company claims its revenue doubled.', '而不是公司已经凭披露基本面赚到公开市场软件倍数；收入翻倍。', true],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals; the company claims its revenue doubled.', '而不是公司已经凭披露基本面赚到公开市场软件倍数；公司声称收入翻倍。', false],
    ['This is not a claim that the company has already earned public-market software multiples on disclosed fundamentals; no public ARR is disclosed.', '而不是公司已经凭披露基本面赚到公开市场软件倍数；ARR 已披露。', true],
    ['The company claims it has already earned public-market software multiples on disclosed fundamentals.', '公司已经凭披露基本面赚到公开市场软件倍数。', true],
    ['The company claims it has already earned public-market software multiples on disclosed fundamentals.', '公司声称已经凭披露基本面赚到公开市场软件倍数。', false],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `valuation disclaimers retain negation, fundamentals and separate assertions (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['供应链集中在印度合同制造，一方面缓释风险，另一方面增加执行难度。', false],
    ['产能集中在印度制造：一方面缓释风险，另一方面增加执行难度。', false],
    ['产能集中在印度制造, 一方面缓释风险。', false],
    ['产能集中在印度制造: 一方面缓释风险。', false],
    ['团队在供应链方面仍有困难。', true],
    ['团队在成本、质量方面仍有困难。', true],
    ['团队在 API, SDK 方面仍有困难。', true],
    ['团队在成本，质量方面仍有困难。', true],
    ['团队在某一方面仍有困难。', true],
    ['团队在供应链方面仍有困难，其他工作进展顺利。', true],
    ['产能集中在印度制造，一方面缓释风险；团队在质量方面仍有困难。', true],
    ['卖方在买方面前展示产品。', false],
  ].flatMap(([zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport('The supply chain creates a geographic tradeoff and requires careful execution.'), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'translationese') === expected,
    `aspect soundcheck distinguishes clause-leading comparisons from aspect phrases (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The venue is plaintiff-friendly for non-practicing entity (NPE) claims.', '该管辖区有利于非实施实体（NPE）的诉讼请求。', false],
    ['The court handles NPE claims.', '法院处理 NPE 诉讼请求。', false],
    ['The NPE claims the device infringes its patents.', '该设备侵犯其专利。', true],
    ['The NPE claims, without evidence, that its software cannot infringe any patent.', '该软件不可能侵犯任何专利。', true],
    ['The NPE claims, without evidence, that its software cannot infringe any patent.', '该 NPE 声称软件不可能侵犯任何专利，但没有提供证据。', false],
    ['The venue handles NPE claims; the NPE claims, without evidence, that its software cannot infringe any patent.', '该管辖区处理 NPE 诉讼；该软件不可能侵犯任何专利。', true],
    ['The venue handles NPE claims; the company claims all patents are valid.', '该管辖区处理 NPE 诉讼；所有专利均有效。', true],
    ['The venue handles NPE claims; the company claims all patents are valid.', '该管辖区处理 NPE 诉讼；公司声称所有专利均有效。', false],
    ["CourtListener's 15 cases / 78 docket entries suggest additional claims may follow.", 'CourtListener 的 15 起案件 / 78 条案卷记录提示，后续可能出现更多诉讼请求。', false],
    ['CourtListener’s 15 cases / 78 docket entries suggest additional claims may follow.', 'CourtListener 的 15 起案件 / 78 条案卷记录提示，后续可能出现更多诉讼请求。', false],
    ["CourtListener's 15 cases / 78 docket entries suggest additional claims may follow; the company claims the litigation is immaterial.", 'CourtListener 的 15 起案件 / 78 条案卷记录提示，后续可能出现更多诉讼请求；诉讼影响不大。', true],
    ["CourtListener's 15 cases / 78 docket entries suggest additional claims may follow; the company claims the litigation is immaterial.", 'CourtListener 的 15 起案件 / 78 条案卷记录提示，后续可能出现更多诉讼请求；公司声称诉讼影响不大。', false],
    ['CourtListener claims additional updates will follow.', 'CourtListener 后续将提供更多更新。', true],
    ['No public reference to third-party OS or hardware security audit.', '未见第三方 OS 或硬件安全审计的公开引用。', false],
    ['No public reference to a security audit.', '未见安全审计的公开引用。', false],
    ['No public reference to a security audit.', '已有安全审计的公开引用。', true],
    ['No public reference to a security audit.', '并非未见安全审计的公开引用。', true],
    ['No public reference to a security audit.', '不是 未见安全审计的公开引用。', true],
    ['No public reference to a security audit.', '未见安全审计的公开引用的判断不成立。', true],
    ['No public reference to a security audit.', '未见合同；安全审计的公开引用可查。', true],
    ['No public reference to a security audit; no public revenue data.', '未见安全审计的公开引用；收入已经披露。', true],
    ['No public revenue data.', '未见安全审计的公开引用。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `legal demands and missing audit references retain their meaning (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Disclosure standards require no public filing of accounts.', '披露标准不要求公开提交账目。', false],
    ['The rule requires no public filing of accounts.', '规定无需公开申报财务报表。', false],
    ['Disclosure standards require no public filing of accounts.', '披露标准要求公开提交账目。', true],
    ['Disclosure standards require no public filing of accounts.', '账目未公开。', true],
    ['Disclosure standards require no public filing of accounts.', '规定禁止公开提交账目。', true],
    ['Disclosure standards require no public filing of accounts.', '并非不要求公开提交账目。', true],
    ['Disclosure standards require no public filing of accounts.', '不要求公开提交账目的说法不成立。', true],
    ['Disclosure standards require no public filing of accounts.', '不要求公开提交资料；账目已经提交。', true],
    ['No public sources can substitute for data-room access on these topics.', '上述主题没有任何公开来源可以替代数据室访问。', false],
    ['No public sources can substitute for data-room access.', '没有公开来源能够替代数据室查阅。', false],
    ['No public sources can substitute for data-room access.', '公开来源可以替代数据室访问。', true],
    ['No public sources can substitute for data-room access.', '资料未公开。', true],
    ['No public sources can substitute for data-room access.', '不是 没有任何公开来源可以替代数据室访问。', true],
    ['No public sources can substitute for data-room access.', '没有任何公开来源可以替代数据室访问的说法不成立。', true],
    ['No public sources can substitute for data-room access.', '没有公开来源；第三方资料可以替代数据室访问。', true],
    ['The company has no public comparables at scale.', '公司缺少同规模上市可比公司。', false],
    ['The company has no public comparables at scale.', '公司没有规模相当的可比上市公司。', false],
    ['The company has no public comparables at scale.', '公司有同规模上市可比公司。', true],
    ['The company has no public comparables at scale.', '公司缺少同规模公开可比公司。', true],
    ['The company has no public comparables at scale.', '公司缺少同规模非上市可比公司。', true],
    ['The company has no public comparables at scale.', '公司缺少上市可比公司。', true],
    ['The company has no public comparables at scale.', '并非缺少同规模上市可比公司。', true],
    ['The company has no public comparables at scale.', '缺少同规模上市可比公司的判断不成立。', true],
    ['No public signal of IPO preparation, Series E timeline, or strategic sale process.', '没有 IPO 准备、Series E 时间表或战略出售流程的公开信号。', false],
    ['No public signal of an IPO.', '未见 IPO 的公开信号。', false],
    ['No public signal of an IPO.', '已有 IPO 的公开信号。', true],
    ['No public signal of an IPO.', '并非没有 IPO 的公开信号。', true],
    ['No public signal of an IPO.', '没有 IPO 的公开信号的判断不成立。', true],
    ['No public signal of an IPO.', '没有收入记录；IPO 的公开信号明确。', true],
    ['No public signal of an IPO; no public revenue data.', '没有 IPO 的公开信号；收入已经披露。', true],
    ['No public revenue data.', '没有 IPO 的公开信号。', true],
    ['The standards require no public filing of accounts; no public revenue data exists.', '标准不要求公开提交账目；收入已经披露。', true],
    ['The standards require no public filing of accounts; no public revenue data exists.', '标准要求公开提交账目；收入未公开。', true],
    ['The standards require no public filing of accounts; no public revenue data exists.', '标准不要求公开提交账目；收入未公开。', false],
    ['No public sources can substitute for data-room access; no public revenue data exists.', '没有任何公开来源可以替代数据室访问；收入已经披露。', true],
    ['No public sources can substitute for data-room access; no public revenue data exists.', '公开来源可以替代数据室访问；收入未公开。', true],
    ['No public sources can substitute for data-room access; no public revenue data exists.', '没有任何公开来源可以替代数据室访问；收入未公开。', false],
    ['The company has no public comparables at scale; no public revenue data exists.', '公司没有同规模上市可比公司；收入已经披露。', true],
    ['The company has no public comparables at scale; no public revenue data exists.', '公司有同规模上市可比公司；收入未公开。', true],
    ['The company has no public comparables at scale; no public revenue data exists.', '公司没有同规模上市可比公司；收入未公开。', false],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `public filing duties, source limits, listed peers and signals retain distinct predicates (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    [{}, false],
    [{ target: '以$5.6B入场的退出倍数' }, false],
    [{ header: 'Exit Multiple at 5.6M Entry', target: '以 $5.6M 入场的退出倍数' }, false],
    [{ target: '以 5.6B 入场的退出倍数' }, false],
    [{ target: '以 $5.7B 入场的退出倍数' }, true],
    [{ target: '以 $5.6M 入场的退出倍数' }, true],
    [{ target: '退出倍数' }, true],
    [{ target: '以 $5.6B 或 $11B 入场的退出倍数' }, true],
    [{ target: '以 HK$5.6B 入场的退出倍数' }, true],
    [{ target: '以 $5.6B 加元入场的退出倍数' }, true],
    [{ target: '以约 $5.6B 入场的退出倍数' }, true],
    [{ valuationHeader: 'Robot count by 2028' }, true],
    [{ values: [] }, true],
    [{ values: ['$8B–$15B', 'Not disclosed'] }, true],
    [{ values: ['$8B–$15B', '€2B–€4B'] }, true],
    [{ values: ['HK$8B–HK$15B'] }, true],
    [{ values: ['$8B–$15B'], notes: 'Entry is denominated in HKD.' }, true],
    [{ values: ['$8B–$15B'], notes: 'Entry is priced in Hong Kong dollars.' }, true],
    [{ duplicateColumn: true }, true],
    [{ header: 'Exit Multiple at approximately 5.6B Entry' }, true],
    [{ header: 'Robot count at 5.6B Entry' }, true],
    [{ header: 'Exit Multiple at $5.6B Entry' }, false],
  ].flatMap(([options, expected]) => [false, true].map(strictEditor => {
    const [en, zh] = entryMultiplePair(options);
    return [
      checkPairQuality(en, zh, { strictEditor }).some(issue => issue.path === 'tables/0/columns/1' && issue.code === 'metric-preservation')
        === (strictEditor && expected),
      `entry currency needs an unambiguous dollar valuation table (strict=${strictEditor}): ${JSON.stringify(options)}`,
    ];
  })),
  [
    checkPairQuality(fullReport('Exit Multiple at 5.6B Entry'), fullReport('以 $5.6B 入场的退出倍数'), { strictEditor: true })
      .some(issue => issue.code === 'metric-preservation'),
    'a standalone heading cannot invent dollar context',
  ],
  ...[
    ['Customer notices and some indemnity from Insider for narrow claim classes.', '客户通知，以及 Insider 对狭窄索赔类别提供的部分赔偿。', false],
    ['Indemnity is available for narrow claim classes.', '部分特定类别的索赔可获赔偿。', false],
    ['Indemnity is available for narrow claim classes; the company claims all losses are covered.', '特定类别索赔可获赔偿；所有损失均获保障。', true],
    ['The company claims classes of customers receive full coverage.', '不同客户类别均获完整保障。', true],
    ['The company claims narrow indemnity coverage.', '保障只覆盖特定赔偿责任。', true],
    ['No public revenue-band split by retail sub-vertical or region.', '未按零售子垂直或区域公开收入档位拆分。', false],
    ['No public revenue-band split by retail sub-vertical or region.', '已按零售子垂直或区域公开收入档位拆分。', true],
    ['No public revenue-band split by retail sub-vertical or region.', '并非未按零售子垂直或区域公开收入档位拆分。', true],
    ['No public revenue-band split by retail sub-vertical or region.', '不是 未按零售子垂直或区域公开收入档位拆分。', true],
    ['No public revenue-band split by retail sub-vertical or region.', '未按零售子垂直或区域公开收入档位拆分的说法不成立。', true],
    ['No public revenue-band split by retail sub-vertical or region.', '未按零售子垂直或区域分类；公开收入档位拆分。', true],
    ['No public revenue-band split exists; no public valuation exists.', '未按零售子垂直或区域公开收入档位拆分；估值已披露。', true],
    ['No public contract-size or renewal data exists.', '未按零售子垂直或区域公开收入档位拆分。', true],
    ['No public contract-size or renewal data by telecom/media account.', '未按电信 / 媒体账户公开合同规模或续约数据。', false],
    ['No public contract-size or renewal data by telecom/media account.', '已按电信 / 媒体账户公开合同规模或续约数据。', true],
    ['No public contract-size or renewal data by telecom/media account.', '并非未按电信 / 媒体账户公开合同规模或续约数据。', true],
    ['No public contract-size or renewal data by telecom/media account.', '不是 未按电信 / 媒体账户公开合同规模或续约数据。', true],
    ['No public contract-size or renewal data by telecom/media account.', '未按电信 / 媒体账户公开合同规模或续约数据的说法不成立。', true],
    ['No public contract-size or renewal data by telecom/media account.', '未按电信 / 媒体账户分类；公开合同规模或续约数据。', true],
    ['No public contract-size or renewal data exists; no public valuation exists.', '未按电信 / 媒体账户公开合同规模或续约数据；估值已披露。', true],
    ['No public revenue-band split exists.', '未按电信 / 媒体账户公开合同规模或续约数据。', true],
    ['No public backlog exists.', '未按零售子垂直或区域公开收入档位拆分。', true],
    ['No public revenue-band split exists.', '未按期公开收入档位拆分。', true],
    ['No public contract-size or renewal data exists.', '未按期公开合同规模或续约数据。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `indemnity nouns and segmented disclosure gaps retain scope (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Public evidence can support the claim that users engage.', '公开证据可以支撑用户参与的判断。', false],
    ['Public evidence can therefore support the claim that users engage.', '公开证据因此可以支撑用户参与的判断。', false],
    ['Public evidence can support the claim that users engage; the company claims its revenue doubled.', '公开证据可以支撑用户参与的判断；公司收入翻倍。', true],
    ['The company claims public evidence proves retention.', '公开证据证明了留存。', true],
    ['The company makes a claim that users engage.', '用户会参与。', true],
    ['No public standalone campus-recruiting TAM exists.', '公开市场上没有独立的校园招聘 TAM。', false],
    ['No public standalone campus-recruiting software TAM exists.', '公开市场上没有独立的校园招聘软件 TAM。', false],
    ['No public standalone campus-recruiting TAM exists.', '公开市场上已有独立的校园招聘 TAM。', true],
    ['No public standalone campus-recruiting TAM exists.', '并非公开市场上没有独立的校园招聘 TAM。', true],
    ['No public standalone campus-recruiting TAM exists.', '不是 公开市场上没有独立的校园招聘 TAM。', true],
    ['No public standalone campus-recruiting TAM exists.', '公开市场上没有独立的校园招聘 TAM 的判断不成立。', true],
    ['No public standalone campus-recruiting TAM exists.', '公开市场上没有价格；独立的校园招聘 TAM 已披露。', true],
    ['No public standalone campus-recruiting TAM exists; no public revenue data exists.', '公开市场上没有独立的校园招聘 TAM；收入已披露。', true],
    ['No public revenue data exists.', '公开市场上没有独立的校园招聘 TAM。', true],
    ['No public segmentation by revenue, engagement, or school profitability exists.', '没有按收入、参与度或学校盈利能力公开分层。', false],
    ['No public segmentation by revenue exists.', '已经按收入公开分层。', true],
    ['No public segmentation by revenue exists.', '并非没有按收入公开分层。', true],
    ['No public segmentation by revenue exists.', '不是 没有按收入公开分层。', true],
    ['No public segmentation by revenue exists.', '没有按收入公开分层的判断不成立。', true],
    ['No public segmentation by revenue exists.', '没有按期披露；按收入公开分层。', true],
    ['No public segmentation exists; no public revenue data exists.', '没有按收入公开分层；收入已披露。', true],
    ['No public revenue data exists.', '没有按收入公开分层。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `evidence judgments, standalone TAMs and segmentation gaps preserve scope (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Additional consumer-protection claims remain unresolved.', '额外消费者保护索赔仍未解决。', false],
    ['The company claims its consumer-protection policies are sufficient.', '公司的消费者保护政策足够完善。', true],
    ['Consumer-protection claims remain unresolved; the company claims it is profitable.', '消费者保护索赔仍未解决；公司已盈利。', true],
    ['The company pursued antitrust counter-claims.', '公司提起反垄断反诉。', false],
    ['Pursue counter-claim; could offset damages or force settlement.', '推进反诉；可能抵消损害赔偿或促成和解。', false],
    ['The company counter-claims an antitrust violation.', '公司反诉对方违反反垄断法。', false],
    ['The company pursued a counter-claim and claims its product is superior.', '公司提起反诉，其产品更优。', true],
    ['The company claims its counter-proposal is superior.', '公司的反提案更优。', true],
    ['Evidence does not support a clear positive claim.', '证据不足以支持明确正向判断。', false],
    ['Evidence does not support a clear positive claim; the company claims it is profitable.', '证据不足以支持明确正向判断；公司已盈利。', true],
    ['The company makes a clear positive claim.', '公司的表现很好。', true],
    ['Claims about tariff impacts are based on publicly available analysis.', '关税影响论断基于公开可得的分析。', false],
    ['Claims about tariff impacts are based on publicly available analysis.', '关税影响已经确定。', true],
    ['Claims about tariff impacts are based on publicly available analysis.', '并非关税影响论断基于公开分析。', true],
    ['Claims about tariff impacts are based on publicly available analysis.', '不是 关税影响论断基于公开分析。', true],
    ['Claims about tariff impacts are based on publicly available analysis; the company claims it is profitable.', '关税影响论断基于公开分析；公司已盈利。', true],
    ['There is no public benchmark for the segment.', '该细分市场缺少公开基准。', false],
    ['There is no public benchmark for the segment.', '该细分市场已有公开基准。', true],
    ['There is no public benchmark for the segment.', '并非缺少公开基准。', true],
    ['There is no public benchmark for the segment.', '不是 缺少公开基准。', true],
    ['There is no public benchmark for the segment.', '缺少公开基准的判断不成立。', true],
    ['There is no public benchmark for the segment.', '缺少价格信息；公开基准已经发布。', true],
    ['There is no public revenue disclosure.', '该细分市场缺少公开基准。', true],
    ['There is no public benchmark; no public revenue data is available.', '缺少公开基准；收入已披露。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `legal counterclaims, research assertions and benchmarks retain distinct scope (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['The valuation is not yet cheap.', '估值还谈不上便宜。', false],
    ['The valuation is not yet cheap.', '估值已经很便宜。', true],
    ['The valuation is not yet cheap.', '估值并非还谈不上便宜。', true],
    ['The valuation is not yet cheap.', '不是 还谈不上便宜。', true],
    ['The valuation is not yet cheap.', '还谈不上便宜的判断不成立。', true],
    ['The valuation is not yet cheap.', '还谈不上盈利；估值很便宜。', true],
    ['The valuation is not yet cheap; earnings are not yet audited.', '估值还谈不上便宜；盈利已审计。', true],
    ['The company is not yet profitable.', '估值还谈不上便宜。', true],
    ['There is no public, universally accepted market report for the category.', '公开市场上没有被普遍接受的品类报告。', false],
    ['There is no public market report for the category.', '公开市场上没有这类报告。', false],
    ['There is no public market report for the category.', '公开市场上已有这类报告。', true],
    ['There is no public market report for the category.', '并非公开市场上没有这类报告。', true],
    ['There is no public market report for the category.', '不是 公开市场上没有这类报告。', true],
    ['There is no public market report for the category.', '公开市场上没有这类报告的判断不成立。', true],
    ['There is no public market report for the category.', '公开市场上没有价格；报告已发布。', true],
    ['There is no public market report; no public revenue data is available.', '公开市场上没有这类报告；收入已披露。', true],
    ['There is no public revenue data.', '公开市场上没有这类报告。', true],
    ['The conclusion is not that the company can claim every BaaS or DBaaS dollar.', '结论并非公司能拿下每一美元 BaaS 或 DBaaS 支出。', false],
    ['The company can claim every BaaS dollar.', '公司能拿下每一美元 BaaS 支出。', false],
    ['Use public budgets rather than a single expansive TAM claim.', '应采用公开预算，而非单一扩张型 TAM 叙事。', false],
    ['Use public budgets rather than a single TAM claim.', '应采用公开预算，而非单一 TAM 叙事。', false],
    ['The company claims it can claim every BaaS or DBaaS dollar.', '公司能拿下每一美元 BaaS 或 DBaaS 支出。', true],
    ['The company can claim every BaaS dollar, and claims margins will improve.', '公司能拿下每一美元 BaaS 支出，利润率也将改善。', true],
    ['Use public budgets rather than a single expansive TAM claim; the company claims it is profitable.', '应采用公开预算，而非单一扩张型 TAM 叙事；公司已盈利。', true],
    ['The company makes a single expansive TAM claim.', '公司可获取的市场很大。', true],
    ['The company can claim every DBaaS dollar; its claimed scale needs verification.', '公司能拿下每一美元 DBaaS 支出；规模还需核实。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map(strictEditor => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some(issue => issue.code === 'hedge-preservation') === expected,
    `market sizing and cheapness qualifiers keep scope and separate assertions (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['B2B AWARDS recognition; the B2B AWARDS category is named again.', 'B2B AWARDS 奖项；再次提及该品类。', false],
    ['B2B revenue is $2B.', 'B2B 收入为 $2B。', false],
    ['B2B revenue is $2B.', 'B2B 收入为 $3B。', true],
    ['B2B volume is 2B transactions.', 'B2B 交易量为 3B 笔。', true],
    ['B2B revenue was $2B in 2025.', 'B2B 收入为 $2B。', true],
    ['B2B revenue is $2B; B2B revenue is $2B.', 'B2B 收入为 $2B。', true],
    ['B2B revenue is $2B.', '收入为 $2B，另有 2B 笔交易。', true],
    ['The conventionalB2B market has 3million connections.', '传统 B2B 市场有 300 万连接。', false],
    ['The conventionalB2B market has 3million connections.', '传统 B2B 市场有 400 万连接。', true],
    ['The written quantities are 2B2B.', '原文数量为 2B。', true],
  ].map(([en, zh, mismatch]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some(issue => issue.code === 'metric-preservation') === mismatch,
    `B2B is an identifier, not a two-billion quantity: ${en} / ${zh}`,
  ]),
  ...[
    ['4× Reclame Aqui award (company claim); 9/10 renewal rate.', '4 次 Reclame Aqui 获奖（公司口径）；9/10 续保率。', true],
    ['Auto insurance is described as 4x champion.', '汽车保险被描述为 4 次夺冠。', true],
    ['Reclame Aqui 4× champion (company-stated).', 'Reclame Aqui 4 次冠军（公司披露）。', true],
    ['4× award; 3× champion.', '4 次获奖；3 次夺冠。', true],
    ['4× champion; revenue was $10M in May 2025.', '4 次夺冠；2025 年 5 月收入为 $10M。', true],
    ['4× champion; 16 insurers; 100% online; 9/10 renewal rate.', '4 次夺冠；16 家保险公司；100% 在线；9/10 续保率。', true],
    ['9007199254740993× champion.', '9007199254740993 次夺冠。', true],
    ['9007199254740993× champion.', '9007199254740992 次夺冠。', false],
    ['4× champion.', '5 次夺冠。', false],
    ['4× champion.', '多次夺冠。', false],
    ['4× champion; 4× champion.', '4 次夺冠。', false],
    ['4× champion; 16 insurers; 100% online; 9/10 renewal rate.', '4 次夺冠；17 家保险公司；100% 在线；9/10 续保率。', false],
    ['4× champion; revenue was $10M in May 2025.', '4 次夺冠；2025 年 6 月收入为 $10M。', false],
    ['4× champion; revenue was $10M.', '4 次夺冠；收入为 $11M。', false],
    ['4× champion; revenue grew 3x.', '4 次夺冠；收入增长 3 次。', false],
    ['4× champion; revenue was -$10M.', '4 次夺冠；收入为 $10M。', false],
    ['4× champion; revenue was ($10M).', '4 次夺冠；收入为 $10M。', false],
    ['4× award size.', '4 次获奖规模。', false],
    ['4× growth.', '增长 4 次。', false],
    ['4× champion.', '4 次增长。', false],
    ['4× champion.', '4 次以上夺冠。', false],
    ['4× champion.', '约 4 次夺冠。', false],
    ['At least 4× champion.', '4 次夺冠。', false],
    ['More than 4× champion.', '4 次夺冠。', false],
    ['4× champion.', '至少 4 次夺冠。', false],
    ['4× champion.', '多达 4 次夺冠。', false],
    ['4× champion; 16 insurers.', '16 次夺冠；4 家保险公司。', false],
    ['4× champion; 16 insurers; 16 products.', '4 次夺冠；16 家保险公司。', false],
    ['4.5× champion.', '4 次夺冠。', false],
    ['-4× champion.', '4 次夺冠。', false],
    ['+4× champion.', '4 次夺冠。', false],
    ['3–4× champion.', '4 次夺冠。', false],
    ['4× champion.', '-4 次夺冠。', false],
  ].map(([en, zh, equivalent]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .every(issue => issue.code !== 'metric-preservation') === equivalent,
    `award occurrences are not multipliers and retain every other numeric anchor: ${en} / ${zh}`,
  ]),
  ...[false, true].map(strictEditor => [
    checkPairQuality(
      fullReport('The company claims it is a 4× champion. Independent verification is required.'),
      fullReport('4 次夺冠，仍需独立核实。'), { strictEditor },
    ).some(issue => issue.code === 'hedge-preservation'),
    `award-count normalization cannot erase company attribution (strict=${strictEditor})`,
  ]),
  ...[
    ['Software maturity and deployment scale both remain unproven.', '软件成熟度与部署规模，两者都尚未得到证明。', false],
    ['Commercial maturity is unproven.', '商业成熟度尚未得到验证。', false],
    ['Commercial maturity is not proven.', '商业成熟度尚未得到证实。', false],
    ['Commercial maturity is unproven.', '商业成熟度已经得到证明。', true],
    ['Commercial maturity is unproven.', '商业成熟度并非尚未得到证明。', true],
    ['Commercial maturity is unproven.', '不是 尚未得到证明。', true],
    ['Commercial maturity is unproven.', '尚未得到证明的说法不成立。', true],
    ['Commercial maturity is unproven.', '尚未得到材料；商业成熟度已获证明。', true],
    ['Commercial maturity is unproven.', '尚未得到材料，其他实验已经提供证明。', true],
    ['Commercial maturity is unproven; safety is unproven.', '商业成熟度尚未得到证明；安全性已确认。', true],
    ['No public announcement of any round before Series B in February 2026.', '2026 年 2 月 B 轮前没有任何轮次的公开公告。', false],
    ['No public announcements of earlier rounds.', '未见更早轮次的公开公告。', false],
    ['No public announcement of earlier rounds.', '已有更早轮次的公开公告。', true],
    ['No public announcement of earlier rounds.', '并非没有更早轮次的公开公告。', true],
    ['No public announcement of earlier rounds.', '不是 未见更早轮次的公开公告。', true],
    ['No public announcement of earlier rounds.', '没有更早轮次的公开公告的说法不成立。', true],
    ['No public announcement of earlier rounds.', '没有更早轮次的记录；公司的公开公告可查。', true],
    ['No public pricing.', '没有任何轮次的公开公告。', true],
    ['No public announcement of earlier rounds; no public revenue data.', '没有更早轮次的公开公告；收入已经披露。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `unproven and announcement gaps retain negation and separate predicates (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['No public customer or economics proof at a reported valuation.', '仍缺公开客户与经济性证明。', false],
    ['No public customer proof.', '尚缺公开客户证据。', false],
    ['No public evidence.', '仍缺公开证据。', false],
    ['No public customer proof.', '已有公开客户证明。', true],
    ['No public customer proof.', '并非仍缺公开客户证明。', true],
    ['No public customer proof.', '不是 尚缺公开客户证明。', true],
    ['No public customer proof.', '仍缺公开客户证明的说法不成立。', true],
    ['No public customer proof.', '仍缺公开资料；客户证明已经发布。', true],
    ['No public customer proof.', '仍缺公开资料，其他材料构成证明。', true],
    ['No public pricing.', '仍缺公开客户证明。', true],
    ['No public pricing; customer proof is available.', '仍缺公开客户证明。', true],
    ['No public pricing, but customer proof is available.', '仍缺公开客户证明。', true],
    ['No public customer proof; no public revenue data.', '仍缺公开客户证明；收入已经披露。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `missing public proof retains scope and negation (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['GitHub has no public repositories attributable to GreyOrange warehouse orchestration.', 'GitHub 上没有可归因于 GreyOrange 仓库编排的公开代码库。', false],
    ['There are no public repositories attributable to the company.', '未见可归因于该公司的公开仓库。', false],
    ['GitHub has no public repositories attributable to GreyOrange.', 'GitHub 上有可归因于 GreyOrange 的公开代码库。', true],
    ['GitHub has no public repositories attributable to GreyOrange.', 'GitHub 上并非没有可归因于 GreyOrange 的公开代码库。', true],
    ['GitHub has no public repositories attributable to GreyOrange.', '不是 未见可归因于 GreyOrange 的公开代码库。', true],
    ['GitHub has no public repositories attributable to GreyOrange.', '没有可归因于 GreyOrange 的公开代码库的说法不成立。', true],
    ['GitHub has no public repositories attributable to GreyOrange.', '没有可归因于公司的记录；公开代码库已上线。', true],
    ['GitHub has no public repositories attributable to GreyOrange.', '没有可归因于公司的记录，其他团队的公开代码库可查。', true],
    ['No public pricing is attributable to GreyOrange.', '没有可归因于 GreyOrange 的公开代码库。', true],
    ['No public repositories attributable to GreyOrange; no public audit.', '没有可归因于 GreyOrange 的公开代码库；审计已完成。', true],
    ['SEC EDGAR returns no public filings for BETA.', 'SEC EDGAR 没有检索到 BETA 的公开文件。', false],
    ['The search returned no public filings for BETA.', '未检索到 BETA 的公开申报文件。', false],
    ['The search found no public filing for BETA.', '没有检索到 BETA 的公开文件。', false],
    ['SEC EDGAR returns no public filings for BETA.', 'SEC EDGAR 已检索到 BETA 的公开文件。', true],
    ['SEC EDGAR returns no public filings for BETA.', 'SEC EDGAR 并非没有检索到 BETA 的公开文件。', true],
    ['SEC EDGAR returns no public filings for BETA.', '不是 未检索到 BETA 的公开申报文件。', true],
    ['SEC EDGAR returns no public filings for BETA.', '没有检索到 BETA 的公开文件的说法不成立。', true],
    ['SEC EDGAR returns no public filings for BETA.', '没有检索到资料；BETA 的公开文件可查。', true],
    ['SEC EDGAR returns no public filings for BETA.', '没有检索到资料，BETA 的公开文件可查。', true],
    ['No public filings exist for BETA.', '没有检索到 BETA 的公开文件。', true],
    ['The search found no public pricing for BETA.', '没有检索到 BETA 的公开文件。', true],
    ['SEC EDGAR returns no public filings for BETA; no public revenue data.', '没有检索到 BETA 的公开文件；收入已披露。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `filing-search absence retains scope and negation (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Plant-derived compounds require careful claim drafting for patent protection.', '植物来源化合物需要谨慎撰写权利要求，才能获得专利保护。', false],
    ['Protection depends on claim drafting strategy.', '保护范围取决于权利要求撰写策略。', false],
    ['Composition-of-matter claims on novel analogs more defensible than isolation claims.', '新型类似物的物质组成权利要求比单纯分离权利要求更站得住。', false],
    ['Pursue analogue-specific composition-of-matter claims; regular patent portfolio review.', '争取针对类似物的物质组成权利要求；定期复核专利组合。', false],
    ['USPTO patent filing portfolio not fully disclosed; depth and quality of claims uncertain.', '向 USPTO 提交的专利组合未完整披露；权利要求深度和质量不确定。', false],
    ['USPTO patent filing portfolio not fully disclosed; depth and quality of claims uncertain. The company claims superior efficacy.', '向 USPTO 提交的专利组合未完整披露；权利要求深度和质量不确定。疗效更优。', true],
    ['USPTO patent filing portfolio not fully disclosed; depth and quality of claims uncertain. The company claims superior efficacy.', '向 USPTO 提交的专利组合未完整披露；权利要求深度和质量不确定。公司声称疗效更优。', false],
    ['The company claims drafting strategy improves patent protection.', '撰写策略能增强专利保护。', true],
    ['We claim drafting strategy improves patent protection.', '撰写策略能增强专利保护。', true],
    ['The company claims isolation is guaranteed by the platform.', '平台保证隔离。', true],
    ['Isolation claims require independent verification.', '隔离效果需要独立验证。', true],
    ['Composition-of-matter claims are pending. The company claims protection is complete.', '物质组成权利要求尚在审查。保护已完备。', true],
    ['Composition-of-matter claims are pending. The company claims protection is complete.', '物质组成权利要求尚在审查。公司声称保护已完备。', false],
    ['Composition-of-matter claims are pending; no public evidence of commercial efficacy.', '物质组成权利要求尚在审查；商业疗效已经验证。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `patent-rights nouns do not erase separate assertions or evidence gaps (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Scores are analyst judgments synthesized from the cited claims.', '评分是分析师综合所引论断作出的判断。', false],
    ['Scores are synthesized from the cited claims. The company claims accuracy is superior.', '评分综合所引论断得出。准确率更高。', true],
    ['Scores are synthesized from the cited claims. The company claims accuracy is superior.', '评分综合所引论断得出。公司声称准确率更高。', false],
    ['The company claims its scores are synthesized from audited data.', '评分综合审计数据得出。', true],
    ['No public SOC 2, ISO 27001, penetration-test summary, or uptime page retained in chapter evidence.', '章节证据中未收录公开的 SOC 2、ISO 27001、渗透测试摘要或正常运行时间页面。', false],
    ['No public security audit retained in chapter evidence.', '本章证据中未收录公开的安全审计。', false],
    ['No public security audit retained in chapter evidence.', '章节证据中收录了公开的安全审计。', true],
    ['No public security audit retained in chapter evidence.', '并非章节证据中未收录公开的安全审计。', true],
    ['No public security audit retained in chapter evidence.', '不是 章节证据中未收录公开的安全审计。', true],
    ['No public security audit retained in chapter evidence.', '章节证据中并非未收录公开的安全审计。', true],
    ['No public security audit exists.', '章节证据中未收录公开的安全审计。', true],
    ['No public security audit retained in chapter evidence; no public pricing.', '章节证据中未收录公开的安全审计；定价已公布。', true],
    ['No public security audit and no public pricing retained in chapter evidence.', '章节证据中未收录公开的安全审计，定价已收录。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `cited evidence and retained-source gaps preserve scope (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['All claims in this table are minted locally for the Financials chapter.', '本表各项判断在财务章节内单独生成。', false],
    ['All claims in this table\nare minted locally. Cash balance and burn are fully private.', '本表各项判断在本章内单独生成。现金余额和烧钱速度完全未公开。', false],
    ['All claims in this table are minted locally. The company claims national coverage.', '本表各项判断均单独生成。覆盖全国。', true],
    ['All claims in this table are minted locally. The company claims national coverage.', '本表各项判断均单独生成。公司声称覆盖全国。', false],
    ['This table uses its own evidence, using locally minted claims rather than copied claim ids.', '本表使用本章单独建立的证据论断，而非复制其他章节的论断编号。', false],
    ['This table uses its own evidence, using locally minted\nclaims rather than copied claim IDs.', '本表使用本章单独建立的证据论断，而非复制其他章节的论断编号。', false],
    ['This table uses its own evidence, using locally minted claims rather than copied claim ids. The company claims national coverage.', '本表使用本章单独建立的证据论断，而非复制其他章节的论断编号。覆盖全国。', true],
    ['This table uses its own evidence, using locally minted claims rather than copied claim ids. The company claims national coverage.', '本表使用本章单独建立的证据论断，而非复制其他章节的论断编号。公司声称覆盖全国。', false],
    ['The company claims using locally minted claims rather than copied claim ids improves accuracy.', '使用本章单独建立的证据论断，而非复制论断编号，可以提高准确率。', true],
    ['The company claims using locally minted claims rather than copied claim ids improves accuracy.', '公司声称使用本章单独建立的证据论断，而非复制论断编号，可以提高准确率。', false],
    ['This table uses its own evidence, using locally minted claims rather than copied claim ids; no public cash data.', '本表使用本章单独建立的证据论断，而非复制其他章节的论断编号；现金数据已公开。', true],
    ['The company claims locally minted software improves accuracy.', '本地生成的软件提高了准确率。', true],
    ['The company claims in this table that coverage is national.', '覆盖全国。', true],
    ['The company claims locally deployed software raises accuracy.', '本地部署的软件提高了准确率。', true],
    ['No public evidence available.', '公开证据缺失。', false],
    ['No public evidence of revenue quality.', '有关收入质量，公开证据仍缺失。', false],
    ['No public evidence on current data volume, eval cadence, or post-deal model roadmap ownership.', '关于当前数据量、评估节奏或交易后模型路线图归属，公开证据缺失', false],
    ['No public evidence available.', '公开证据尚缺失', false],
    ['No public evidence available.', '公开证据已提供。', true],
    ['No public evidence available.', '并非公开证据缺失。', true],
    ['No public evidence available.', '不是 公开证据缺失。', true],
    ['No public evidence available.', '公开证据并非缺失。', true],
    ['No public evidence available.', '公开证据缺失的说法不成立。', true],
    ['No public evidence available.', '公开证据缺失：否。', true],
    ['No public evidence available; no public pricing data.', '公开证据缺失；定价已公布。', true],
    ['No public evidence of revenue; no public evidence of profit.', '公开证据缺失；利润已有证据。', true],
    ['No public pricing data.', '公开证据缺失。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `ledger nouns and public-evidence absence retain separate assertions and gaps (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['No public evidence of multi-cloud failover.', '没有多云故障切换的公开证据。', false],
    ['No public evidence of Alibaba/Tencent-driven customer conversion.', '没有 Alibaba / Tencent 推动客户转化的公开证据。', false],
    ['No public evidence on financial performance.', '未见财务表现的公开证据。', false],
    ['No public evidence of research progress.', '没有提供研究进展的公开证据。', false],
    ['No public evidence of multi-cloud failover.', '已有多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover.', '并非没有多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover.', '并不是 没有多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover.', '不是未见多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover.', '没有故障；系统有多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover.', '未见问题, 这里有多云故障切换的公开证据。', true],
    ['No public evidence of multi-cloud failover; no public pricing data.', '没有多云故障切换的公开证据；定价已公布。', true],
    ['No public evidence of revenue; no public evidence of profit.', '没有收入的公开证据；利润已证实。', true],
    ['No public pricing data.', '没有收入的公开证据。', true],
    ['No public evidence supports even a rough bound.', '公开证据不足以支撑哪怕粗略区间。', false],
    ['No public evidence supports even a rough bound.', '公开证据尚不足以支撑哪怕粗略区间。', false],
    ['No public evidence supports even a rough bound.', '公开证据足以支撑粗略区间。', true],
    ['No public evidence supports even a rough bound.', '并非公开证据不足以支撑粗略区间。', true],
    ['No public evidence supports even a rough bound.', '不是 公开证据不足以支撑粗略区间。', true],
    ['No public evidence supports even a rough bound.', '公开证据并非不足以支撑粗略区间。', true],
    ['No public evidence supports even a rough bound.', '公开证据不足以，其他条件支撑粗略区间。', true],
    ['No public evidence of revenue.', '公开证据不足以支撑收入预测。', true],
    ['No public evidence supports a bound; no public cash disclosure.', '公开证据不足以支撑区间；现金已披露。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `tail-position evidence gaps retain negation and separate disclosures (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['Warranty claims, field failures, and return rates.', '保修索赔、现场故障和退货率。'],
    ['Request warranty claim history and payout data.', '索取保修索赔历史和赔付数据。'],
    ['Track battery-warranty claim rates by product.', '按产品跟踪电池保修索赔率。'],
    ['The warranty claim response target is 24 hours.', '保修索赔响应目标为 24 小时。'],
    ['Warranty claims resolved target: 24 hours.', '保修索赔解决目标：24 小时。'],
    ['Margin depends on warranty claims and field service.', '利润率取决于保修索赔和现场服务。'],
    ['Product liability claims against GreyOrange are plausible if an injury traces to a software defect.', '如果伤害可追溯至软件缺陷，GreyOrange 可能面临产品责任索赔。'],
    ['A product-liability claim can follow a warehouse injury.', '仓库伤害事件可能引发产品责任索赔。'],
    ['Review product liability claims and warranty claim history.', '复核产品责任索赔和保修索赔历史。'],
    ['Injury, property damage, recall, insurance and customer claims.', '人身伤害、财产损失、召回、保险和客户索赔。'],
  ].flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      !checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport(zh), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `service and liability claims are compensation nouns (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`${en} The company claims its product is superior.`), fullReport(`${zh} 产品更好。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `compensation nouns do not suppress separate assertions (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    'The company claims warranty coverage is unlimited.',
    'The warranty claims that every loss is covered.',
    'The warranty claims complete protection.',
    'Warranty claims, return rates; claims its product is superior.',
    'The company claims product liability is limited.',
    'Product liability claims remain possible; claims every deployment is safe.',
    'The company claims insurance and customer protection are unlimited.',
    'Review insurance and customer claims; claims every deployment is safe.',
    'Insurance and customer claims are logged; the company claims its product is superior.',
  ].flatMap((en) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a source-reviewed diligence observation.`), fullReport('保障没有限制，产品更好。'), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `compensation-adjacent assertions still require attribution (strict=${strictEditor}): ${en}`,
  ])),
  ...[
    ['There is no public basis to calculate runway.', '公开信息不足以计算现金续航。', false],
    ['There is no public basis to assess revenue quality.', '公开资料仍不足以评估收入质量。', false],
    ['There is no public basis to assess revenue quality.', '公开证据尚不足以评估收入质量。', false],
    ['There is no public basis to calculate runway.', '公开信息足以计算现金续航。', true],
    ['There is no public basis to calculate runway.', '并非公开信息不足以计算现金续航。', true],
    ['There is no public basis to calculate runway.', '公开信息并非不足以计算现金续航。', true],
    ['There is no public pricing disclosure.', '公开信息不足以评估收入质量。', true],
    ['There is no public basis to calculate runway; no public pricing is available.', '公开信息不足以计算现金续航；定价已公布。', true],
    ['The dependencies are not yet fully transparent from public evidence.', '公开证据还无法完全看清这些依赖。', false],
    ['The dependencies are not yet fully transparent from public evidence.', '公开证据仍无法完全看清这些依赖。', false],
    ['The dependencies are not yet fully transparent from public evidence.', '公开证据已能完全看清这些依赖。', true],
    ['The dependencies are not yet fully transparent from public evidence.', '并非还无法完全看清这些依赖。', true],
    ['The dependencies are not yet fully transparent; the company is not yet profitable.', '公开证据还无法完全看清这些依赖；公司已经盈利。', true],
    ['The company is not yet profitable.', '公开证据还无法完全看清这些依赖；公司已经盈利。', true],
    ['The full operational scope is not yet publicly measurable.', '完整运营范围仍无法从公开材料中衡量。', false],
    ['The full operational scope is not yet publicly measurable.', '完整运营范围还无法从公开资料衡量。', false],
    ['The full operational scope is not yet publicly measurable.', '完整运营范围已能从公开材料中衡量。', true],
    ['The full operational scope is not yet publicly measurable.', '并非仍无法从公开材料中衡量。', true],
    ['The full operational scope is not yet publicly measurable.', '不是 仍无法从公开材料中衡量。', true],
    ['The full operational scope is not yet publicly measurable.', '仍无法从公开材料中了解细节，但能衡量完整运营范围。', true],
    ['The scope is not yet publicly measurable; the company is not yet profitable.', '范围仍无法从公开材料中衡量；公司已经盈利。', true],
    ['The scope is not yet publicly measurable; the impact is not yet publicly measurable.', '范围仍无法从公开材料中衡量；影响已经明确。', true],
    ['The company is not yet profitable.', '范围仍无法从公开材料中衡量；公司已经盈利。', true],
    ['Use a layered sizing view rather than a single “market size is X” claim.', '应分层估算，而不是一句「市场规模为 X」。', false],
    ['Use scenarios rather than a single "market size is X" claim.', '采用情景估算，而不是一句「市场规模为 X」。', false],
    ['Use scenarios rather than a single “market size is X” claim. The company claims national coverage.', '采用情景估算，而不是单一数字。覆盖全国。', true],
    ['Use scenarios rather than a single “market size is X” claim. The company claims national coverage.', '采用情景估算，而不是单一数字。公司声称覆盖全国。', false],
    ['The company makes a single “market size is X” claim.', '市场规模为 X。', true],
    ['The range expresses public-claim dispersion rather than audited company market share.', '区间表达公开口径分散，而非经审计的公司市场份额。', false],
    ['Public-claim dispersion is wide; the company claims its product is superior.', '公开口径分散；产品更好。', true],
    ['The company claims dispersion improved after product deployment.', '产品部署后分散程度改善。', true],
  ].flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `scoped evidence-gap and claim-noun rules preserve separate assertions (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['据独立报道，累计融资超过 $1B。', false],
    ['据媒体报道，累计融资超过 $1B。', false],
    ['据公开报道，累计融资超过 $1B。', false],
    ['根据独立报道，累计融资超过 $1B。', false],
    ['根据媒体报道，累计融资超过 $1B。', false],
    ['根据公开报道，累计融资超过 $1B。', false],
    ['报称累计融资超过 $1B。', false],
    ['融资尚待核验；报称累计融资超过 $1B。', false],
    ['累计融资超过 $1B。', true],
    ['并非据独立报道，累计融资超过 $1B。', true],
    ['不是根据媒体报道，累计融资超过 $1B。', true],
    ['没有根据公开报道，累计融资超过 $1B。', true],
    ['未据独立报道，累计融资超过 $1B。', true],
    ['并非报称累计融资超过 $1B。', true],
    ['没有报称累计融资超过 $1B。', true],
    ['媒体并未报称累计融资超过 $1B。', true],
  ].flatMap(([zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(
      fullReport('According to reports, cumulative funding exceeds $1B. This is a diligence observation.'),
      fullReport(zh),
      { strictEditor },
    ).some((issue) => issue.code === 'hedge-preservation') === expected,
    `reported-attribution variants preserve a non-negated reporting qualifier (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Filings: August 2015 ×2 and October 2020.', '备案：2015 年 8 月 ×2、2020 年 10 月。', true],
    ['Filings: March 2024 x2.', '备案：2024 年 03 月 X2。', true],
    ['Filings: August 2015 ×2; revenue was $10M.', '备案：2015 年 8 月 ×2；收入为 1000 万美元。', true],
    ['Filings: August 2015 ×2; usage was 3.5 million.', '备案：2015 年 8 月 ×2；用量为 350 万。', true],
    ['Revenue tripled; filings: August 2015 ×2.', '收入增至 3 倍；备案：2015 年 8 月 ×2。', true],
    ['Filings: August 2015 ×9007199254740993.', '备案：2015 年 8 月 ×9007199254740993。', true],
    ['Filings: August 2015 ×2.', '备案：2015 年 8 月 ×3。', false],
    ['Filings: August 2015 ×2.', '备案：2015 年 9 月 ×2。', false],
    ['Filings: August 2015 ×2.', '备案：2016 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2.', '备案：2015 年 8 月。', false],
    ['Filings: August 2015 ×2, August 2015 ×2.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2, October 2020 ×3.', '备案：2015 年 8 月 ×3、2020 年 10 月 ×2。', false],
    ['Filings: August 2015 ×2; revenue was $10M.', '备案：2015 年 8 月 ×2；收入为 1100 万美元。', false],
    ['Filings: August 2015 ×9007199254740993.', '备案：2015 年 8 月 ×9007199254740992。', false],
    ['The metric is 2015 ×2.', '该指标为 2015 年 ×2。', false],
    ['Filings: August 2015 ×2.5.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2+.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2–3.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2 – 3.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2 to 3.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2 million.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2.', '备案：2015 年 8 月 ×2 万。', false],
    ['Filings: August 2015 ×2.', '备案：2015 年 8 月 ×2 美元。', false],
    ['Filings: August 2015 ×2.', '备案：2015 年 8 月 ×2 次以上。', false],
    ['Filings: August 2015 ×2 or more.', '备案：2015 年 8 月 ×2。', false],
    ['Filings: August 2015 ×2,000.', '备案：2015 年 8 月 ×2。', false],
  ].map(([en, zh, resolved]) => [
    !checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation') === resolved,
    `dated occurrence counts preserve paired dates, exact counts, and other metrics: ${en} / ${zh}`,
  ]),
  ...[
    ['Coverage limits, exclusions, and claim procedures are not publicly disclosed.', '承保限额、除外责任和理赔流程未公开披露。'],
    ['Coverage limits, claim triggers, and exclusion list are not publicly disclosed.', '承保限额、理赔触发条件和除外责任清单未公开披露。'],
    ['Coverage terms and claims history are not public.', '承保条款和理赔历史未公开。'],
  ].map(([en, zh]) => [`${en} This is a diligence observation.`, `${zh} 这是尽调观察。`])
    .flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      !checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).some((issue) => issue.code === 'hedge-preservation'),
      `coverage-list claims are insurance nouns (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`${en} The company claims its product is superior.`), fullReport(`${zh} 产品更好。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `a coverage list must not hide a separate assertion (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    ['Company-stated growth claims are not audited financials.', '公司披露的增长口径并非审计财务数据。', false],
    ['Revenue growth is a management claim, without independent verification.', '收入增长来自管理层口径，缺乏独立验证。', false],
    ['Revenue growth is a management claim.', '收入增长并非管理层口径。', true],
    ['Revenue growth is a company claim.', '收入增长不是公司披露的增长口径。', true],
    ['No public financial statements filed.', '未提交公开财务报表。', false],
    ['No public financial statements filed.', '已提交公开财务报表。', true],
    ['No public financial statements filed.', '并非未提交公开财务报表。', true],
    ['No public security certification confirmed.', '未确认公开安全认证。', false],
    ['No public SOC 2 Type II, ISO 27001, or IEC 62443 certification confirmed.', '未确认公开 SOC 2 Type II、ISO 27001 或 IEC 62443 认证。', false],
    ['No public security certification confirmed.', '已确认公开安全认证。', true],
    ['No public security certification confirmed.', '并非未确认公开安全认证。', true],
    ['No public pricing data exists; a partnership was confirmed.', '未确认公开定价数据。', true],
    ['No public revenue data exists; a financing was filed.', '未提交公开收入数据。', true],
    ['Performance data not yet available.', '暂无绩效数据。', false],
    ['Performance data not yet available.', '已有绩效数据。', true],
    ['Performance data not yet available.', '并非暂无绩效数据。', true],
    ['The company is not yet profitable.', '暂无财务数据，公司已经盈利。', true],
    ['Coverage limits are low; the company claims procedures prevent losses.', '承保限额低；流程能防止损失。', true],
  ].map(([en, zh, expected]) => [`${en} This is a diligence observation.`, `${zh} 这是尽调观察。`, expected])
    .flatMap(([en, zh, expected]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === expected,
    `scoped disclosure aliases preserve attribution and absence (strict=${strictEditor}): ${en} / ${zh}`,
  ])),
  ...[
    ['The Series D tripled its February 2025 valuation.', 'Series D 估值增至 2025 年 2 月的 3 倍。', true],
    ['$120M raised in July 2026, tripling its February 2025 valuation.', '2026 年 7 月融资 $120M，估值增至 2025 年 2 月的 3 倍。', true],
    ['The Series D is said to triple the Series C valuation.', 'Series D 据称让 Series C 估值增至 3 倍。', true],
    ['The Series D tripling language needs verification.', 'Series D 估值增至 3 倍的说法需要核实。', true],
    ['Revenue tripled.', '收入增至 3 倍。', true],
    ['Revenue tripled.', '收入增长至 3 倍。', true],
    ['Revenue tripled, and usage tripled.', '收入增至 3 倍，用量也增至 3 倍。', true],
    ['Revenue tripled after 12 deployments.', '12 次部署后，收入增至 3 倍。', true],
    ['Revenue tripled from 2x to 6x.', '收入从 2 倍增至 6 倍。', true],
    ['Revenue tripled from $10M to $30M.', '收入从 $10M 增至 $30M，为原来的 3 倍。', true],
    ['Revenue tripled.', '收入增至 4 倍。', false],
    ['Revenue tripled, and usage tripled.', '收入和用量增至 3 倍。', false],
    ['Revenue tripled after 12 deployments.', '13 次部署后，收入增至 3 倍。', false],
    ['Revenue tripled after three deployments.', '3 次部署后，收入增至 3 倍。', false],
    ['Revenue tripled in May 2024.', '2024 年 6 月收入增至 3 倍。', false],
    ['Revenue tripled in May 2024; costs tripled in June 2025.', '2025 年 5 月收入增至 3 倍；2024 年 6 月成本增至 3 倍。', false],
    ['Revenue tripled from $10M to $30M.', '收入从 $11M 增至 $30M，为原来的 3 倍。', false],
    ['Revenue tripled.', '收入增加 3 倍。', false],
    ['Revenue tripled.', '收入增长了 3 倍。', false],
    ['Revenue tripled.', '收入提升 3 倍。', false],
    ['Revenue tripled.', '收入翻了 3 倍。', false],
    ['Revenue tripled.', '收入增长 2 倍。', false],
    ['Revenue tripled.', '收入增至约 3 倍。', false],
    ['Revenue tripled.', '收入超过 3 倍。', false],
    ['Revenue tripled.', '收入增至 3 倍以上。', false],
    ['Revenue tripled.', '收入增至 -3 倍。', false],
    ['Revenue tripled.', '收入增至 +3 倍。', false],
    ['Revenue tripled; cash flow was -$10M.', '收入增至 3 倍；现金流为 $10M。', false],
    ['Revenue tripled; cash flow was ($10 million).', '收入增至 3 倍；现金流为 $10M。', false],
    ['Revenue tripled; the earlier multiple was 2x.', '收入增至 2–3 倍。', false],
    ['Revenue nearly tripled.', '收入接近 3 倍。', false],
    ['Revenue more than tripled.', '收入超过 3 倍。', false],
    ['Revenue tripled and costs doubled.', '收入增至 3 倍，成本上升。', false],
    ['The company tripled down on its strategy.', '公司投入增至 3 倍。', false],
    ['The company reports triple-digit growth.', '公司披露增长至 3 倍。', false],
    ['The company produces triple-A games.', '公司生产 3 倍游戏。', false],
    ['The company sold its portfolio to Triple Ventures.', '公司向 Triple Ventures 出售投资组合，规模为 3 倍。', false],
    ['Tripled.com reports the metrics.', 'Tripled.com 披露 3 倍指标。', false],
  ].map(([en, zh, resolved]) => [
    !checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation') === resolved,
    `verbal tripling fallback preserves complete quantities without inferring unsupported forms: ${en} / ${zh}`,
  ]),
  ...[
    ['The platform automates the claims lifecycle through eligibility verification, claims submission, and payment posting.', '平台自动化处理理赔生命周期，涵盖资格核验、理赔提交和回款入账。'],
    ['API-based claim creation, claim submission, and billing services support providers.', '基于 API 的理赔创建、理赔提交和账单服务面向医疗机构。'],
    ['Eligibility, claim submission, coding, payment posting, collections.', '资格核验、理赔提交、编码、回款入账和催收。'],
    ['The platform processes about $7 billion of annual claim volume.', '平台每年处理约 $7 billion 理赔额。'],
    ['The estimate applies a fee rate to $7 billion of processed claims.', '估算将费率用于 $7 billion 已处理理赔额。'],
    ['Candid reports ~$7B claims/year.', 'Candid 披露每年约 $7B 理赔额。'],
    ['Claim/remit transactions and claims/denial management are core workflows.', '理赔 / 汇款交易及理赔 / 拒付管理是核心流程。'],
    ['Claim volume is disclosed separately from revenue.', '理赔规模与收入分开披露。'],
    ['Claims submitted, checked, corrected, and tracked through APIs.', '理赔单经 API 提交、校验、修正和跟踪。'],
    ['Claims are submitted through the encounter / claim workflow.', '理赔单经就诊 / 理赔工作流提交。'],
    ['Embedded billing, claims, coding, and collections tools.', '嵌入式账单、理赔、编码和催收工具。'],
    ['Eligibility, authorizations, claims, remits, portal and APIs.', '资格核验、授权、理赔、汇款通知、门户和 API。'],
    ['Encounter, claim, and financial APIs support integrations.', '就诊、理赔和财务 API 支持集成。'],
    ['Customers integrate encounter and claim APIs.', '客户集成就诊和理赔 API。'],
    ['Rapid visit and claim growth stresses billing infrastructure.', '就诊和理赔量快速增长，增加了账单基础设施的压力。'],
    ['Data is propagated to claims.', '数据传递到理赔单。'],
    ['Pre-encounter endpoints manage patients and coverages and propagate data to claims.', '就诊前端点管理患者和保险覆盖，并把数据传递到理赔单。'],
    ['The platform connects the insurance journey from policy to claims.', '平台连接从保单到理赔的保险流程。'],
    ['The data platform expands from genomics to claims.', '数据平台从基因组学扩展至理赔数据。'],
    ['Billers resubmit claims by hand; payers adjudicate claims.', '账单员手动重新提交理赔单，支付方作出理赔裁定。'],
    ['Customers can scale claims quickly.', '客户可以快速扩大理赔量。'],
    ['The outage affects claims and reimbursements.', '中断影响理赔和报销。'],
    ['The platform showed that claims infrastructure can fail.', '平台表明理赔基础设施可能失效。'],
    ['Rules and automation to claim creation; minimum claim submission requirements.', '用于理赔创建的规则和自动化；最低理赔提交要求。'],
    ['Care models where claim visibility matters require integration.', '理赔可见性重要的医疗服务模式需要集成。'],
    ['Public evidence omits uptime, claims accuracy, concentration, and incident data.', '公开证据缺少可用性、理赔准确率、集中度和事故数据。'],
    ['No public Candid uptime, claims accuracy, or incident history is available.', 'Candid 的可用性、理赔准确率和事故历史没有公开。'],
    ['Transaction routing, claim status, remittance, payer portal automation.', '交易路由、理赔状态、汇款通知和支付方门户自动化。'],
    ['Configured rules, claim context, payer policies, model evaluation.', '已配置规则、理赔上下文、支付方政策和模型评估。'],
    ['Staff translate encounter data into payer-ready claims and manually correct issues.', '员工将就诊数据转成可提交给支付方的理赔单，并手动纠错。'],
    ['Direct customer case study; claims submission and reporting.', '直接客户案例；理赔提交和报告。'],
    ['One partner channel dominates revenue or claim volume.', '一个合作渠道主导收入或理赔量。'],
    ['Capital is disclosed; claims volume is approximate.', '融资已披露；理赔量为近似值。'],
    ['The platform handles sensitive data and claims workflows.', '平台处理敏感数据和理赔工作流。'],
    ['False-positive claim corrections matter; this matters: claims automation requires reliability.', '误报的理赔纠正很重要；理赔自动化需要可靠性。'],
  ].flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
        .every((issue) => issue.code !== 'hedge-preservation'),
      `medical billing nouns do not require invented attribution (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`${en} The company claims accuracy is superior.`), fullReport(`${zh} 准确率更高。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `medical nouns must retain separate accuracy assertions (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    'The company claims submission is automated.',
    'Candid claims accuracy exceeds expectations.',
    'The provider claims growth is strong.',
    'The company reviews billing and claims accuracy improved.',
    'The company supports eligibility, claims submission is always correct.',
    'The platform that claims accuracy is superior has no audit.',
    'The company wants to claim creation is automated.',
    'A 180% NDR claim is powerful only if calculated on a durable cohort.',
    'Claimed scale through claim volume is not audited.',
    'The platform automates claims submission, but claimed scale is not audited.',
    'Accuracy, safety, and service reliability must catch up to claims.',
    'Lost customer accounts are tied to claims.',
  ].flatMap((en) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport('理赔流程已自动化，规模较大。这是尽调观察。'), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `explicit claims and claimed scale still require attribution (strict=${strictEditor}): ${en}`,
  ])),
  ...[
    ['Gross margin remains unproven.', '毛利率仍未经证明。', false],
    ['Gross margin remains unproven.', '毛利率尚未经证明。', false],
    ['Gross margin remains unproven.', '毛利率并非未经证明。', true],
    ['Gross margin remains unproven.', '毛利率不是尚未经证明。', true],
    ['Likely entrants already operate adjacent workflows.', '潜在进入者已在经营相邻工作流。', false],
    ['The list includes likely-entry categories.', '列表包含潜在进入者类别。', false],
    ['The company is likely profitable.', '公司有潜在进入者，并且盈利。', true],
    ['Likely entrants are visible, and margins are likely high.', '潜在进入者已出现，利润率很高。', true],
    ['Likely entrants already operate adjacent workflows.', '这些公司并非潜在进入者。', true],
    ['Likely entrants already operate adjacent workflows.', '这些公司属于非潜在进入者。', true],
    ['Likely entrants already operate adjacent workflows.', '这里不存在潜在进入者。', true],
    ['Likely entrants already operate adjacent workflows.', '这些公司不属于潜在进入者。', true],
    ['No public Candid enforcement found.', '未发现 Candid 公开执法事项。', false],
    ['No public Candid enforcement found.', '没有发现 Candid 公开执法事项。', false],
    ['No public Candid enforcement found.', '并非未发现 Candid 公开执法事项。', true],
    ['No public Candid enforcement found.', '没有发现其他问题；Candid 公开执法事项已披露。', true],
  ].flatMap(([en, zh, missing]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === missing,
    `proof, potential-entry and named-company evidence gaps remain scoped (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The public /platform page failed during the review.', '审阅时，公开 /platform 页面出错。', false],
    ['The public /platform/revenue page failed during the review.', '审阅时，公开 /platform/revenue 页面出错。', false],
    ['The public /platform page failed during the review.', '审阅时，公开 platform 页面出错。', true],
    ['The public page failed during the review.', '审阅时，公开 /platform 页面出错。', true],
    ['The public /platform page failed during the review.', '审阅时，/pricing 页面出错。', true],
    ['The public /platform page describes the product.', '/platform 页面介绍这款 product。', true],
    ['Est. $100,000-$500,000+/enterprise/year; per-forest model.', '估计 $100,000-$500,000+/enterprise/year；按 AD 林计价。', true],
    ['Subscription price: $100 /enterprise/year.', '订阅价格：$100 /enterprise/year。', true],
    ['Subscription price: $100K /enterprise/year.', '订阅价格：$100K /enterprise/year。', true],
  ].map(([en, zh, leaked]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'descriptor-leak') === leaked,
    `only source-identical relative routes are exempt from descriptor warnings: ${zh}`,
  ]),
  ...[
    ['风险在于，公开控制仍是政策层面的，而不是实施证明。', false],
    ['问题在于：这些承诺仍停留于政策层面。', false],
    ['团队在政策层面补充了控制要求。', true],
    ['风险在于，数据不完整；团队在政策层面补充了要求。', true],
  ].map(([zh, flagged]) => [
    checkPairQuality(fullReport('Public controls remain policy-level rather than implementation-level proof.'), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'editor-translationese') === flagged,
    `the level-based soundcheck must stay within a clause: ${zh}`,
  ]),
  ...[
    ['The network covers 35,000 businesses and processes 30 million-plus events, scaling to 60,000-plus events per day.', '网络覆盖 3.5 万家企业，处理超过 3000 万起事件，每天可扩展至 6 万起以上。'],
    ['The platform processes 30 million-plus events.', '平台处理 3000 万起以上事件。'],
    ['The network covers 35,000 businesses and 1M users.', '网络覆盖 3.5 万家企业和 100 万名用户。'],
    ['The network covers 35,000 businesses and 1M users.', '网络覆盖 35000 家企业和 100 万名用户。'],
    ['The network covers 35000 businesses and 1M users.', '网络覆盖 35,000 家企业和 100 万名用户。'],
    ['The platform processes 30 million-plus events for 1,000 customers.', '平台为 1000 家客户处理 3000 万起以上事件。'],
    ['The network covers 35,000 businesses and 1M users in April 2025.', '2025 年 4 月，网络覆盖 3.5 万家企业和 100 万名用户。'],
    ['The sample includes 1,000 records and 1,000 records from 1M events.', '样本包含来自 100 万起事件的 0.1 万条记录和 0.1 万条记录。'],
    ['The archive contains 9,007,199,254,740,993 records and 1M samples.', '档案包含 900719925474.0993 万条记录和 100 万个样本。'],
    ['2,227 arrest-producing calls; 417 firearms seized.', '2,227 起带来逮捕的呼叫；缴获 417 支枪支。'],
    ['Over 1,000 XHAND units shipped in 2025.', '2025 年 XHAND 出货超过 1,000 台。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `grouped integer counts and word-plus counts must retain exact values: ${zh}`,
  ]),
  ...[
    ['The network covers 35,000 businesses and 1M users.', '网络覆盖 3.6 万家企业和 100 万名用户。'],
    ['The platform processes 30 million-plus events.', '平台处理 300 万起以上事件。'],
    ['The sample includes 1,000 records and 1,000 records from 1M events.', '样本包含来自 100 万起事件的 0.1 万条记录。'],
    ['The archive contains 9,007,199,254,740,993 records and 1M samples.', '档案包含 900719925474.0992 万条记录和 100 万个样本。'],
    ['The network covers 35,000 businesses and 1M users in April 2025.', '2025 年 5 月，网络覆盖 3.5 万家企业和 100 万名用户。'],
    ['The change is -35,000 events and 1M users.', '变化为 3.5 万起事件和 100 万名用户。'],
    ['The interval covers 30,000–35,000 events and 1M users.', '区间覆盖 3–3.5 万起事件和 100 万名用户。'],
    ['The change is -30 million-plus events.', '变化为 3000 万起以上事件。'],
    ['The expression is 30 million-plus-2 million events.', '结果为 3000 万起事件。'],
    ['The result is 35,000% and 1M users.', '结果为 3.5 万和 100 万名用户。'],
    ['The result is 35,000 ARR and 1M users.', '结果为 3.5 万和 100 万名用户。'],
    ['The result is 1,000 x the baseline.', '结果为 0.1 万。'],
    ['The total is 35,000 M events and 1M users.', '总计 3.5 万起事件和 100 万名用户。'],
    ['The total is 35,000 千亿条记录和 1M users.', '总计 3.5 万条记录和 100 万名用户。'],
    ['The accounts show (35,000) and 1M users.', '账目显示 3.5 万和 100 万名用户。'],
    ['Fees are USD 35,000 and the platform serves 1M users.', '费用为 3.5 万，平台服务 100 万名用户。'],
    ['Fees are 35,000 dollars and the platform serves 1M users.', '费用为 3.5 万，平台服务 100 万名用户。'],
    ['The network covers 35,000 businesses and 1M users.', '规模为 USD 3.5 万，覆盖 100 万名用户。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `grouped-count comparison must reject changed values and unsupported units, signs or ranges: ${zh}`,
  ]),
  ...[
    ['Official materials show product coverage across claims intake and orchestration.', '官方材料显示产品覆盖理赔受理和编排。'],
    ['The buyer wants a claims platform with integration support.', '买方需要支持集成的理赔平台。'],
    ['The workflow captures claim facts and signatures.', '工作流采集赔案事实和签名。'],
    ['Revenue depends on claims volume and fixed commitments.', '收入取决于理赔量和固定承诺。'],
    ['Claims automation addresses an urgent insurer pain point.', '理赔自动化解决保险公司的迫切痛点。'],
    ['The platform supports claims automation but not image estimation.', '平台支持理赔自动化，但不支持图像估算。'],
    ['Claims-system-of-record tooling has embedded AI.', '理赔记录系统工具内嵌 AI。'],
    ['P&C claims-processing spend is a dedicated market.', 'P&C 理赔处理支出是一个专门市场。'],
    ['Insurance claims processing requires customer support.', '保险理赔处理需要客户支持。'],
    ['The service works across claims; the budget excludes underwriting.', '服务覆盖赔案；预算不含承保。'],
    ['The carrier knows claims is important for retention.', '保险公司知道理赔对留存很重要。'],
    ['Claims plus broader policy and billing modules form the core.', '理赔与更广的保单和计费模块构成核心。'],
    ['Claim, photo, location, device, communications, and career data practices.', '赔案、照片、位置、设备、通信和求职数据处理做法。'],
    ['The company positions itself as AI-native claims infrastructure for insurers.', '公司将自己定位为保险公司的 AI 原生理赔基础设施。'],
    ['The workflow converts messy claim intake into structured data.', '工作流把杂乱的理赔受理转成结构化数据。'],
    ['Carriers move a claim from FNOL through triage and documentation.', '保险公司将赔案从 FNOL 推进到分流和文档处理。'],
    ['Many carriers rely on legacy claim systems with human adjusters.', '许多保险公司依赖传统理赔系统和人工理赔员。'],
    ['IT acts as gatekeeper because claims platforms require integration.', '理赔平台需要集成，因此 IT 负责把关。'],
    ['Unlike speculative AI use cases, claims automation ties to cycle time.', '不同于推测性的 AI 用例，理赔自动化与处理周期挂钩。'],
    ['It competes for claims-operating budget, not premiums.', '它争取的是理赔运营预算，而不是保费。'],
    ['An existing claims stack can support better claims automation.', '现有理赔系统组合可以支持更好的理赔自动化。'],
    ['The chief claims officer approves the carrier budget.', '首席理赔官审批保险公司的预算。'],
    ['Tens-of-millions claim volume suggests real deployment.', '数千万级理赔量说明产品已实际部署。'],
    ['Modern full claims system with integrated payments and no-code tools.', '现代化完整理赔系统，集成支付和无代码工具。'],
    ['Enterprise claims sales can have a long cycle.', '企业理赔软件的销售周期可能很长。'],
    ['No public claims list price is available for the cloud contract.', '云合同没有公开理赔产品标价。'],
    ['Incumbent claims platforms and adjacent AI vendors compete for carrier budgets.', '既有理赔平台和相邻 AI 供应商争夺保险公司的预算。'],
    ['Cloud-native full claims platform with intelligent automation.', '云原生完整理赔平台，配备智能自动化。'],
    ['The model bridges from pilot claims volume into broader module adoption.', '该模式从试点理赔量过渡到更广泛的模块采用。'],
    ['Value is aligned to claims throughput rather than fixed seats.', '价值与理赔吞吐量挂钩，而不是固定席位。'],
    ['Shows incumbent cloud claims scale for buyers comparing readiness.', '向比较就绪度的买方展示既有云理赔规模。'],
    ['Insurers can build more automated claims journeys internally.', '保险公司可以在内部构建更自动化的理赔旅程。'],
    ['The proof concerns digital and AI-native claims possibilities.', '证据涉及数字化与 AI 原生理赔的可能性。'],
    ['Carriers solve communications, appraisal, or cloud claims operations without replacing the stack.', '保险公司无需替换现有系统，就能解决沟通、定损或云理赔运营问题。'],
  ].flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor }).length === 0,
      `insurance noun context does not assert a company claim (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`${en} The company claims performance is superior.`), fullReport(`${zh} 性能更优。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `insurance noun context must retain a separate assertion (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    ['The company is valuable but not proven enough to deserve a premium.', '公司有价值，但还不足以证明应享有溢价。', false],
    ['The company is valuable but not proven enough to deserve a premium.', '公司有价值，已经证明应享有溢价。', true],
    ['The company is valuable but not proven enough to deserve a premium.', '公司有价值，并非还不足以证明应享有溢价。', true],
    ['No public third-party reviews on G2 or Capterra were found.', '没有发现 G2 或 Capterra 上的公开第三方评价。', false],
    ['No public third-party reviews on G2 or Capterra were found.', '已经发现 G2 或 Capterra 上的公开第三方评价。', true],
    ['No public third-party reviews on G2 or Capterra were found.', '并非没有发现 G2 或 Capterra 上的公开第三方评价。', true],
    ['No public third-party reviews on G2 or Capterra were found.', '没有发现其他问题；G2 或 Capterra 上的公开第三方评价已经发布。', true],
  ].flatMap(([en, zh, missing]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === missing,
    `insufficient-proof and review-site gaps must stay scoped and negative (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    'The company claims automation improves retention.',
    'Assured claims intake quality is superior.',
    'Analysts claim volume will grow.',
    'The insurer claims platforms are more reliable.',
    'The enterprise claims workflow coverage is complete.',
    'The incumbent claims platforms improve retention.',
    'The platform that claims automation is safe has no audit.',
    'The vendor claims insurance claims processing is more accurate.',
    'Claims automation is valuable, and the company claims it leads.',
  ].flatMap((en) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport('理赔自动化表现更好。这是尽调观察。'), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `ambiguous or explicit assertion contexts must not be discarded (strict=${strictEditor}): ${en}`,
  ])),
  ...[
    ['AI-driven prior authorization; billing documentation; claim validation.', 'AI 驱动的事前授权；账单文档；理赔验证。'],
    ['Claims denial reduction data not independently verified; coders still review.', '理赔拒付减少数据未经独立核验；编码员仍需审核。'],
    ['These are not marketing claims: the engineering posts describe the model architecture.', '这些不是营销口号：工程文章介绍了模型架构。'],
  ].flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor }).length === 0,
      `claim-validation nouns and negated marketing claims do not require invented attribution (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`${en} The company claims it performs better.`), fullReport(`${zh} 它表现更好。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `a separate company assertion still needs attribution (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    ['Stage values are company-stated aggregate claims, not verified funnel metrics.', '阶段数值是公司披露的汇总口径，不是经验证的漏斗指标。', false],
    ['Stage values are company-stated aggregate claims, not verified funnel metrics.', '阶段数值是汇总结果，不是经验证的漏斗指标。', true],
    ['Stage values are company-stated aggregate claims, not verified funnel metrics.', '阶段数值并非公司披露的汇总口径，不是经验证的漏斗指标。', true],
  ].flatMap(([en, zh, missing]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === missing,
    `aggregate figures must retain company attribution (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['No public disclosure exists for these private metrics.', '这些私有指标在公开渠道没有披露。', '这些私有指标在公开渠道已经披露。'],
    ['No public pricing page exists as of June 2026.', '截至 2026 年 6 月，公开渠道没有定价页。', '截至 2026 年 6 月，公开渠道有定价页。'],
    ['No public SOC 2 report is referenced on the website.', '官网未提及公开 SOC 2 报告。', '官网提及公开 SOC 2 报告。'],
    ['No public disclosure explains consent verification.', '公开披露未说明如何验证同意。', '公开披露说明了如何验证同意。'],
    ['No public contract terms between the two parties have been disclosed.', '双方未披露任何公开合同条款。', '双方已披露公开合同条款。'],
    ['There is no public mechanism to verify this valuation.', '公开层面没有机制能验证这一估值。', '公开层面有机制能验证这一估值。'],
    ['There is no public succession or deputy layer.', '公开资料不显示继任或副手层。', '公开资料显示继任或副手层。'],
  ].flatMap(([en, zh, reversed]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor }).length === 0,
      `scoped public-disclosure gaps must pass (strict=${strictEditor}): ${zh}`,
    ],
    [
      checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${reversed} 这是尽调观察。`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `positive disclosure must not satisfy an evidence gap (strict=${strictEditor}): ${reversed}`,
    ],
  ])),
  ...[
    '并非公开渠道没有披露。',
    '并非未提及公开报告。',
    '并非公开披露未说明如何验证同意。',
    '并非未披露任何公开合同条款。',
    '并非公开层面没有机制。',
    '并非公开资料不显示继任层。',
    '公开渠道很广；内部没有披露。',
    '未提及内部问题；公开报告已经发布。',
  ].flatMap((zh) => [false, true].map((strictEditor) => [
    checkPairQuality(
      fullReport('No public disclosure provides the necessary evidence for verification.'),
      fullReport(`${zh} 这是尽调观察。`),
      { strictEditor },
    ).some((issue) => issue.code === 'hedge-preservation'),
    `negated or unrelated gaps must not establish absence of public evidence (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['No public financing event has been disclosed.', '没有披露任何公开融资事件。', false],
    ['No public financing event has been disclosed.', '已经披露公开融资事件。', true],
    ['No public financing event has been disclosed.', '并非没有披露任何公开融资事件。', true],
    ['No public financing event has been disclosed.', '没有披露任何问题；公开融资事件已经披露。', true],
    ['Capital adequacy is opaque: no public financial metrics for verification.', '资本充足度不透明：没有可验证的公开财务指标。', false],
    ['Capital adequacy is opaque: no public financial metrics for verification.', '资本充足度不透明：有可验证的公开财务指标。', true],
    ['Capital adequacy is opaque: no public financial metrics for verification.', '资本充足度不透明：并非没有可验证的公开财务指标。', true],
    ['Capital adequacy is opaque: no public financial metrics for verification.', '没有可验证的结论；公开财务指标已经披露。', true],
  ].flatMap(([en, zh, missing]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === missing,
    `public-evidence wording must preserve absence in the same clause (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Aiven differentiates itself for regulated enterprise buyers.', '在受监管企业买方面前，Aiven 能体现差异。', false],
    ['The company presents evidence to the buyer.', '公司在买方面前展示证据。', false],
    ['The company has a compliance advantage.', '公司在合规方面具备优势。', true],
    ['The company has promising technology prospects.', '公司在技术方面前景可期。', true],
    ['The company discusses compliance with the buyer.', '公司在买方面前说明在合规方面的优势。', true],
  ].flatMap(([en, zh, awkward]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'translationese') === awkward,
    `buyer-facing wording is not the in-an-area construction (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The revenue threshold is $50M.', '收入门槛为 5,000 万美元。'],
    ['Revenue reaches $50M.', '收入达到 5,000 万美元。'],
    ['The valuation is $1.2 billion.', '估值为 12 亿美元。'],
    ['The company has $50M, before any additional financing.', '公司拥有 5,000 万美元，尚未计入任何新增融资。'],
    ['Revenue is $0.000001M.', '收入为 1 美元。'],
    ['Revenue is $9007199254740993.', '收入为 9007199254740993 美元。'],
    ['Revenue was $10M; the comparison also uses $10M.', '收入为 1,000 万美元；比较也使用 1,000 万美元。'],
    ['January 2026 revenue was $50M; December 2023 revenue was $10M.', '2026 年 1 月收入为 5,000 万美元；2023 年 12 月收入为 1,000 万美元。'],
    ['Revenue is £10M and capital is $5M.', '收入为 £10M，资本为 500 万美元。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `exact positive dollar scalars must match without losing precision or other anchors: ${zh}`,
  ]),
  ...[
    ['The revenue threshold is $50M.', '收入门槛为 500 万美元。'],
    ['The revenue threshold is $50M.', '收入门槛为 5,000 万元。'],
    ['The revenue threshold is AUD $50M.', '收入门槛为 5,000 万美元。'],
    ['The revenue threshold is $50M CAD.', '收入门槛为 5,000 万美元。'],
    ['The source labels the threshold EUR $50M.', '收入门槛为 5,000 万美元。'],
    ['Revenue is $9007199254740993.', '收入为 9007199254740992 美元。'],
    ['Revenue was $10M; the comparison also uses $10M.', '收入为 1,000 万美元。'],
    ['Revenue is -$50M.', '收入为 5,000 万美元。'],
    ['Revenue is $50M.', '收入为负 5,000 万美元。'],
    ['Revenue ranges from $5–10M.', '收入为 5 至 10 万美元。'],
    ['Revenue is $50M from 42 customers.', '收入为 5,000 万美元，来自 41 家客户。'],
    ['January 2026 revenue was $50M; December 2023 revenue was $10M.', '2026 年 12 月收入为 5,000 万美元；2023 年 1 月收入为 1,000 万美元。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `dollar normalization must not accept changed amounts, currencies, counts, dates or unsupported signs/ranges: ${zh}`,
  ]),
  ...[
    ['Annual administrative cost is 1.5 trillion dollars.', '每年行政成本为 1.5 万亿美元。', false],
    ['Revenue is 50 million dollars.', '收入为 5000 万美元。', false],
    ['Revenue is 1.234567890123 billion dollars.', '收入为 12.34567890123 亿美元。', false],
    ['Revenue is 50 million dollars from 42 customers.', '收入为 5000 万美元，来自 42 家客户。', false],
    ['Revenue is 50 million dollars; capital is 50 million dollars.', '收入为 5000 万美元；资本为 5000 万美元。', false],
    ['April 2025 revenue was 50 million dollars; May 2026 revenue was 10 million dollars.', '2025 年 4 月收入为 5000 万美元；2026 年 5 月收入为 1000 万美元。', false],
    ['Annual administrative cost is 1.5 trillion dollars.', '每年行政成本为 1.5 亿美元。', true],
    ['Annual administrative cost is 1.5 trillion dollars.', '每年行政成本为 1.5 万亿元。', true],
    ['Annual administrative cost is 1.5 trillion dollars.', '每年行政成本为 1.5 万亿加元。', true],
    ['Revenue is 1.234567890123 billion dollars.', '收入为 12.34567890124 亿美元。', true],
    ['Revenue is 50 million dollars from 42 customers.', '收入为 5000 万美元，来自 41 家客户。', true],
    ['Revenue is 50 million dollars; capital is 50 million dollars.', '收入与资本为 5000 万美元。', true],
    ['April 2025 revenue was 50 million dollars; May 2026 revenue was 10 million dollars.', '2025 年 5 月收入为 5000 万美元；2026 年 4 月收入为 1000 万美元。', true],
    ['Revenue is -50 million dollars.', '收入为 5000 万美元。', true],
    ['Revenue is 50 million dollars.', '收入为负 5000 万美元。', true],
    ['Losses are (50 million dollars).', '亏损为 5000 万美元。', true],
    ['Revenue ranges from 5 to 10 million dollars.', '收入为 5 至 1000 万美元。', true],
    ['Revenue is CAD 50 million dollars.', '收入为 5000 万美元。', true],
    ['Revenue is 50 million dollars (CAD).', '收入为 5000 万美元。', true],
    ['Revenue is Canadian 50 million dollars.', '收入为 5000 万美元。', true],
    ['Revenue is 50 million Australian dollars.', '收入为 5000 万美元。', true],
    ['There are 1.5 million Dollar General customers.', '金额为 150 万美元。', true],
  ].map(([en, zh, mismatch]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation') === mismatch,
    `English dollars suffixes retain exact amounts, currency, counts and paired dates: ${en} / ${zh}`,
  ]),
  ...[
    ['The revenue mix is 50/50 enterprise and self-serve.', '企业与自助服务收入各占一半。', false],
    ['The customer mix by revenue is approximately 50/50 enterprise and self-serve.', '企业与自助服务收入约各占一半。', false],
    ['Revenue is split 50 / 50 between enterprise and self-serve.', '企业与自助服务收入各占一半。', false],
    ['Revenue is split 50/50. Costs are split 50/50.', '两类收入各占一半。两类成本各占一半。', false],
    ['The customer split is 50/50 across 42 customers.', '两类客户各占一半，共 42 家。', false],
    ['The revenue split was 50/50 in April 2025 and May 2026.', '2025 年 4 月及 2026 年 5 月，两类收入各占一半。', false],
    ['The split is 60/40.', '两类收入各占一半。', true],
    ['The split is 50/50.', '两类收入分别占五成和四成。', true],
    ['The split is 50/50.', '两类收入各占一半以上。', true],
    ['The split is 50/50.', '两类收入并非各占一半。', true],
    ['The split is 50/50.', '两类收入各占一半并非事实。', true],
    ['The split is not 50/50.', '两类收入各占一半。', true],
    ['A 50/50 split is not established.', '两类收入各占一半。', true],
    ["A 50/50 split isn't established.", '两类收入各占一半。', true],
    ['A 50/50 split isn’t established.', '两类收入各占一半。', true],
    ['A 50/50 split cannot be confirmed.', '两类收入各占一半。', true],
    ['The split is 50/50.', '两类收入各占一半尚无证据。', true],
    ['There is no basis to decide whether the revenue split is 50/50.', '两类收入各占一半。', true],
    ['The company proceeds without evidence of a 50/50 split.', '两类收入各占一半。', true],
    ['The 50/50 revenue split is unproven.', '两类收入各占一半。', true],
    ['If the split is 50/50, the plan works.', '两类收入各占一半，计划可行。', true],
    ['The split is 50/50.', '假设两类收入各占一半。', true],
    ['The revenue split approaches 50/50.', '两类收入各占一半。', true],
    ['The revenue split is 50/50.', '两类收入预计各占一半。', true],
    ['Is the revenue split 50/50?', '两类收入各占一半。', true],
    ['The revenue split is 50/50.', '两类收入各占一半？', true],
    ['The split is at least 50/50.', '两类收入各占一半。', true],
    ['Revenue is split 50/50. Costs are split 50/50.', '两类收入各占一半。', true],
    ['The customer split is 50/50 across 42 customers.', '两类客户各占一半，共 41 家。', true],
    ['The revenue split was 50/50 in April 2025 and May 2026.', '2025 年 5 月及 2026 年 4 月，两类收入各占一半。', true],
    ['The formula is -50/50.', '两类收入各占一半。', true],
    ['The split is 150/50.', '两类收入各占一半。', true],
    ['The split is 50/500.', '两类收入各占一半。', true],
    ['The split is 50/50/50.', '两类收入各占一半。', true],
    ['The route is /50/50.', '两类收入各占一半。', true],
    ['The file is 50/50.txt.', '两类收入各占一半。', true],
    ['The URL is https://example.com/?ratio=50/50.', '两类收入各占一半。', true],
    ['The balance is -$5M and the split is 50/50.', '余额为 $5M，两类收入各占一半。', true],
    ['There are 25 clients and the revenue split is 50/50.', '客户共有 2各占一半5 家。', true],
    ['The split is 50/50 across 5M users.', '用户数为 5各占一半M。', true],
    ['The balance is $5M and the split is 50/50.', '余额为 $各占一半5M。', true],
  ].map(([en, zh, mismatch]) => [
    checkPairQuality(
      fullReport(`The platform serves 1M users. ${en}`),
      fullReport(`平台服务 100 万名用户。${zh}`),
      { strictEditor: true },
    ).some((issue) => issue.code === 'metric-preservation') === mismatch,
    `explicit half-share aliases retain ratio occurrences and all other numeric anchors: ${en} / ${zh}`,
  ]),
  ...[
    ['No public conformity assessment has been disclosed for this system.', '未见任何公开的系统合规评估披露。', false],
    ['No public conformity assessment has been disclosed for this system.', '已见公开的系统合规评估披露。', true],
    ['No public conformity assessment has been disclosed for this system.', '并非未见任何公开的系统合规评估披露。', true],
    ['No public conformity assessment has been disclosed for this system.', '未见任何问题；系统的公开合规评估已经披露。', true],
  ].flatMap(([en, zh, missing]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation') === missing,
    `any-public-evidence wording must retain the scoped absence (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Point estimate for fiscal 2026 ER&D', 'FY26 ER&D 点估计'],
    ['The FY2026 revenue estimate is $10M.', 'FY26 收入估计为 $10M。'],
    ['The fiscal year 2026 revenue estimate is $10M.', 'FY 26 收入估计为 $10M。'],
    ['Investors can see the path, but not yet the proof. Execution still matters.', '投资人能看见路径，但还看不到证明。执行仍然重要。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `source-anchored fiscal shorthand and missing-proof wording must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Point estimate for fiscal 2026 ER&D', 'FY27 ER&D 点估计', 'year-preservation'],
    ['Point estimate for fiscal 2026 ER&D', 'FY1926 ER&D 点估计', 'year-preservation'],
    ['Point estimate for fiscal 2026 ER&D', 'FY260 ER&D 点估计', 'year-preservation'],
    ['Point estimate for calendar 2026 ER&D', 'FY26 ER&D 点估计', 'year-preservation'],
    ['Compare fiscal 1926 with fiscal 2026 ER&D.', '比较 FY26 与 FY26 的 ER&D。', 'year-preservation'],
    ['The FY2026 revenue estimate is $10M.', 'FY26 收入估计为 $11M。', 'metric-preservation'],
    ['Investors can see the path, but not yet the proof. Execution still matters.', '投资人能看见路径，也看到了证明。执行仍然重要。', 'hedge-preservation'],
    ['Investors can see the path, but not yet the proof. Execution still matters.', '并非还看不到证明；投资人已有证据。执行仍然重要。', 'hedge-preservation'],
  ].flatMap(([en, zh, code]) => (code === 'metric-preservation' ? [true] : [false, true]).map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).some((issue) => issue.code === code),
    `shorthand must not infer ambiguous years, alter metrics or reverse missing proof (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The estimated revenue supports the valuation discussion.', '预估收入为估值讨论提供参考。'],
    ['Analysts estimate revenue from the available disclosures.', '分析师根据现有披露预估收入。'],
    ['Inferred from high retention + $72 ARPU + hardware margin; likely >3x', '由高留存率 + $72 ARPU + 硬件毛利推断；预计超 3 倍'],
    ['Given $1B+ raised since late 2024 and stated profitability, likely substantial', '鉴于 2024 年底以来融资逾 $1B 且声称盈利，预计现金储备可观'],
    ['The cash balance is probably substantial given recent financing.', '考虑到近期融资，预计现金储备可观。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor }).length === 0,
    `reviewed estimate and likelihood wording must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The estimated revenue supports the valuation discussion.', '收入为估值讨论提供参考。'],
    ['The estimated revenue supports the valuation discussion.', '收入并非预估，而是已核实的数字。'],
    ['The estimated revenue supports the valuation discussion.', '收入未经预估，已核实数字。'],
    ['The cash balance is likely substantial given recent financing.', '考虑到近期融资，现金储备可观。'],
    ['The cash balance is probably substantial given recent financing.', '无需预计，现金储备可观。'],
    ['The cash balance is likely substantial given recent financing.', '没有预计现金储备，而是已经核实。'],
    ['The cash balance is likely substantial but not yet audited.', '预计现金储备可观，且已经审计。'],
    ['Reportedly, the estimated revenue supports the valuation discussion.', '预估收入为估值讨论提供参考。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `estimate aliases must not conceal certainty, negation or another missing qualifier (strict=${strictEditor}): ${zh}`,
  ])),
  ...legalClaimNounPairs.flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
      `legal/insurance claims nouns are not assertion qualifiers (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(
        fullReport(`${en} The company claims performance is superior.`),
        fullReport(`${zh} 性能更优。`),
        { strictEditor },
      ).some((issue) => issue.code === 'hedge-preservation'),
      `a legal claims noun must not conceal a separate omitted company assertion (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    ['The company claims setup takes one day.', '设置耗时一天。'],
    ['Analysts claim numbers are incorrect.', '数字不正确。'],
    ['The company claims inflation is lower.', '通胀更低。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `ordinary claim verbs must still retain attribution (strict=${strictEditor}): ${en}`,
  ])),
  ...[
    ['Managed-service model unproven at scale; quality control risk.', '托管服务模式尚未规模化验证；质量控制风险。'],
    ['No public third-party audit of OCR error rates; company benchmarks are self-reported.', '未见 OCR 错误率公开第三方审计；公司基准为自报。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor }).length === 0,
    `faithful scale-validation and object-specific audit gaps must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The managed-service model is unproven at scale.', '托管服务模式已规模化验证。'],
    ['The managed-service model is unproven at scale.', '托管服务模式并非尚未规模化验证。'],
    ['No public third-party audit of OCR error rates.', '已见 OCR 错误率公开第三方审计。'],
    ['No public third-party audit of OCR error rates.', '未见错误率下降；公开第三方审计已经完成。'],
    ['No public third-party audit of OCR error rates.', '并非未见 OCR 错误率公开第三方审计。'],
    ['No public third-party audit of OCR error rates.', '并非尚未见 OCR 错误率公开第三方审计。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(`${en} This is a diligence observation.`), fullReport(`${zh} 这是尽调观察。`), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `new evidence-gap aliases must not accept proven status, negation or another clause (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['v0 ARR is not disclosed.', 'v0 的 ARR 未披露。'],
    ['V0 MRR is $10M.', 'V0 的 MRR 为 $10M。'],
    ['v12 GMV is $25B.', 'v12 的 GMV 为 $25B。'],
    ['v0 ARR is $340M, but v0 expenses are unknown.', 'v0 的 ARR 为 $340M，但 v0 的费用未知。'],
    ['v0\\nARR is $340M.', 'v0 的 ARR 为 $340M。'],
    ['0 ARR was recorded for v0.', 'v0 录得 0 ARR。'],
    ['$0 ARR was recorded for v0.', 'v0 录得 $0 ARR。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `version-style product labels must not become metric quantities: ${zh}`,
  ]),
  ...[
    ['v0 ARR is $340M.', 'v0 的 ARR 为 $341M。'],
    ['v12 GMV is $25B.', 'v12 的 GMV 为 $25M。'],
    ['0 ARR was recorded for v0.', 'v0 的 ARR 未披露。'],
    ['$0 ARR was recorded for v0.', 'v0 录得 $1 ARR。'],
    ['v0 ARR is $10M and costs are $10M.', 'v0 的 ARR 为 $10M，成本未披露。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `product-label normalization must preserve actual metric values and occurrences: ${zh}`,
  ]),
  ...[
    ['The IPO window is unproven while public produce comparables trade below the implied premium.', 'IPO 窗口未跑通，上市农产品可比公司估值低于隐含溢价。'],
    ['Premium berry platform with an unproven path to a credible IPO multiple.', '高端浆果平台，但支撑可信 IPO 倍数的路径尚未跑通。'],
    ['Integration risk; unproven at Fruitist scale; quality consistency not yet validated.', '整合风险；尚未在 Fruitist 规模下验证；品质一致性仍未验证。'],
    ['Integration execution risk; quality consistency unproven at Fruitist standards.', '整合执行风险；品质一致性尚未按 Fruitist 标准验证。'],
    ['The process remains unproven in the reviewed industrial production environment.', '该流程尚未在工业生产环境中得到验证。'],
    ['Orders-to-revenue conversion is still unproven publicly; audited revenue is not disclosed.', '订单转收入尚无公开验证；审计收入未披露。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `faithful scoped absence of proof must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The IPO window is unproven while public produce comparables trade below the implied premium.', 'IPO 窗口已经跑通，上市农产品可比公司估值低于隐含溢价。'],
    ['The IPO window is unproven while public produce comparables trade below the implied premium.', 'IPO 窗口并非未跑通，上市农产品可比公司估值低于隐含溢价。'],
    ['Integration risk; unproven at Fruitist scale; quality consistency matters.', '整合风险；已经在 Fruitist 规模下验证；品质一致性重要。'],
    ['Integration execution risk; quality consistency unproven at Fruitist standards.', '整合执行风险；品质一致性已经按 Fruitist 标准验证。'],
    ['Integration execution risk; quality consistency unproven at Fruitist standards.', '整合执行风险；尚未按期发布，但品质一致性已经验证。'],
    ['The process remains unproven in the reviewed industrial production environment.', '该流程尚未在工业生产环境中销售，可靠性已经得到验证。'],
    ['Orders-to-revenue conversion is still unproven publicly; audited revenue is not disclosed.', '订单转收入已获公开验证；审计收入未披露。'],
    ['Orders-to-revenue conversion is still unproven publicly; audited revenue is not disclosed.', '订单转收入并非尚无公开验证；审计收入未披露。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `scoped proof aliases must not hide proven status or unrelated absence (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Asimov timing stays roughly on plan while the commercial ramp remains uncertain.', 'Asimov 时间大体按计划推进，商业化进度仍不确定。'],
    ['The company does not yet have public retention and migration evidence to justify a premium multiple.', '公司尚缺支撑溢价倍数所需的公开留存和迁移证据。'],
    ['Search speed claims are vendor-reported; cost and query ergonomics remain to be proved.', '搜索速度为厂商自述；成本和查询体验仍需验证。'],
    ['The base case broadly validates the price. Weighting the paths roughly 25/50/25 leaves expected value near the current mark.', '基准情景大体验证当前价格。路径粗略按 25/50/25 加权，期望值接近当前估值。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `faithful approximation, not-yet absence and vendor attribution must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['The market covers annual premium and claims expenditure across employer plans.', '市场覆盖雇主计划每年的保费和理赔支出。'],
    ['High-cost claim concentration increases the exposure of employer health plans.', '高额理赔集中加大了雇主健康计划的风险敞口。'],
    ['Million-dollar-plus claims grew rapidly across the reviewed employer health plans.', '在所审查的雇主健康计划中，百万美元以上理赔快速增长。'],
    ['Surgical COE and oncology navigation products address highest-ROI claims.', '手术 COE 和肿瘤导航产品切入 ROI 最高的理赔。'],
    ['Claims-data-driven physician ranking relies on extensive medical records.', '医生排名由理赔数据驱动，依赖广泛的医疗记录。'],
    ['12% claims cost reduction guarantee in year 1; incentive model is self-funding.', '保证第 1 年理赔成本降低 12%；激励模式可自我筹资。'],
    ['The platform combines real-time claims data with member benefit plan parameters.', '平台结合实时理赔数据与会员福利计划参数。'],
    ['API uptime and versioning across many point solution partners; claims data latency.', '多个单点方案伙伴的 API 可用性和版本管理；理赔数据延迟。'],
    ['The review identifies high-cost claim categories including surgery and cancer.', '审查识别出手术和癌症等高成本理赔类别。'],
    ['Crunchbase-style IP counts are directional and do not reveal claim quality or jurisdictions.', 'Crunchbase 式 IP 数量只具方向性，不能显示权利要求质量或司法辖区。'],
    ['Qualitative directional claim; no verifiable baseline dollar figure for inference specifically.', '定性方向性判断；没有针对推理的可验证基准美元数字。'],
  ].flatMap(([en, zh]) => [false, true].flatMap((strictEditor) => [
    [
      checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
      `medical and IP claims nouns must not require assertion attribution (strict=${strictEditor}): ${en}`,
    ],
    [
      checkPairQuality(fullReport(`The company claims its solution is superior. ${en}`), fullReport(`该方案更好。${zh}`), { strictEditor })
        .some((issue) => issue.code === 'hedge-preservation'),
      `a nominal claims phrase must not hide a separate company assertion (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    ['Asimov timing stays roughly on plan while the commercial ramp remains uncertain.', 'Asimov 时间完全按计划推进，商业化进度仍不确定。'],
    ['The company does not yet have public retention and migration evidence to justify a premium multiple.', '公司已有支撑溢价倍数所需的公开留存和迁移证据。'],
    ['Search speed claims are vendor-reported; cost and query ergonomics remain to be proved.', '搜索速度已经验证；成本和查询体验仍需验证。'],
    ['The company claims data latency is lower and the platform is more reliable.', '数据延迟更低，平台也更加可靠。'],
    ['The company claims cost reduction across the customer base over the next five years.', '未来五年内，整个客户群的成本将下降。'],
    ['Admin platform + navigation + analytics; claims up to 50% cost trend reduction over 5 yrs.', '管理平台 + 导航 + 分析；5 年内理赔成本趋势最高降低 50%。'],
    ['The base case broadly validates the price. Weighting the paths roughly 25/50/25 leaves expected value near the current mark.', '基准情景大体验证当前价格。路径按 25/50/25 加权，期望值接近当前估值。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `noun exclusions must preserve assertion and qualifier checks (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Over 1 million users.', '用户超过 100 多万。'],
    ['345 million video creations.', '已生成 3.45 亿段视频。'],
    ['$0.60 per 1 million tokens.', '每 100 万 tokens 收费 $0.60。'],
    ['$0.60 per 1 million tokens.', '每 100万tokens 收费 $0.60。'],
    ['2.024 million documents.', '共有 2024 千份文档。'],
    ['1.2 billion events.', '共有 12 亿起事件。'],
    ['2 trillion events.', '共有 2 万亿起事件。'],
    ['7 thousand customers.', '共有 0.7 万名客户。'],
    ['0.345B video creations.', '已生成 3.45 亿段视频。'],
    ['1 million users and 1 million customers.', '100 万名用户和 100 万名客户。'],
    ['Over 1 million users in April 2025.', '2025 年 4 月有 100 多万名用户。'],
    ['Over 1 million users in April 2025.', '2025 年四月有 100 多万名用户。'],
    ['1M customers by September 2025, versus 1 million users in April 2025.', '2025 年 9 月前有 100 万名客户，同年 4 月有 100 万名用户。'],
    ['1M users in April 2025 and 2M users in September 2026.', '2025 年 4 月有 100 万名用户，2026 年 9 月有 200 万名用户。'],
    ['In 2026, we compare 1M users in April 2025 with 2M users in September 2025.', '2026 年，我们比较 2025 年 4 月的 100 万名用户与 2025 年 9 月的 200 万名用户。'],
    ['345 million videos and $5M revenue in 2026.', '2026 年生成 3.45 亿段视频，收入为 $5M。'],
    ['1.0101 million events.', '共有 101.01 万起事件。'],
    ['9007199254740993 thousand events.', '共有 900719925474099.3 万起事件。'],
    ['The service processes at least 1 million events across the complete retained customer cohort.', '服务处理至少 100 万起事件，覆盖全部留存客户。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `equivalent non-currency count scales must preserve exact quantities: ${zh}`,
  ]),
  ...[
    ['345 million video creations.', '已生成 3.45 万段视频。'],
    ['345 million video creations.', '已生成 3.46 亿段视频。'],
    ['1 million users and 1 million customers.', '100 万名用户。'],
    ['1 million users and $5M revenue.', '收入为 $5M。'],
    ['$0.60 per 1 million tokens.', '每 100 万 tokens 收费 €0.60。'],
    ['1 million users.', '规模为 100 万美元。'],
    ['1 million users.', '规模为 USD 100 万。'],
    ['1 million users.', '规模为 100 万 USD。'],
    ['1 million users.', '规模为 $100 万。'],
    ['1 million users.', '规模为 ￥100 万。'],
    ['1 million users.', '规模为 100 万%。'],
    ['1 million users.', '规模为 100 万倍。'],
    ['1 million users.', '规模为 100 万 bps。'],
    ['1 million users.', '规模为 100 万 x。'],
    ['$345 million revenue.', '收入为 3.45 亿。'],
    ['345 million video creations.', '已生成 -3.45 亿段视频。'],
    ['1–2 million users.', '共有 1–200 万名用户。'],
    ['Between 1 and 2 million users.', '共有 1 至 200 万名用户。'],
    ['1 million users and 5 products.', '100 万名用户和 6 款产品。'],
    ['1 million users and 5 products.', '100 万名用户。'],
    ['9007199254740993 thousand events.', '共有 900719925474099.2 万起事件。'],
    ['1.0101 million events.', '共有 101.02 万起事件。'],
    ['2024 had 1 million users.', '2025 年有 100 万名用户。'],
    ['Over 1 million users in April 2025.', '2025 年 5 月有 100 多万名用户。'],
    ['1M customers by September 2025.', '2025 年 8 月前有 100 万名客户。'],
    ['1M users in April 2025 and 2M users in September 2026.', '2025 年 9 月有 100 万名用户，2026 年 4 月有 200 万名用户。'],
    ['In 2026, we compare 1M users in April 2025 with 2M users in September 2025.', '2025 年，我们比较 2026 年 4 月的 100 万名用户与 2025 年 9 月的 200 万名用户。'],
    ['2024 had 1 million users.', '2024 万名用户和 100 万名客户。'],
    ['1 million users and 25bps margin improvement.', '100 万名用户，毛利率提升 25B。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `count-scale fallback must reject changed quantities, omitted occurrences or unsupported monetary/range conversions: ${zh}`,
  ]),
  [
    checkPairQuality(
      fullReport('The service processes at least 1 million events across the complete retained customer cohort.'),
      fullReport('服务处理 100 万起事件，覆盖全部留存客户。'),
      { strictEditor: true },
    ).some((issue) => issue.code === 'hedge-preservation'),
    'count-scale equivalence must not bypass the existing lower-bound qualifier check',
  ],
  ...[
    ['All triggers are observable from public sources or standard diligence requests.', '所有触发项都可通过公开来源或标准尽调请求观察。'],
    ['The previous financing remains uncorroborated in accessible public sources.', '尚无法通过公开可访问来源独立佐证前一轮融资。'],
    ['Brands drove more than $6B in revenue through the platform in Q1 2026.', 'Q1 2026 品牌通过平台带来超过 $6B 收入。'],
    ['Embodied AI is becoming mainstream in manufacturing and services.', '具身 AI 正在制造业和服务业中走向主流。'],
    ['Businesses generate training data in these environments.', '企业正在这些环境中生成训练数据。'],
    ['Data partners are not necessarily deploying the model in production.', '数据伙伴不一定正在生产环境中部署模型。'],
    ['Confirm actual cash balance at most recent fiscal quarter-end before the investment committee.', '投资委员会审议前，确认最近一个财季末的实际现金余额。'],
    ['Review TCPA insurance coverage limit and claims history before underwriting.', '作出投资判断前，审查 TCPA 保险保额和索赔记录。'],
    ['The reported infrastructure covers 130 clusters and 200K GPUs (website claims).', '基础设施覆盖 130 个集群、200K 块 GPU（网站口径）。'],
    ['This is an adversarial claim from Brad Porter, with production deployment experience.', '这项反方观点来自具备生产部署经验的 Brad Porter。'],
    ['Unknown indicates no public documentation found for PaleBlueDot in this review.', '未知表示本次审查未找到 PaleBlueDot 的公开文档。'],
    ['No public SLA with carriers; policy enforcement history has not been disclosed.', '没有与运营商的公开 SLA；政策执行历史未披露。'],
    ['Penetration test summaries require a request; no public breach history confirmed.', '渗透测试摘要需申请；未确认有公开泄露历史。'],
    ['Management continuity is a material risk with no public mitigation evidence.', '管理层连续性是重大风险，公开材料没有缓释证据。'],
    ['No public source provides a segment-specific estimate for the addressable market.', '公开来源没有提供该可服务市场的细分估算。'],
    ['Legal review is required under NDA. No public source resolves these gaps.', '需在 NDA 下开展法律审查，公开来源无法解决这些缺口。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `locative phrases, latest periods, and reviewed disclosure wording must pass (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['公司通过平台来提升转化。', 'translationese'],
    ['项目正在系统测试中，随后才会发布。', 'translationese'],
    ['项目正在系统测试中。', 'translationese'],
  ].map(([zh, code]) => [
    checkPairQuality(fullReport('The company is improving its system.'), fullReport(zh))
      .some((issue) => issue.code === code),
    `genuine stylistic constructions must remain flagged: ${zh}`,
  ]),
  ...[
    ['Confirm actual cash balance at most recent fiscal quarter-end; total exposure must be at most $10M.', '确认最近一个财季末的现金余额，总敞口为 $10M。'],
    ['The company claims the insurance coverage limit and claims history support expansion.', '保险保额和索赔记录支持业务扩张。'],
    ['The reported infrastructure covers 130 clusters and 200K GPUs (website claims).', '基础设施已证实覆盖 130 个集群、200K 块 GPU。'],
    ['Unknown indicates no public documentation found for PaleBlueDot in this review.', '本次审查已找到 PaleBlueDot 的公开文档。'],
    ['Unknown indicates no public documentation found for PaleBlueDot in this review.', '未找到问题，但 PaleBlueDot 的公开文档已确认。'],
    ['No public SLA with carriers; policy enforcement history has not been disclosed.', '已确认与运营商的公开 SLA，政策执行历史未披露。'],
    ['Penetration test summaries require a request; no public breach history confirmed.', '渗透测试摘要需申请，已确认有公开泄露历史。'],
    ['Management continuity is a material risk with no public mitigation evidence.', '管理层连续性是重大风险，公开材料已有缓释证据。'],
    ['Legal review is required under NDA. No public source resolves these gaps.', '需在 NDA 下开展法律审查，公开来源已经解决这些缺口。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `new aliases must not hide an upper bound, separate assertion or positive disclosure (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Estimated from FCA cumulative revenue of £1.119bn over the disclosed period.', '根据 FCA 披露期间的累计收入 £1.119bn 推算。'],
    ['No public financing round, investor identity, or valuation disclosure was found in retained sources.', '留存来源没有找到公开融资轮次、投资人身份或估值披露。'],
    ['No public attestation found; significant gap for enterprise and government buyers.', '未找到公开鉴证；对企业和政府买方都是重大缺口。'],
    ['No public lawsuit against Flex was found in the retained evidence base.', '留存证据中未发现针对 Flex 的公开诉讼。'],
    ['Requires benign losses and a durable moat; no public evidence confirms either yet.', '需要损失保持良性、护城河守得住；公开证据尚未证实任何一点。'],
    ['The B2B licensing model is strategically valuable but unproven at scale.', 'B2B 授权模式具有战略价值，但尚未在规模上得到验证。'],
    ['No independent verification of coverage claims; refresh cadence undisclosed.', '覆盖声明缺少独立验证；刷新节奏未披露。'],
    ['The independent customer-scale data point corroborates company claims.', '这一独立客户规模数据点印证公司口径。'],
    ['The documented incident is indicative of friction in fraud claim handling.', '所记录的事件显示，欺诈索赔处理存在摩擦。'],
    ['Filed accounts; credit risk note; BBL BEIS government guarantee claim status.', '申报账目；信用风险附注；BBL BEIS 政府担保索赔状态。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `reviewed Chinese wording and financial claims nouns must remain faithful (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Estimated from FCA cumulative revenue of £1.119bn over the disclosed period.', 'FCA 披露期间的累计收入为 £1.119bn。'],
    ['No public attestation found; significant gap for enterprise and government buyers.', '已找到公开鉴证，覆盖企业和政府买方。'],
    ['No public lawsuit against Flex was found in the retained evidence base.', '留存证据中已发现针对 Flex 的公开诉讼。'],
    ['No public lawsuit against Flex was found in the retained evidence base.', '未发现问题；针对 Flex 的公开诉讼已经确认。'],
    ['Requires benign losses and a durable moat; no public evidence confirms either yet.', '损失保持良性、护城河守得住；公开证据已经证实两点。'],
    ['The B2B licensing model is strategically valuable but unproven at scale.', 'B2B 授权模式具有战略价值，且已在规模上得到验证。'],
    ['The B2B licensing model is strategically valuable but unproven at scale.', 'B2B 授权模式尚未商业化，但在规模上已经得到验证。'],
    ['No independent verification of coverage claims; refresh cadence undisclosed.', '覆盖已经得到独立验证；刷新节奏未披露。'],
    ['The independent customer-scale data point corroborates company claims.', '这一独立客户规模数据点很有价值。'],
    ['The company claims its new system resolves friction in fraud claim handling.', '新系统解决了欺诈索赔处理中的摩擦。'],
    ['The company claims its service tracks government guarantee claim status.', '这项服务跟踪政府担保索赔状态。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `wording aliases must not hide reversed uncertainty or a separate assertion (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['Managers are consolidating on fewer platforms.', '管理公司正在向更少、更大的 PMS 平台集中。'],
    ['The company is expanding, while the team remains focused.', '公司正在扩张，团队集中精力。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `progressive style check must not mistake 集中 or cross-clause text for a redundant 中: ${zh}`,
  ]),
  [
    checkPairQuality(fullReport('The company is testing the system.'), fullReport('公司正在系统测试中。'))
      .some((issue) => issue.code === 'translationese'),
    'genuine 正在…中 translationese must remain flagged',
  ],
  ...[
    [noPublicIpSource, '架构文档称，这些数仓没有公共 IP 地址。'],
    [noPublicIpSource, '架构文档称，这些数仓无公网 IP 地址。'],
    [noPublicIpSource, '架构文档称，这些数仓不设公有 IP 地址。'],
    [noPublicIpSource, '架构文档称，这些数仓不具备任何公网 IP 地址。'],
    ['The architecture documentation says each warehouse has no public IP address.', '架构文档称，每个数仓都没有公网 IP 地址。'],
    ['The warehouses have no public IP addresses; the traffic stays on private networks.', '数仓没有公网 IP 地址，流量留在私有网络。'],
    ['The documentation has no public IP addresses listed for these serverless warehouses.', '文档中未公开列出这些无服务器数仓的 IP 地址。'],
    ['No public IP addresses are disclosed in the documentation for these warehouses.', '这些数仓的文档未公开 IP 地址。'],
    [noPublicIpAndMilestoneSource, '这些数仓没有公网 IP 地址；未见公开 IPO 时间表里程碑。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `public IP absence and missing disclosure must retain distinct meanings (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    [noPublicIpSource, '架构文档称，这些数仓拥有公网 IP 地址。'],
    [noPublicIpSource, '这些数仓的 IP 地址未公开。'],
    [noPublicIpSource, '这些数仓未披露公网 IP 地址。'],
    [noPublicIpSource, '这些数仓无需公网 IP 地址。'],
    [noPublicIpSource, '这些数仓并非没有公网 IP 地址。'],
    [noPublicIpSource, '这些数仓不是不具备公网 IP 地址。'],
    [noPublicIpSource, '这些数仓没有公网 IPv6 地址。'],
    [noPublicIpAndMilestoneSource, '这些数仓没有公网 IP 地址。'],
    [noPublicIpAndMilestoneSource, '这些数仓拥有公网 IP 地址；未见公开 IPO 时间表里程碑。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation'),
    `public IP absence must not become presence, nondisclosure, or a narrower protocol claim (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['$500+ million of funding.', '融资超过 $500M。'],
    ['A €580-million investment.', '投资金额为 €580M。'],
    ['The market could exceed $20+ billion.', '市场可能超过 $20B。'],
    ['£530+ million annual budget.', '年度预算超过 £530M。'],
    ['A $2.5-million financing.', '融资金额为 $2.5M。'],
    ['A ₦1,200-thousand budget.', '预算为 ₦1,200K。'],
    ['A ¥2-million program.', '项目规模为 ¥2M。'],
    ['A $2024-million financing.', '融资金额为 $2024M。'],
    ['A $1.5-trillion market.', '市场规模为 $1.5T。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `currency-prefixed scale grammar must retain monetary quantities (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['9+ million patients.', '900+ 万名患者。'],
    ['A 5-million-homes market.', '市场覆盖 500 万户。'],
    ['10+ trillion security events.', '10+ 万亿起安全事件。'],
    ['A 1.4-billion-dollar round.', '一轮 14 亿美元的融资。'],
    ['120+ million kilometers.', '120+ 百万公里。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `monetary grammar must not reclassify unsupported unprefixed quantities (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['$500+ million of funding.', '融资超过 $500B。'],
    ['A €580-million investment.', '投资金额为 €570M。'],
    ['The market could exceed $20+ billion.', '市场可能超过 $20。'],
    ['The market could exceed $20+ billion.', '市场可能超过 €20B。'],
    ['A $1.5-trillion market.', '市场规模为 $1.5B。'],
    ['A $2024-million financing.', '融资金额为 $2025M。'],
    ['A $20-millionaire membership.', '会员费为 $20M。'],
    ['Funding is $20+ billion and revenue is $20 billion.', '融资为 $20B。'],
    ['A $20-billion to $30-billion range.', '区间为 $21B 至 $30B。'],
    ['A $20-billion to $30-billion range.', '区间为 $20B 至 $31B。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `scale grammar must not hide changed values, currency, missing units or repeated amounts: ${zh}`,
  ]),
  ...[
    'The company is reportedly preparing an initial public offering for its next financing stage.',
    'According to reports, the company is preparing an initial public offering for its next financing stage.',
  ].flatMap((en) => [false, true].flatMap((strictEditor) => [
    ...['据报道', '据报', '据称', '报道称'].map((prefix) => [
      checkPairQuality(fullReport(en), fullReport(`${prefix}，公司正为下一融资阶段筹备首次公开募股。`), { strictEditor }).length === 0,
      `faithful reported attribution must pass without a conflicting duplicate rule (strict=${strictEditor}): ${prefix}`,
    ]),
    [
      checkPairQuality(fullReport(en), fullReport('公司正为下一融资阶段筹备首次公开募股。'), { strictEditor })
        .filter((issue) => issue.code === 'hedge-preservation').length === 1,
      `omitted reported attribution must yield exactly one error (strict=${strictEditor}): ${en}`,
    ],
  ])),
  ...[
    '款项通过专用管道对账：汇总来自配送代理的现金。',
    '通过核对来自配送代理的记录对账。',
    '记录已通过审核，款项来自配送代理。',
    '记录已通过审核：款项来自配送代理。',
    '通过专用管道核对记录，之后再确认款项来源。',
  ].flatMap((zh) => [false, true].map((strictEditor) => [
    checkPairQuality(
      fullReport('A dedicated pipeline reconciles payments and aggregates cash received from delivery agents.'),
      fullReport(zh),
      { strictEditor },
    ).length === 0,
    `native 来自 and separate clauses must not be mistaken for 通过...来 purpose wording (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    '款项通过专用管道来完成对账。',
    '通过来自配送代理的记录来核对款项。',
    '通过专用管道来核对记录，款项来自配送代理。',
  ].flatMap((zh) => [false, true].map((strictEditor) => [
    checkPairQuality(
      fullReport('A dedicated pipeline reconciles payments and aggregates cash received from delivery agents.'),
      fullReport(zh),
      { strictEditor },
    ).filter((issue) => issue.code === 'translationese').length === 1,
    `a native 来自 elsewhere must not hide actual 通过...来 purpose wording (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['RMB 450M in H1 2025', '2025H1 为 RMB 450M'],
    ['Q1 2026 R&D (annualized)', '2026Q1 R&D（年化）'],
    ['Pre-Phase 3 (Ph3 H1 2027)', 'Phase 3 前（Ph3 2027H1）'],
    ['FY2026Q1 ARR was $10M.', 'FY2026 Q1 ARR 为 $10M。'],
    ['FY2026EH1 ARR was $10M.', 'FY2026E H1 ARR 为 $10M。'],
    ['H1 ARR was $10M.', '上半年 ARR 为 $10M。'],
    ['H2 ARR was $10M.', '下半年 ARR 为 $10M。'],
    ['ARR Pool\\n(>$100M 2023;\\n~$200M 2026 est.)', 'ARR 池\\n（2023 年 >$100M；\\n2026 年估算 ~$200M）'],
    ['Funding\\r\\n2026: $10M.', '2026 年融资 $10M。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `period spacing and escaped line breaks must retain year anchors without inventing metrics (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['RMB 450M in H1 2025', '2026H1 为 RMB 450M'],
    ['Q1 2026 R&D (annualized)', 'Q1 R&D（年化）'],
    ['FY2026Q1 ARR was $10M.', 'FY2027Q1 ARR 为 $10M。'],
    ['Funding\\n2026: $10M.', '融资 $10M。'],
    ['Recorded on 2026-09-24.', '记录于\\n2026-09-25。'],
    ['$14B+ (May 2026)', '$14B+'],
    ['Orders delivered (FY2024)', '已配送订单'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'year-preservation'),
    `calendar normalization must still reject changed or missing year/date anchors (strict=${strictEditor}): ${zh}`,
  ])),
  ...[
    ['H1 2026 ARR was $10M.', '2026H1 ARR 为 $11M。'],
    ['H2 2026 ARR was $10M.', '2026H2 ARR 为 $10B。'],
    ['Q1 2026 ARR was $10M.', '2026Q1 ARR 为 €10M。'],
    ['ARR was $2026.', 'ARR 为 2026H1。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `period normalization must preserve amounts, scales and currencies: ${zh}`,
  ]),
  ...[
    ['Private deployments are 85 percent of revenue, with 70–80 percent margins.', '私有部署占收入 85%，毛利率为 70–80%。'],
    ['Revenue grew 12.5 per cent.', '收入增长 12.5%。'],
    ['Revenue grew 13 percent.', '收入增长百分之十三。'],
    ['Revenue grew 45 percent.', '收入增长百分之四十五。'],
    ['Revenue grew 12.5 percent.', '收入增长百分之十二点五。'],
    ['Revenue grew 100 percent.', '收入增长百分之一百。'],
    ['Saudi Arabia has over 80 percent of users.', '沙特用户占比超过八成。'],
    ['Approximately 70 percent of users are under 40.', '约七成用户不到 40 岁。'],
    ['2026 Q1–Q2 ARR growth exceeds 75%.', '2026 年 Q1–Q2 ARR 增长超过 75%。'],
    ['ARR growth exceeds 75% in 2026 Q1–Q2.', '2026 年 Q1–Q2 ARR 增长超过 75%。'],
    ['2026 Q1–Q2 ARR growth exceeds 75%.', '2026 年第一季度至第二季度 ARR 增长超过 75%。'],
    ['Q2 ARR was $10M.', 'Q2 ARR 为 $10M。'],
    ['2Q2024 revenue was $10M.', '2024 年第二季度收入为 $10M。'],
    ['First-quarter revenue was $10M.', '第一季度收入为 $10M。'],
    ['Revenue in the second quarter was $10M.', '二季度收入为 $10M。'],
    ['Revenue in the 3rd quarter was $10M.', '第三季度收入为 $10M。'],
    ['Revenue in the first three quarters of 2026 was $10M.', '2026 年前三季度收入为 $10M。'],
    ['Q1 to Q3 2026 revenue was $10M.', '2026 年前三季度收入为 $10M。'],
    ['Q1 to Q2 2026 revenue was $10M.', '2026 年前两个季度收入为 $10M。'],
    ['Releases in Q2/Q3.', '第二、第三季度发布。'],
    ['Q3/Q4 outages.', '第三 / 第四季度宕机。'],
    ['Q1/Q2/Q3 releases.', '第一、第二、第三季度发布。'],
    ['Q2–Q3 releases.', '二至三季度发布。'],
    ['Acquisition volume declined in the same quarter.', '同一季度并购量下降。'],
    ['Cash burn versus the previous quarter.', '烧钱额相对上一季度。'],
    ['Any quarter with negative cash flow.', '任一季度现金流为负。'],
    ['A release in the next quarter.', '下一季度发布。'],
    ['Vision Fund 2 quarterly results.', 'Vision Fund 2 季度业绩。'],
    ['Three consecutive quarters of losses.', '连续三季度亏损。'],
    ['Payment users in the last quarter of 2025.', '2025 最后一季度的支付用户。'],
    ['It needs profitability beyond one quarter.', '它需要一季度以外的持续盈利。'],
    ['It is durable, not a one-quarter pilot.', '它有耐久性，不是一季度试点。'],
    ['First four post-IPO quarters.', '上市后前四个季度。'],
    ['Revenue grew roughly one percent.', '收入增长约百分之一。'],
    ['Revenue grew by around a tenth.', '收入增长约一成。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `percentage words and calendar quarters must normalize without becoming ARR quantities: ${zh}`,
  ]),
  ...[
    ['Revenue grew 12.5 percent.', '收入增长 15%。'],
    ['Revenue grew 13 percent.', '收入增长百分之十四。'],
    ['Revenue grew 12.5 percent.', '收入增长百分之十二点六。'],
    ['Revenue grew 1 percent.', '收入增长百分之一千。'],
    ['Saudi Arabia has over 80 percent of users.', '沙特用户占比超过七成。'],
    ['Saudi Arabia has over 80 percent of users.', '沙特用户占比超过八成半。'],
    ['Margins are 70–80 percent.', '毛利率为 75–80%。'],
    ['Margins are 70–80 percent.', '毛利率为 70–85%。'],
    ['Margins are 70–80 percent.', '毛利率为 70–80 倍。'],
    ['Q2 ARR was $10M.', '第二季度 ARR 为 $11M。'],
    ['Q2 ARR was $10M in 2026.', '第二季度 ARR 在 2027 年为 $10M。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `normalization must preserve percentage endpoints, units, years and amounts: ${zh}`,
  ]),
  ...[
    ['A 60-percent-plus share.', '份额为 60%+。'],
    ['A 60-plus percent share.', '份额为 60%+。'],
    ['An 80-plus percent rate.', '比例为 80+%。'],
    ['A 1 billion-member network and an 80-plus percent completion rate.', '1 billion 会员网络，完成率为 80+%。'],
    ['A 12.50-percent-plus share.', '份额为 12.5%+。'],
    ['A 60.12345678901234567-percent-plus share.', '份额为 60.12345678901234567%+。'],
    ['60-PERCENT-PLUS share', '60%+ 份额'],
    ['A 60-percent-plus share and a 60-plus percent share.', '两项份额分别为 60%+ 和 60%+。'],
    ['April 2025: 60-percent-plus share; May 2026: 70-plus percent share.', '2025 年 4 月：60%+ 份额；2026 年 5 月：70%+ 份额。'],
    ['From a 44 percent to a 60-plus percent share, with 19,600 stores.', '份额从 44% 到 60%+，有 19,600 家店铺。'],
    ['A 60-percent-plus share, 80,000-plus merchants, and $7 billion in March 2024.', '份额为 60%+，商户为 80,000+，2024 年 3 月为 $7 billion。'],
    ['A 60-percent-plus share, SAR 21 billion and $10 billion.', '份额为 60%+，SAR 21 billion 和 $10 billion。'],
    ['The route is /60-percent-plus/details.', '路径为 /60-percent-plus/details。'],
    ['The identifier is plan60-plus percent.', '标识符为 plan60-plus percent。'],
  ].flatMap(([en, zh]) => [
    [fullReport(en), fullReport(zh)],
    [en, zh].map(text => ({
      ...fullReport(''), tables: [{ rows: [[text]] }],
      figures: [{ summary: text }],
    })),
  ].map(([en, zh]) => [
    !checkPairQuality(en, zh, { strictEditor: true }).some(issue => issue.code === 'metric-preservation'),
    `bounded percentage aliases retain values, bounds, occurrences and numeric context: ${JSON.stringify(zh)}`,
  ])),
  ...[
    ['A 60-percent-plus share.', '份额为 60%。'],
    ['A 60-plus percent share.', '份额为 60。'],
    ['A 60-percent-plus share.', '份额为 61%+。'],
    ['A 60-percent-plus share.', '份额为 61+%。'],
    ['A 60-percent-plus share.', '份额为 60+。'],
    ['A 60-percent-plus share.', '份额为 -60+%。'],
    ['A 60-percent-plus share.', '份额为 60+% 以下。'],
    ['A 60-percent-plus share.', '份额为 60%−。'],
    ['A 60-percent-plus share.', '份额为 60%+ 以下。'],
    ['A 60-percent-plus share.', '份额为 -60%+。'],
    ['A 60-percent-plus share.', '份额为 $60%+。'],
    ['A 60-percent-plus share.', '份额并非 60%+。'],
    ['A 60-percent-plus share.', '如果份额达到 60%+。'],
    ['A 60-percent-plus share.', '份额为 60%+，另有 10 家。'],
    ['A 60-percent-plus share.', '份额为 60%+10%。'],
    ['A 60-percent-plus share.', '份额为 60%++。'],
    ['A 60-percent-plus share.', '份额为 160%+。'],
    ['A 60.50-percent-plus share.', '份额为 60%+。'],
    ['A 60.12345678901234567-percent-plus share.', '份额为 60.12345678901234568%+。'],
    ['A 60-percent-plus share.', '份额为 1,060%+。'],
    ['A 60-percent-plus share and a 60-plus percent share.', '份额为 60%+。'],
    ['A 60-percent-plus share and a 44 percent rate.', '份额为 60%，比例为 44%+。'],
    ['A 60-percent-plus share with 10 stores.', '份额为 60%+，有 11 家店铺。'],
    ['A 60-percent-plus share with 10 and 10 stores.', '份额为 60%+，有 10 家店铺。'],
    ['April 2025: 60-percent-plus share.', '2025 年 5 月：60%+ 份额。'],
    ['April 2025: 60-percent-plus share.', '2025 年：60%+ 份额。'],
    ['April 2025: 60-percent-plus share.', '2026 年 4 月：60%+ 份额。'],
    ['April 2025: 60-percent-plus share; May 2026: 70-plus percent share.', '2025 年 5 月：60%+ 份额；2026 年 4 月：70%+ 份额。'],
    ['A 60-percent-plus share, $7 billion and 80,000-plus merchants.', '份额为 60%+，$7 billion 和 80,000 家商户。'],
    ['A 60-percent-plus share and -$7M.', '份额为 60%+，$7M。'],
    ['A 60-percent-plus share and ($7M).', '份额为 60%+，$7M。'],
    ['A 60-percent-plus share and -10 stores.', '份额为 60%+，10 家店铺。'],
    ['A 60-percent-plus share and minus 10 stores.', '份额为 60%+，10 家店铺。'],
    ['A 60-percent-plus share and >10 stores.', '份额为 60%+，<10 家店铺。'],
    ['A 60-percent-plus share and SAR 21 billion.', '份额为 60%+，USD 21 billion。'],
    ['A 60-percent-plus share and 21 billion SAR.', '份额为 60%+，21 billion QAR。'],
    ['A 60-percent-plus share and SAR21B.', '份额为 60%+，QAR21B。'],
    ['A 60-percent-plus share and ₹10.', '份额为 60%+，10。'],
    ['A 60-percent-plus share and $10M.', '份额为 60%+，1000 万欧元。'],
    ['A 60-percent-plus share and 30 million stores.', '份额为 60%，3000 万家店铺。'],
    ['A 60-percent-plus share and $10M.', '份额为 60%，1000 万美元。'],
    ['A 60-percent-plus share; revenue tripled.', '份额为 60%，收入变为 3 倍。'],
    ['A 60-percent-plus share and a 50/50 split.', '份额为 60%，其余各占一半。'],
    ['A 60-percent-plus share; 4× champion.', '份额为 60%，4 次夺冠。'],
    ['A 60-percent-plus share; top-10 ARR.', '份额为 60%，前 10 大客户 ARR。'],
    ['A 60-percent-plus share and £65bn.', '份额为 60%，£65B。'],
    ['A -60-percent-plus share.', '份额为 60%+。'],
    ['A $60-percent-plus share.', '份额为 60%+。'],
    ['A SAR 60-percent-plus share.', '份额为 60%+。'],
    ['A 40-60-percent-plus share.', '份额为 40–60%+。'],
    ['A 40 to 60-plus percent share.', '份额为 40 至 60%+。'],
    ['Not a 60-percent-plus share.', '份额为 60%+。'],
    ['If the share reaches 60-percent-plus.', '份额为 60%+。'],
    ['If revenue reaches $7.5M and the share reaches 60-percent-plus.', '收入为 $7.5M，份额为 60%+。'],
    ['If 12,000 stores produce a 60-percent-plus share.', '12,000 家店铺带来 60%+ 份额。'],
    ['The share could reach 60-percent-plus.', '份额为 60%+。'],
    ['Assuming a 60-percent-plus share.', '份额为 60%+。'],
    ['A 60-percent-plus share.', '路径为 /60%+/details。'],
    ['A 60-percent-plus share.', '标识符为 plan60%+。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some(issue => issue.code === 'metric-preservation'),
    `bounded percentage comparison must not clear unsupported or changed anchors: ${en} -> ${zh}`,
  ]),
  [
    checkPairQuality(
      fullReport('No public cloud LLM API allowed; no public renewal data has been disclosed.'),
      fullReport('不允许使用公有云 LLM API；续约数据已公开。'),
    ).some((issue) => issue.code === 'hedge-preservation'),
    'a public-cloud prohibition must not hide a separate missing-disclosure qualifier',
  ],
  [
    checkPairQuality(
      fullReport('No public cloud LLM API allowed; no public renewal data has been disclosed.'),
      fullReport('允许使用公有云 LLM API；续约数据未公开。'),
    ).some((issue) => issue.code === 'hedge-preservation'),
    'a missing-disclosure qualifier must not hide a reversed public-cloud prohibition',
  ],
  ...[
    ['The January 2026 ARR estimate was $190M.', '2026 年 1 月 ARR 估计为 $190M。'],
    ['End-2024 ARR was $50M.', '2024 年底 ARR 为 $50M。'],
    ['In 2025, funding rose in June 2025 and December 2025.', '2025 年融资在 6 月和同年 12 月增加。'],
    ['Processing volume increased 26-fold.', '处理量增至原来的 26 倍。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `calendar labels, repeated year references, and fold notation must retain their meaning: ${zh}`,
  ]),
  ...[
    ['The January 2026 ARR estimate was $190M.', '2027 年 1 月 ARR 估计为 $190M。'],
    ['Funding increased in 2025.', '融资在 2025 年和 2026 年增加。'],
    ['ARR was $2026 ARR.', 'ARR 为 $2026。'],
    ['Processing volume increased 26-fold.', '处理量增至原来的 27 倍。'],
    ['Revenue is $10M and expense is $10M.', '收入为 $10M。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `normalization must not hide changed years, quantities, currency-prefixed values, or repeated amounts: ${zh}`,
  ]),
  [
    checkPairQuality(source, clean, { strictEditor: true }).length === 0,
    'strict editor rejected a faithful native translation',
  ],
  [
    checkPairQuality(source, changedMetric, { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    'strict editor did not reject a changed metric',
  ],
  [
    checkPairQuality(source, translationese, { strictEditor: true })
      .some((issue) => issue.code === 'translationese'),
    'strict editor did not reject translationese',
  ],
  [
    checkPairQuality(source, strictTranslationese, { strictEditor: true })
      .filter((issue) => issue.code === 'editor-translationese').length === 1,
    'strict editor duplicated one translationese finding',
  ],
  [
    checkPairQuality(suffixBoundarySource, suffixBoundaryClean, { strictEditor: true }).length === 0,
    'metric matcher consumed the first letter of a following word as a scale suffix',
  ],
  [
    checkPairQuality(nominalClaimSource, fullReport('已审查的保险数据为理赔建模提供对照基线。')).length === 0,
    'insurance claims modeling was mistaken for an attributed assertion',
  ],
  [
    checkPairQuality(assertionSource, fullReport('新系统改善了理赔建模的运营基准。'))
      .some((issue) => issue.code === 'hedge-preservation')
      && checkPairQuality(assertionSource, fullReport('公司称新系统改善了理赔建模的运营基准。')).length === 0,
    'nominal claims exclusion hid an actual company assertion',
  ],
  ...[
    ['The platform normalizes clinical, claims, and operational data for hospitals.', '平台将临床、理赔和运营数据标准化，供医院使用。'],
    ['The platform connects fragmented clinical, claims, and operational systems for healthcare teams.', '平台为医疗团队连接分散的临床、理赔和运营系统。'],
    ['The platform normalizes clinical, claims and operational data for hospitals.', '平台将临床、理赔和运营数据标准化，供医院使用。'],
    ['Unified data reduces manual coordination between EHRs, claims systems, and staff.', '统一数据减少 EHR、理赔系统与员工之间的手工协调。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor }).length === 0,
    `coordinated medical claims nouns must not require attribution (strict=${strictEditor}): ${en}`,
  ])),
  ...[
    ['The company claims systems integration reduces administrative work.', '系统集成减少行政工作。'],
    ['The company claims strong results from clinical, claims, and operational data.', '临床、理赔和运营数据带来显著成果。'],
    ['It unifies clinical, claims, and operational data, and the company claims strong results.', '它统一临床、理赔和运营数据，并取得显著成果。'],
    ['The company claims it reduces manual coordination between EHRs, claims systems, and staff.', '它减少 EHR、理赔系统与员工之间的手工协调。'],
  ].flatMap(([en, zh]) => [false, true].map((strictEditor) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor })
      .some((issue) => issue.code === 'hedge-preservation')
      && checkPairQuality(fullReport(en), fullReport(`公司称，${zh}`), { strictEditor }).length === 0,
    `medical noun exclusions must retain a separate company assertion (strict=${strictEditor}): ${en}`,
  ])),
  [
    checkPairQuality(patentSource, fullReport('商标检索分析、专利权利要求起草、自由实施检索')).length === 0
      && checkPairQuality(patentAssertionSource, fullReport('新产品改善了专利权利要求起草。'))
        .some((issue) => issue.code === 'hedge-preservation'),
    'patent terminology must not require attribution or hide a separate assertion',
  ],
  [
    checkPairQuality(
      fullReport('Consumer form generation, pro se filings, and volume small-claims processing'),
      fullReport('消费者表单生成、自行诉讼文书及批量小额诉讼处理'),
    ).length === 0
      && checkPairQuality(
        fullReport('The company claims its new workflow automates small-claims processing.'),
        fullReport('新工作流自动处理小额诉讼。'),
      ).some((issue) => issue.code === 'hedge-preservation'),
    'small-claims court terminology must not require attribution or hide a company assertion',
  ],
  [
    checkPairQuality(
      fullReport('Obtain audited COGS schedules and vendor contracts before making any company-specific margin claim.'),
      fullReport('先取得经审计的 COGS 明细及供应商合同，再对公司的毛利率作出断言。'),
    ).length === 0,
    'a faithful analytical assertion must accept 断言 as a rendering of claim',
  ],
  ...[
    ['Revenue is $190 million and funding is $1.2 billion.', '收入为 $190M，融资为 $1.2B。'],
    ['The scope is 0.94 million documents and €2 thousand in fees.', '范围包括 0.94M 份文档，费用为 €2K。'],
    ['The market is $1.2 trillion.', '市场规模为 $1.2T。'],
    ['Revenue is $2024 million.', '收入为 $2024M。'],
    ['The spread is 25bps.', '利差为 25 bps。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `equivalent scale words and symbols must preserve quantity, not create a false year: ${zh}`,
  ]),
  ...[
    ['Revenue is $190 million.', '收入为 $190。'],
    ['Revenue is $190 million.', '收入为 $190B。'],
    ['Revenue is $190 million.', '收入为 €190M。'],
    ['The spread is 25bps.', '利差为 25B。'],
    ['The sample has 25buyers.', '样本有 25B 名买家。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `metric comparison must reject missing scale, changed scale/currency and bps-versus-billion confusion: ${zh}`,
  ]),
  [
    checkPairQuality(
      fullReport('Revenue in 2024 was $190 million.'),
      fullReport('2025 年收入为 $190M。'),
      { strictEditor: true },
    ).some((issue) => issue.code === 'year-preservation'),
    'scale-word normalization must not hide a changed calendar year beside an amount',
  ],
  [
    checkPairQuality(multiplierSource, fullReport('Harvey 定价是 Spellbook 的 5-10 倍、CoCounsel 的 2–5 倍。'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('Revenue is 4× the prior year.'), fullReport('收入是上年的 4 倍。'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('The valuation is 15xARR.'), fullReport('估值为 15x ARR。'), { strictEditor: true }).length === 0,
    'equivalent multiplier notation was rejected',
  ],
  ...[
    'Harvey 定价是 Spellbook 的 6-10 倍、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-11 倍、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-10%、CoCounsel 的 2-5 倍。',
    'Harvey 定价是 Spellbook 的 5-10 倍。',
  ].map((zh) => [
    checkPairQuality(multiplierSource, fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `multiplier comparison missed a changed endpoint, unit, or omitted range: ${zh}`,
  ]),
  ...[
    ['30–40% growth, NRR in the mid-teens above 100', '30–40% 增长，NRR 高于 100%，增量在十几个点的中段'],
    ['Growth falls below ~25%, NRR trends toward low 100s', '增长跌破约 25%，NRR 向 100% 出头滑落'],
    ['GRR is around 90.', 'GRR 约为 90%。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `faithful percentage ranges and conventional retention units must pass: ${zh}`,
  ]),
  ...[
    ['Growth is 30-40%.', '增长为 35–40%。'],
    ['Growth is 30-40%.', '增长为 30–45%。'],
    ['Growth is 30-40%.', '增长为 40%。'],
    ['NRR trends toward low 100s.', 'NRR 向 120% 出头滑落。'],
    ['NRR is above 110.', 'NRR 高于 100%。'],
    ['NRR for 100 customers.', 'NRR 覆盖 100% 的客户。'],
    ['NRR measured across 100 cohorts.', 'NRR 覆盖 100% 的批次。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true })
      .some((issue) => issue.code === 'metric-preservation'),
    `percentage normalization must retain endpoints and must not turn counts into rates: ${zh}`,
  ]),
  [
    checkPairQuality(fiscalYearSource, fullReport('累计收入里程碑须在 FY2029 财年底前完成。')).length === 0
      && checkPairQuality(fiscalYearSource, fullReport('累计收入里程碑须在 FY2030 财年底前完成。'))
        .some((issue) => issue.code === 'year-preservation')
      && checkPairQuality(fullReport('Complete by FY2029.'), fullReport('完成期限未披露。'))
        .some((issue) => issue.code === 'year-preservation'),
    'fiscal-year matching must accept FY prefixes without hiding changed or missing years',
  ],
  [
    checkPairQuality(fullReport('BNPL Market GTV (est. 2024)'), fullReport('BNPL 市场 GTV（2024E）'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('BNPL Market GTV (est. 2024)'), fullReport('BNPL 市场 GTV（2025E）'), { strictEditor: true })
        .some((issue) => issue.code === 'year-preservation'),
    'forecast suffixes must preserve the year without hiding a changed estimate year',
  ],
  [
    checkPairQuality(fullReport('ARR exceeded $4B in FY2024.'), fullReport('FY2024 ARR 超过 $4B。'), { strictEditor: true }).length === 0
      && checkPairQuality(fullReport('ARR exceeded $4B in FY2024.'), fullReport('FY2024 ARR 超过 $5B。'), { strictEditor: true })
        .some((issue) => issue.code === 'metric-preservation')
      && checkPairQuality(fullReport('The multiple is 2024x.'), fullReport('倍数为 2025x。'), { strictEditor: true })
        .some((issue) => issue.code === 'metric-preservation'),
    'fiscal years must not absorb an adjacent metric label or hide changed metric values',
  ],
  ...[
    ['Filed on 2026-09-25.', '2026 年 9 月 25 日提交。'],
    ['Filed on 2026-9-5.', '2026-09-05 提交。'],
    ['Filed on 2026-09-25; amended on 2026-09-26.', '2026 年 9 月 25 日提交；2026 年 9 月 26 日修订。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh), { strictEditor: true }).length === 0,
    `faithful localized calendar dates must pass: ${zh}`,
  ]),
  ...[
    ['Filed on 2026-09-25.', '2026-09-26 提交。'],
    ['Filed on 2026-09-25.', '2026 年 10 月 25 日提交。'],
    ['Filed on 2026-09-25.', '2026 年提交。'],
    ['Filed on 2026-09-25; amended on 2026-09-26.', '2026 年 9 月 25 日提交并修订。'],
  ].map(([en, zh]) => [
    checkPairQuality(fullReport(en), fullReport(zh))
      .some((issue) => issue.code === 'year-preservation'),
    `date checking must retain month/day anchors, not just the year: ${zh}`,
  ]),
  [
    checkPairQuality(fullReport('groq.com/pricing (official)'), fullReport('groq.com/pricing（官方定价页）')).length === 0
      && checkPairQuality(fullReport('https://example.com/revenue (official)'), fullReport('https://example.com/revenue（官方页面）')).length === 0
      && checkPairQuality(fullReport('Pricing at groq.com/pricing'), fullReport('groq.com/pricing 的 pricing'))
        .some((issue) => issue.code === 'descriptor-leak')
      && checkPairQuality(fullReport('Pricing at groq.com/pricing'), fullReport('groq.com/pricing，pricing 未译'))
        .some((issue) => issue.code === 'descriptor-leak'),
    'URL paths must be preserved without hiding untranslated descriptors outside URLs',
  ],
  [
    checkPairQuality(
      fullReport('Commercial conversion remains unproven, and the company has not yet published audited financials.'),
      fullReport('商业转化尚未验证，公司还没有发布经审计财务。'),
    ).length === 0
      && checkPairQuality(
        fullReport('No public evidence was found to confirm certification or any independent security audit.'),
        fullReport('未发现公开证据确认认证或任何独立安全审计。'),
      ).length === 0
      && checkPairQuality(
        fullReport('Commercial conversion remains unproven, and the company has not yet published audited financials.'),
        fullReport('商业转化已获验证，公司已经发布经审计财务。'),
      ).filter((issue) => issue.code === 'hedge-preservation').length === 2,
    'faithful negative qualifiers must pass while reversed certainty must fail',
  ],
  [
    untranslatedMessage('Tobi Lütke', 'Tobi Lütke') === null
      && untranslatedMessage('Andreessen Horowitz (a16z)', 'Andreessen Horowitz (a16z)') === null
      && untranslatedMessage('Gao Jiyang (高继扬)', 'Gao Jiyang (高继扬)') === null
      && untranslatedMessage('Physical Intelligence (π0)', 'Physical Intelligence (π0)') === null
      && untranslatedMessage('Tiger Global Management', 'Tiger Global Management') === null
      && untranslatedMessage('IBM (watsonx Orchestrate)', 'IBM (watsonx Orchestrate)') === null
      && untranslatedMessage('Lee Seung-gun (SG Lee / 이승건)', 'Lee Seung-gun（SG Lee / 이승건）') === null
      && untranslatedMessage('16λ DWDM, 112G PAM4', '16λ DWDM、112G PAM4') === null,
    'strict structural check rejected a Latin proper noun',
  ],
  [
    untranslatedMessage('Global retail sample', 'Global retail sample') === 'translation is identical to the English source',
    'strict structural check accepted untranslated ordinary descriptors',
  ],
  ...[
    'Tiger Global Management enterprise platform',
    'IBM (watsonx Orchestrate) platform',
    'eesel AI / Groq Pricing Guide',
  ].map(value => [
    untranslatedMessage(value, value) === 'translation is identical to the English source',
    `proper-name recognition must not exempt adjacent descriptors: ${value}`,
  ]),
  ...negativeExamples.map(([en, faithful, reversed]) => [
    checkPairQuality(fullReport(en), fullReport(faithful)).length === 0
      && checkPairQuality(fullReport(en), fullReport(reversed))
        .some((issue) => issue.code === 'hedge-preservation'),
    `negative qualifier matching failed for: ${en}`,
  ]),
  [
    editorialQualityImproved(
      { errorCount: 0, warningCount: 10 },
      { errorCount: 0, warningCount: 2 },
    ),
    'editor rejected a strict advisory reduction',
  ],
  [
    !editorialQualityImproved(
      { errorCount: 0, warningCount: 2 },
      { errorCount: 0, warningCount: 2 },
    ) && !editorialQualityImproved(
      { errorCount: 0, warningCount: 2 },
      { errorCount: 1, warningCount: 0 },
    ),
    'editor accepted a non-improving or semantically unsafe revision',
  ],
];

const failures = checks.filter(([ok]) => !ok).map(([, message]) => message);
if (failures.length) {
  for (const failure of failures) console.error(`[check-translation-editor] ${failure}`);
  process.exit(1);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'translation-quality-audit-'));
const approvalRoot = mkdtempSync(join(tmpdir(), 'translation-publication-approval-'));
try {
  const reportDir = join(fixtureRoot, 'reports', 'audit-fixture');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'full-report.yaml'), JSON.stringify(source));
  writeFileSync(join(reportDir, 'full-report.zh.yaml'), JSON.stringify(changedMetric));
  writeFileSync(join(reportDir, 'summary-card.yaml'), JSON.stringify({ artifact: 'summary-card' }));
  const auditScript = new URL('./audit-translations.mjs', import.meta.url);
  for (const strictEditor of [false, true]) {
    const child = spawnSync(process.execPath, [
      fileURLToPath(auditScript), '--report', 'audit-fixture', '--format', 'json',
      ...(strictEditor ? ['--strict-editor'] : []),
    ], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const audit = JSON.parse(child.stdout);
    assert.equal(audit.strictEditor, strictEditor);
    assert.equal(audit.checkedPairs, 1);
    assert.equal(audit.missingOverlayPairs, 1);
    assert.equal(audit.reports[0].missingOverlayPairs, 1);
    assert.equal(audit.errorCount, strictEditor ? 1 : 0);
    assert.equal(audit.cleanPairs, strictEditor ? 0 : 1);
    assert.equal(audit.hardPassPairs, strictEditor ? 0 : 1);
    assert.equal(audit.reports[0].errorCount, audit.errorCount);
    if (strictEditor) assert.equal(audit.findings[0].code, 'metric-preservation');
  }
  const missingDir = join(fixtureRoot, 'reports', 'missing-overlay-fixture');
  mkdirSync(missingDir);
  writeFileSync(join(missingDir, 'full-report.yaml'), JSON.stringify(source));
  const missing = spawnSync(process.execPath, [
    fileURLToPath(auditScript), '--report', 'missing-overlay-fixture', '--strict-editor', '--format', 'json',
  ], { cwd: fixtureRoot, encoding: 'utf8' });
  assert.equal(missing.status, 0, missing.stderr);
  const unassessed = JSON.parse(missing.stdout);
  assert.equal(unassessed.checkedPairs, 0);
  assert.equal(unassessed.missingOverlayPairs, 1);
  assert.equal(unassessed.hardPassRatePct, null);
  assert.equal(unassessed.cleanRatePct, null);
  assert.equal(unassessed.reports[0].hardPassRatePct, null);
  assert.equal(unassessed.reports[0].cleanRatePct, null);

  const scripts = join(fixtureRoot, '.agents/skills/translate-zh/scripts');
  cpSync(new URL('./', import.meta.url), scripts, { recursive: true });
  const references = join(fixtureRoot, '.agents/skills/translate-zh/references');
  mkdirSync(references);
  cpSync(new URL('../references/glossary.zh.yaml', import.meta.url), join(references, 'glossary.zh.yaml'));
  symlinkSync(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(fixtureRoot, 'node_modules'), 'dir');
  writeFileSync(join(fixtureRoot, 'package.json'), '{"type":"module"}');
  const translationWorkflow = yaml.load(readFileSync(new URL('../../../../.github/workflows/translate-reports-zh.yml', import.meta.url), 'utf8'));
  const workflowSteps = translationWorkflow.jobs.translate.steps;
  const verificationIndex = workflowSteps.findIndex((step) => step.name === 'Verify selected translations');
  const publicationIndex = workflowSteps.findIndex((step) => step.name === 'Commit and publish Chinese translations');
  assert.ok(verificationIndex >= 0 && publicationIndex > verificationIndex);
  const verificationStep = workflowSteps[verificationIndex];
  assert.equal(verificationStep['continue-on-error'], undefined);
  const publicationIds = ['20990101000000-publication-clean', '20990101000001-publication-candidate'];
  for (const runId of publicationIds) {
    const folder = join(fixtureRoot, 'reports', runId);
    mkdirSync(folder);
    for (const artifact of ['summary-card', 'full-report']) {
      const document = (text) => artifact === 'full-report'
        ? fullReport(text) : { artifact, summary: { headline: text } };
      writeFileSync(join(folder, `${artifact}.yaml`), JSON.stringify(document(source.subtitle)));
      writeFileSync(join(folder, `${artifact}.zh.yaml`), JSON.stringify(document(clean.subtitle)));
    }
  }
  const guardDirectory = join(fixtureRoot, '.agents/skills/startup-research/scripts');
  mkdirSync(guardDirectory, { recursive: true });
  cpSync(new URL('../../startup-research/scripts/check-publication-scope.mjs', import.meta.url),
    join(guardDirectory, 'check-publication-scope.mjs'));
  writeFileSync(join(fixtureRoot, '.gitignore'), 'node_modules\n');
  for (const args of [
    ['init', '--quiet', '--initial-branch=main'], ['config', 'user.name', 'Translation Fixture'],
    ['config', 'user.email', 'translation@example.invalid'], ['config', 'commit.gpgsign', 'false'],
    ['config', 'core.hooksPath', '/dev/null'], ['add', '.'], ['commit', '--quiet', '-m', 'Publication fixture baseline'],
  ]) {
    const child = spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  const publicationEnv = { ...process.env, REPORT_IDS: publicationIds.join('\n'), RUNNER_TEMP: approvalRoot };
  const snapshotStep = workflowSteps.find(step => step.name === 'Snapshot publication approval inputs');
  assert.ok(snapshotStep);
  const snapshot = spawnSync('bash', ['-c', snapshotStep.run], {
    cwd: fixtureRoot, encoding: 'utf8', env: publicationEnv,
  });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  for (const artifact of ['summary-card', 'full-report']) {
    const document = (text) => artifact === 'full-report'
      ? fullReport(text) : { artifact, summary: { headline: text } };
    const target = join(fixtureRoot, 'reports', publicationIds[1], `${artifact}.zh.yaml`);
    for (const [candidate, expectedStatus] of [[changedMetric, 1], [strictTranslationese, 1], [clean, 0]]) {
      assert.equal(checkPairQuality(document(source.subtitle), document(candidate.subtitle))
        .filter((issue) => issue.severity === 'error').length, 0, 'fixture must pass the weaker draft gate');
      writeFileSync(target, JSON.stringify(document(candidate.subtitle)));
      const child = spawnSync('bash', ['-c', verificationStep.run], {
        cwd: fixtureRoot, encoding: 'utf8',
        env: publicationEnv,
      });
      assert.equal(child.status, expectedStatus, `${artifact}: ${child.stdout}\n${child.stderr}`);
      if (expectedStatus !== 0) assert.ok(child.stderr.includes(`publication-candidate/${artifact}.zh.yaml`), child.stderr);
    }
  }
  const repairDir = join(fixtureRoot, 'reports', 'repair-fixture');
  mkdirSync(repairDir);
  const repairSource = {
    ...fullReport('Existing narrative'),
    slug: '',
    coverageNotes: 'New context after correction',
    tables: [
      { title: 'Valuation', columns: ['Metric', 'Value'], rows: [['Valuation', '~27.1x current-entry proxy'], ['Entry price', '$190B']] },
      { title: 'Additional context', rows: [['Existing label', 'Existing detail'], ['New label', 'New detail']] },
      { title: 'Placeholder controls', rows: [['', '', null, '$10M', '—']] },
    ],
    figures: [{
      type: 'pyramid',
      data: { nodes: [
        { id: 'N001', label: 'TAM', value: 0, displayValue: '', score: 13, unit: '%',
          notes: 'Limited sample; not independently audited.', claimRefs: ['C001'] },
        { label: 'SAM', notes: { id: 'protected-note-id', description: 'Protected nested content' } },
        { label: 'SOM', notes: ['Protected nested array'] },
      ] },
    }],
  };
  const repairTranslation = {
    ...fullReport('原有说明'),
    slug: '—',
    coverageNotes: ' ',
    tables: [
      { title: '估值', columns: ['项目', '数值'], rows: [['估值', '~24.8x-27.9x'], ['入场价', '旧金额说明'], ['删除行', '旧数据']] },
      { title: '补充背景', rows: [['原有项目', '原有说明']] },
      { title: '占位符对照', rows: [['—', '未经支持的旧断言', '—', '—', '未经支持的旧断言']] },
    ],
    figures: structuredClone(repairSource.figures),
  };
  const repairSummary = { artifact: 'summary-card', summary: { headline: 'Existing conclusion' } };
  const repairSummaryZh = { artifact: 'summary-card', summary: { headline: '原有结论' } };
  const repairInputs = {
    'full-report.yaml': repairSource, 'full-report.zh.yaml': repairTranslation,
    'summary-card.yaml': repairSummary, 'summary-card.zh.yaml': repairSummaryZh,
  };
  for (const [file, doc] of Object.entries(repairInputs)) writeFileSync(join(repairDir, file), JSON.stringify(doc));
  const runRepair = (command, ...args) => {
    const child = spawnSync(process.execPath, [
      join(scripts, 'run-translation.mjs'), command, 'repair-fixture', ...args,
    ], { cwd: fixtureRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  };
  runRepair('repair-init');
  const repairCache = join(fixtureRoot, '.translate-cache/repair-fixture');
  const seeded = yaml.load(readFileSync(join(repairCache, 'full-report.translate.yaml'), 'utf8'));
  assert.equal(seeded.subtitle, '原有说明');
  assert.equal(seeded.coverageNotes, repairSource.coverageNotes, 'empty old translations must remain editable from English');
  assert.equal(seeded.tables[0].rows[0][1], '~24.8x-27.9x', 'newly descriptive source must expose its old mechanical translation');
  assert.equal(seeded.tables[0].rows[1][1], null, 'new mechanical source must not inherit stale translated prose');
  assert.equal(seeded.tables[0].rows.length, 2, 'removed source rows must not enter the cache');
  assert.deepEqual(seeded.tables[1].rows[1], ['New label', 'New detail'], 'new source rows must remain editable');
  assert.equal(seeded.figures[0].data.nodes[0].notes, repairSource.figures[0].data.nodes[0].notes,
    'newly whitelisted node notes must enter the editable sparse bundle');
  assert.equal(yaml.load(readFileSync(join(repairCache, 'summary-card.translate.yaml'), 'utf8')).summary.headline, '原有结论');
  for (const [file, doc] of Object.entries(repairInputs)) assert.equal(readFileSync(join(repairDir, file), 'utf8'), JSON.stringify(doc));
  runRepair('lint-parts');
  const manifest = JSON.parse(readFileSync(join(repairCache, 'parts/manifest.json'), 'utf8'));
  assert.equal(manifest.parts.length, 1);
  const partPath = join(repairCache, 'parts', manifest.parts[0].file);
  const part = yaml.load(readFileSync(partPath, 'utf8'));
  part.coverageNotes = '修正后补充的背景';
  part.tables[0].rows[0][1] = '当前入场价口径约 27.1x';
  part.tables[1].rows[1] = ['新增项目', '新增说明'];
  part.figures[0].data.nodes[0].notes = '样本有限，未经独立审计。';
  writeFileSync(partPath, yaml.dump(part));
  runRepair('lint-parts');
  runRepair('finalize-full', '--keep-cache');
  const repaired = yaml.load(readFileSync(join(repairDir, 'full-report.zh.yaml'), 'utf8'));
  assert.equal(repaired.tables[0].rows[0][1], '当前入场价口径约 27.1x');
  assert.equal(repaired.tables[0].rows[1][1], '$190B');
  assert.equal(repaired.tables[0].rows.length, 2);
  assert.deepEqual(repaired.tables[1].rows[1], ['新增项目', '新增说明']);
  assert.deepEqual(repaired.tables[2].rows[0], ['—', '', null, '$10M', '—'],
    'only existing dash placeholders for blank strings may survive; stale prose, nulls and quantities follow English');
  assert.equal(repaired.slug, '', 'non-translatable blanks must remain exactly English');
  const expectedFigures = structuredClone(repairSource.figures);
  expectedFigures[0].data.nodes[0].notes = '样本有限，未经独立审计。';
  assert.deepEqual(repaired.figures, expectedFigures,
    'node-note translation must preserve values, explicit blanks, units, refs and structured sidecars');
  assert.equal(readFileSync(join(repairDir, 'full-report.yaml'), 'utf8'), JSON.stringify(repairSource));

  const batchSource = fullReport('Approximately $10M revenue in 2025 is not yet audited by an independent auditor.');
  const batchTranslation = fullReport('对于投资者而言，2025 年收入约 $10M，尚未经独立审计。');
  const batchClean = fullReport('2025 年收入约 $10M，尚未经独立审计。');
  const batchInputs = {
    'full-report.yaml': batchSource,
    'full-report.zh.yaml': batchTranslation,
    'summary-card.yaml': repairSummary,
    'summary-card.zh.yaml': repairSummaryZh,
    'evidence.yaml': { sources: [{ id: 'S001', url: 'https://example.com/original' }] },
  };
  const createBatchFixture = (runId, overrides = {}) => {
    const folder = join(fixtureRoot, 'reports', runId);
    mkdirSync(folder);
    for (const [file, doc] of Object.entries({ ...batchInputs, ...overrides })) {
      writeFileSync(join(folder, file), JSON.stringify(doc));
    }
    return {
      runId,
      changes: [{
        artifact: 'full-report', path: 'subtitle', english: batchSource.subtitle,
        before: batchTranslation.subtitle, after: batchClean.subtitle,
      }],
    };
  };
  const batchPath = join(fixtureRoot, 'reviewed-fixes.json');
  const runBatch = (reports, apply = false) => {
    writeFileSync(batchPath, JSON.stringify({ reports }));
    const child = spawnSync(process.execPath, [
      join(scripts, 'run-translation.mjs'), 'repair-batch', batchPath, ...(apply ? ['--apply'] : []),
    ], { cwd: fixtureRoot, encoding: 'utf8' });
    return { child, result: child.stdout.trim() ? JSON.parse(child.stdout) : null };
  };
  const first = createBatchFixture('batch-first');
  first.changes.push({
    artifact: 'summary-card', path: 'summary/headline',
    english: repairSummary.summary.headline, before: repairSummaryZh.summary.headline, after: '既有结论',
  });
  const second = createBatchFixture('batch-second');
  const preview = runBatch([first, second]);
  assert.equal(preview.child.status, 0, preview.child.stderr);
  assert.deepEqual(preview.result.reports.map((r) => r.status), ['ready', 'ready']);
  for (const target of [first, second]) {
    for (const [file, doc] of Object.entries(batchInputs)) {
      assert.equal(readFileSync(join(fixtureRoot, 'reports', target.runId, file), 'utf8'), JSON.stringify(doc));
    }
  }
  const applied = runBatch([first, second], true);
  assert.equal(applied.child.status, 0, applied.child.stderr);
  assert.deepEqual(applied.result.reports.map((r) => r.status), ['applied', 'applied']);
  for (const target of [first, second]) {
    const folder = join(fixtureRoot, 'reports', target.runId);
    assert.deepEqual(yaml.load(readFileSync(join(folder, 'full-report.zh.yaml'), 'utf8')), batchClean);
    for (const [file, doc] of Object.entries(batchInputs)) {
      if (target === first && file === 'summary-card.zh.yaml') {
        assert.deepEqual(yaml.load(readFileSync(join(folder, file), 'utf8')),
          { ...repairSummaryZh, summary: { headline: '既有结论' } });
        continue;
      }
      if (file !== 'full-report.zh.yaml') assert.equal(readFileSync(join(folder, file), 'utf8'), JSON.stringify(doc));
    }
  }
  for (const [name, edit] of [
    ['english', { english: 'Stale English' }],
    ['chinese', { before: '过时译文' }],
    ['metric', { after: changedMetric.subtitle }],
    ['hedge', { after: '2025 年收入为 $10M，已经审计。' }],
    ['preserved', { path: 'artifact', english: 'full-report', before: 'full-report', after: '完整报告' }],
  ]) {
    const target = createBatchFixture(`batch-${name}`);
    Object.assign(target.changes[0], edit);
    const blocked = runBatch([target], true);
    assert.equal(blocked.child.status, 1, blocked.child.stdout);
    assert.equal(blocked.result.reports[0].status, 'blocked');
    for (const [file, doc] of Object.entries(batchInputs)) {
      assert.equal(readFileSync(join(fixtureRoot, 'reports', target.runId, file), 'utf8'), JSON.stringify(doc));
    }
  }
  const rollback = createBatchFixture('batch-rollback', {
    'full-report.yaml': { ...batchSource, slug: 'stable' },
    'full-report.zh.yaml': { ...batchTranslation, slug: 'preserve-existing-drift' },
  });
  const third = createBatchFixture('batch-third');
  const partial = runBatch([rollback, third], true);
  assert.equal(partial.child.status, 1, partial.child.stderr);
  assert.deepEqual(partial.result.reports.map((r) => r.status), ['blocked', 'applied']);
  assert.equal(readFileSync(join(fixtureRoot, 'reports', rollback.runId, 'full-report.zh.yaml'), 'utf8'),
    JSON.stringify({ ...batchTranslation, slug: 'preserve-existing-drift' }));
  const active = createBatchFixture('batch-active');
  mkdirSync(join(fixtureRoot, '.translate-cache', active.runId));
  const refused = runBatch([active], true);
  assert.equal(refused.child.status, 1);
  assert.match(refused.result.reports[0].error, /existing cache/);
  const duplicate = runBatch([third, third]);
  assert.notEqual(duplicate.child.status, 0);
  assert.match(duplicate.child.stderr, /only once/);
  const nestedDoc = (body) => ({
    artifact: 'full-report',
    chapters: [{ sections: [{ blocks: [{ body }] }] }],
  });
  const nested = createBatchFixture('batch-nested', {
    'full-report.yaml': nestedDoc(batchSource.subtitle),
    'full-report.zh.yaml': nestedDoc(batchTranslation.subtitle),
  });
  nested.changes[0].path = 'chapters/0/sections/0/blocks/0/body';
  nested.changes[0].after += '\n';
  const nestedResult = runBatch([nested], true);
  assert.equal(nestedResult.child.status, 0, nestedResult.child.stderr);
  assert.deepEqual(yaml.load(readFileSync(join(fixtureRoot, 'reports', nested.runId, 'full-report.zh.yaml'), 'utf8')),
    nestedDoc(`${batchClean.subtitle}\n`));
  const mechanicalDoc = (cell) => ({ artifact: 'full-report', tables: [{ rows: [[cell]] }] });
  const mechanical = createBatchFixture('batch-mechanical', {
    'full-report.yaml': mechanicalDoc('unknown'),
    'full-report.zh.yaml': mechanicalDoc('未知'),
  });
  mechanical.changes = [{
    artifact: 'full-report', path: 'tables/0/rows/0/0', english: 'unknown', before: '未知', after: '尚不明确',
  }];
  const mechanicalPreview = runBatch([mechanical]);
  assert.equal(mechanicalPreview.child.status, 1);
  assert.match(mechanicalPreview.result.reports[0].error, /not an editable sparse leaf/);
  const mechanicalResult = runBatch([mechanical], true);
  assert.equal(mechanicalResult.child.status, 1);
  assert.match(mechanicalResult.result.reports[0].error, /not an editable sparse leaf/);
  assert.equal(readFileSync(join(fixtureRoot, 'reports', mechanical.runId, 'full-report.zh.yaml'), 'utf8'),
    JSON.stringify(mechanicalDoc('未知')));
  const placeholderSource = {
    ...batchSource,
    tables: [{ rows: [['', ' ', '']] }],
    figures: [{ data: { rows: [{ values: ['', '', '', null, '$10M', '—'] }] } }],
  };
  const placeholderTranslation = {
    ...batchTranslation,
    tables: [{ rows: [['—', '–', '-']] }],
    figures: [{ data: { rows: [{ values: ['—', '–', '-', null, '$10M', '—'] }] } }],
  };
  const placeholderSummary = { ...repairSummary, summary: { ...repairSummary.summary, topStrengths: [''] } };
  const placeholderSummaryZh = { ...repairSummaryZh, summary: { ...repairSummaryZh.summary, topStrengths: ['—'] } };
  const placeholders = createBatchFixture('batch-placeholders', {
    'full-report.yaml': placeholderSource,
    'full-report.zh.yaml': placeholderTranslation,
    'summary-card.yaml': placeholderSummary,
    'summary-card.zh.yaml': placeholderSummaryZh,
  });
  placeholders.changes.push({
    artifact: 'summary-card', path: 'summary/headline',
    english: repairSummary.summary.headline, before: repairSummaryZh.summary.headline, after: '既有结论',
  });
  const placeholdersResult = runBatch([placeholders], true);
  assert.equal(placeholdersResult.child.status, 0, placeholdersResult.child.stderr);
  const placeholdersDir = join(fixtureRoot, 'reports', placeholders.runId);
  assert.deepEqual(yaml.load(readFileSync(join(placeholdersDir, 'full-report.zh.yaml'), 'utf8')),
    { ...placeholderTranslation, subtitle: batchClean.subtitle });
  assert.deepEqual(yaml.load(readFileSync(join(placeholdersDir, 'summary-card.zh.yaml'), 'utf8')),
    { ...placeholderSummaryZh, summary: { ...placeholderSummaryZh.summary, headline: '既有结论' } });
  assert.equal(readFileSync(join(placeholdersDir, 'full-report.yaml'), 'utf8'), JSON.stringify(placeholderSource));
  assert.equal(readFileSync(join(placeholdersDir, 'summary-card.yaml'), 'utf8'), JSON.stringify(placeholderSummary));
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(approvalRoot, { recursive: true, force: true });
}

console.log('[check-translation-editor] ✓ source-anchored editor gates verified.');
