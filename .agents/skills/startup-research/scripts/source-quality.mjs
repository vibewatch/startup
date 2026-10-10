export function sourceQuality(result, { officialDomain, runYear }, quality) {
  let domain = '';
  try {
    const url = new URL(result.url);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      return { score: -25, tier: 'low', reasons: ['invalid-url'] };
    }
    domain = url.hostname.toLowerCase().replace(/^www\./, '');
  }
  catch { return { score: -25, tier: 'low', reasons: ['invalid-url'] }; }
  let score = 0;
  const reasons = [];
  const official = String(officialDomain ?? '').toLowerCase().replace(/^www\./, '');
  if (official && (domain === official || domain.endsWith(`.${official}`))) {
    score += 40;
    reasons.push('official-domain');
  }
  if (domain.endsWith('.gov') || domain.endsWith('.gov.uk') || domain === 'sec.gov') {
    score += 35;
    reasons.push('government-or-regulator');
  }
  if (quality.highReputationDomains.includes(domain)) {
    score += 20;
    reasons.push('high-reputation-publisher');
  }
  if (quality.lowSignalDomains.includes(domain)) {
    score -= 25;
    reasons.push('low-signal-platform');
  }
  if ((result.content ?? result.snippet ?? '').length >= 200) {
    score += 5;
    reasons.push('substantive-preview');
  }
  if (runYear && `${result.title} ${result.snippet} ${result.content}`.includes(runYear)) {
    score += 5;
    reasons.push('current-run-year');
  }
  return {
    score,
    tier: score >= 25 ? 'high' : score >= 0 ? 'medium' : 'low',
    reasons,
  };
}
