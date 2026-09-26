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

const checks = [
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
      && untranslatedMessage('Lee Seung-gun (SG Lee / 이승건)', 'Lee Seung-gun（SG Lee / 이승건）') === null
      && untranslatedMessage('16λ DWDM, 112G PAM4', '16λ DWDM、112G PAM4') === null,
    'strict structural check rejected a Latin proper noun',
  ],
  [
    untranslatedMessage('Global retail sample', 'Global retail sample') === 'translation is identical to the English source',
    'strict structural check accepted untranslated ordinary descriptors',
  ],
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
  for (const runId of ['publication-clean', 'publication-candidate']) {
    const folder = join(fixtureRoot, 'reports', runId);
    mkdirSync(folder);
    for (const artifact of ['summary-card', 'full-report']) {
      const document = (text) => artifact === 'full-report'
        ? fullReport(text) : { artifact, summary: { headline: text } };
      writeFileSync(join(folder, `${artifact}.yaml`), JSON.stringify(document(source.subtitle)));
      writeFileSync(join(folder, `${artifact}.zh.yaml`), JSON.stringify(document(clean.subtitle)));
    }
  }
  for (const artifact of ['summary-card', 'full-report']) {
    const document = (text) => artifact === 'full-report'
      ? fullReport(text) : { artifact, summary: { headline: text } };
    const target = join(fixtureRoot, 'reports/publication-candidate', `${artifact}.zh.yaml`);
    for (const [candidate, expectedStatus] of [[changedMetric, 1], [strictTranslationese, 1], [clean, 0]]) {
      assert.equal(checkPairQuality(document(source.subtitle), document(candidate.subtitle))
        .filter((issue) => issue.severity === 'error').length, 0, 'fixture must pass the weaker draft gate');
      writeFileSync(target, JSON.stringify(document(candidate.subtitle)));
      const child = spawnSync('bash', ['-c', verificationStep.run], {
        cwd: fixtureRoot, encoding: 'utf8',
        env: { ...process.env, REPORT_IDS: 'publication-clean\npublication-candidate' },
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
}

console.log('[check-translation-editor] ✓ source-anchored editor gates verified.');
