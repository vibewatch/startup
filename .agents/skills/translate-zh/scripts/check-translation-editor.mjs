#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

const checks = [
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
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('[check-translation-editor] ✓ source-anchored editor gates verified.');
