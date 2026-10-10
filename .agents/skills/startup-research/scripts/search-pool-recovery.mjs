import { canonicalSourceUrl, normalizeDomain } from './utils.mjs';

export const NET_NEW_RESERVE_COUNT = 2;

function uniqueCandidates(candidates) {
  return [...new Map(candidates.map((candidate) => [
    canonicalSourceUrl(candidate.url), candidate,
  ])).values()];
}

export function successfulPoolMetrics(pool, fetchedByUrl) {
  const successfulCandidates = uniqueCandidates(pool.recommended.filter(
    (candidate) => fetchedByUrl.get(candidate.url)?.ok,
  ));
  return {
    successful: successfulCandidates.length,
    successfulDomains: new Set(
      successfulCandidates.map((candidate) => normalizeDomain(candidate.url)).filter(Boolean),
    ),
    successfulNetNew: successfulCandidates.filter(
      (candidate) => candidate.allocation === 'net-new',
    ).length,
  };
}

export function promoteReserveEvidence(pool, fetchedByUrl) {
  const recommended = uniqueCandidates(pool.recommended);
  const usedUrls = new Set(recommended.map((candidate) => canonicalSourceUrl(candidate.url)));
  const reserve = uniqueCandidates(pool.reserve).filter(
    (candidate) => !usedUrls.has(canonicalSourceUrl(candidate.url)),
  );
  const metrics = successfulPoolMetrics({ ...pool, recommended }, fetchedByUrl);
  const promoted = [];
  for (const candidate of reserve) {
    const sourcesSatisfied = metrics.successful >= pool.evidenceTarget.minSources;
    const domainsSatisfied = metrics.successfulDomains.size >= pool.evidenceTarget.minDomains;
    const netNewSatisfied = metrics.successfulNetNew >= pool.evidenceTarget.minNetNewSources;
    if (sourcesSatisfied && domainsSatisfied && netNewSatisfied) break;
    if (!fetchedByUrl.get(candidate.url)?.ok) continue;

    const domain = normalizeDomain(candidate.url);
    const addsNeededSource = !sourcesSatisfied;
    const addsNeededDomain = !domainsSatisfied && domain && !metrics.successfulDomains.has(domain);
    const addsNeededNetNew = (
      !netNewSatisfied
      && candidate.allocation === 'net-new-reserve'
    );
    if (!addsNeededSource && !addsNeededDomain && !addsNeededNetNew) continue;

    const allocation = candidate.allocation === 'net-new-reserve' ? 'net-new' : 'reserve-recovery';
    promoted.push({ ...candidate, allocation });
    usedUrls.add(canonicalSourceUrl(candidate.url));
    metrics.successful += 1;
    if (domain) metrics.successfulDomains.add(domain);
    if (allocation === 'net-new') metrics.successfulNetNew += 1;
  }

  return {
    promoted,
    recommended: [...recommended, ...promoted],
    reserve: reserve.filter((candidate) => !usedUrls.has(canonicalSourceUrl(candidate.url))),
    ...metrics,
  };
}

export function replenishReserveEvidence(pools, candidates, fetchedByUrl) {
  const deficient = new Set(pools.filter(pool => {
    const metrics = successfulPoolMetrics(pool, fetchedByUrl);
    return metrics.successful < pool.evidenceTarget.minSources
      || metrics.successfulDomains.size < pool.evidenceTarget.minDomains
      || metrics.successfulNetNew < pool.evidenceTarget.minNetNewSources;
  }).map(pool => pool.key));
  const protectedUrls = new Set(pools.flatMap(pool => [
    ...pool.recommended, ...(deficient.has(pool.key) ? pool.reserve : []),
  ].map(candidate => canonicalSourceUrl(candidate.url))));
  const available = uniqueCandidates(candidates).filter(candidate =>
    candidate.sourceQuality?.tier !== 'low'
    && !protectedUrls.has(canonicalSourceUrl(candidate.url))
    && (!fetchedByUrl.has(candidate.url) || fetchedByUrl.get(candidate.url)?.ok))
    .sort((left, right) => Number(Boolean(fetchedByUrl.get(right.url)?.ok))
      - Number(Boolean(fetchedByUrl.get(left.url)?.ok)));
  const transferred = new Set();
  const result = pools.map(pool => deficient.has(pool.key)
    ? { ...pool, reserve: pool.reserve.filter(candidate => fetchedByUrl.get(candidate.url)?.ok) }
    : pool);
  // Release only surplus backups, never another chapter's recommended evidence.
  for (let round = 0; round < 6 && available.length; round += 1) {
    for (const pool of result) {
      if (!deficient.has(pool.key) || pool.reserve.length >= 6 || !available.length) continue;
      const candidate = available.shift();
      pool.reserve.push({ ...candidate, allocation: 'net-new-reserve' });
      transferred.add(canonicalSourceUrl(candidate.url));
    }
  }
  const exclusiveUrls = new Set(result.flatMap(pool => [
    ...pool.recommended, ...pool.reserve,
  ].filter(candidate => ['net-new', 'net-new-reserve'].includes(candidate.allocation))
    .map(candidate => canonicalSourceUrl(candidate.url))));
  for (const pool of result) {
    if (!deficient.has(pool.key)) continue;
    const metrics = successfulPoolMetrics(pool, fetchedByUrl);
    if (metrics.successful >= pool.evidenceTarget.minSources
        && metrics.successfulDomains.size >= pool.evidenceTarget.minDomains) continue;
    const localUrls = new Set([...pool.recommended, ...pool.reserve]
      .map(candidate => canonicalSourceUrl(candidate.url)));
    const shared = uniqueCandidates(candidates).filter(candidate =>
      candidate.sourceQuality?.tier !== 'low'
      && fetchedByUrl.get(candidate.url)?.ok
      && !exclusiveUrls.has(canonicalSourceUrl(candidate.url))
      && !localUrls.has(canonicalSourceUrl(candidate.url)))
      .sort((left, right) => Number(!metrics.successfulDomains.has(normalizeDomain(right.url)))
        - Number(!metrics.successfulDomains.has(normalizeDomain(left.url))));
    for (const candidate of shared) {
      if (pool.reserve.length >= 6) break;
      pool.reserve.push({ ...candidate, allocation: 'shared-recovery' });
    }
  }
  return result.map(pool => {
    if (deficient.has(pool.key)) return pool;
    const reserve = pool.reserve.filter(candidate => !transferred.has(canonicalSourceUrl(candidate.url)));
    return reserve.length === pool.reserve.length ? pool : { ...pool, reserve };
  });
}

export function recoverExclusiveEvidence(pools, candidates, fetchedByUrl) {
  const result = pools.map(pool => ({
    ...pool, recommended: [...pool.recommended], reserve: [...pool.reserve],
  }));
  const usable = uniqueCandidates(candidates).filter(candidate =>
    candidate.sourceQuality?.tier !== 'low' && fetchedByUrl.get(candidate.url)?.ok);
  const externalCount = recommended => recommended.filter(candidate =>
    fetchedByUrl.get(candidate.url)?.ok
    && !candidate.sourceQuality?.reasons?.includes('official-domain')).length;
  const exclusive = new Set(result.flatMap(pool => [...pool.recommended, ...pool.reserve]
    .filter(candidate => ['net-new', 'net-new-reserve'].includes(candidate.allocation))
    .map(candidate => canonicalSourceUrl(candidate.url))));
  for (const pool of result) {
    for (const candidate of usable) {
      if (successfulPoolMetrics(pool, fetchedByUrl).successfulNetNew >= pool.evidenceTarget.minNetNewSources) break;
      const url = canonicalSourceUrl(candidate.url);
      if (exclusive.has(url)) continue;
      if (!pool.recommended.some(entry => canonicalSourceUrl(entry.url) === url)
          && successfulPoolMetrics(pool, fetchedByUrl).successful >= (pool.evidenceTarget.maxSources ?? Infinity)) continue;
      const requiredForReportDomains = result.some(entry => entry.recommended.some(selected =>
        canonicalSourceUrl(selected.url) === url
        && (selected.requiredForReportDomains || selected.allocation === 'report-diversity')));
      const replacements = [];
      let safe = true;
      for (const sibling of result.filter(other => other !== pool)) {
        const removed = sibling.recommended.find(entry => canonicalSourceUrl(entry.url) === url);
        const recommended = sibling.recommended.filter(entry => canonicalSourceUrl(entry.url) !== url);
        if (recommended.length === sibling.recommended.length) continue;
        const minExternal = Math.min(Math.ceil(sibling.evidenceTarget.minSources / 2),
          externalCount(sibling.recommended));
        let metrics = successfulPoolMetrics({ ...sibling, recommended }, fetchedByUrl);
        if (metrics.successful < sibling.evidenceTarget.minSources
            || metrics.successfulDomains.size < sibling.evidenceTarget.minDomains
            || externalCount(recommended) < minExternal
            || removed.allocation === 'independent-candidate') {
          const local = new Set(recommended.map(entry => canonicalSourceUrl(entry.url)));
          const replacement = usable.find(entry => {
            const key = canonicalSourceUrl(entry.url);
            if (key === url || local.has(key) || exclusive.has(key)) return false;
            if (!candidate.sourceQuality?.reasons?.includes('official-domain')
                && entry.sourceQuality?.reasons?.includes('official-domain')) return false;
            const restored = successfulPoolMetrics({ ...sibling, recommended: [...recommended, entry] }, fetchedByUrl);
            return restored.successful >= sibling.evidenceTarget.minSources
              && restored.successfulDomains.size >= sibling.evidenceTarget.minDomains
              && externalCount([...recommended, entry]) >= minExternal;
          });
          if (!replacement) { safe = false; break; }
          recommended.push({ ...replacement, allocation: removed.allocation === 'independent-candidate'
            ? 'independent-candidate' : 'shared-recovery' });
          metrics = successfulPoolMetrics({ ...sibling, recommended }, fetchedByUrl);
        }
        if (metrics.successfulNetNew < successfulPoolMetrics(sibling, fetchedByUrl).successfulNetNew) {
          safe = false;
          break;
        }
        replacements.push({ sibling, recommended });
      }
      if (!safe) continue;
      for (const { sibling, recommended } of replacements) sibling.recommended = recommended;
      for (const sibling of result) {
        sibling.reserve = sibling.reserve.filter(entry => canonicalSourceUrl(entry.url) !== url
          && !sibling.recommended.some(selected => canonicalSourceUrl(selected.url) === canonicalSourceUrl(entry.url)));
      }
      const index = pool.recommended.findIndex(entry => canonicalSourceUrl(entry.url) === url);
      const selected = { ...candidate, allocation: 'net-new', ...(requiredForReportDomains ? { requiredForReportDomains: true } : {}) };
      if (index < 0) pool.recommended.push(selected);
      else pool.recommended[index] = selected;
      exclusive.add(url);
    }
  }
  return result;
}

export function recoverReportDomains(pools, candidates, fetchedByUrl, target) {
  const result = pools.map(pool => ({
    ...pool, recommended: [...pool.recommended], reserve: [...pool.reserve],
  }));
  const domains = new Set(result.flatMap(pool => pool.recommended
    .filter(candidate => fetchedByUrl.get(candidate.url)?.ok)
    .map(candidate => normalizeDomain(candidate.url))));
  for (const candidate of uniqueCandidates(candidates)) {
    if (domains.size >= target) break;
    const domain = normalizeDomain(candidate.url);
    if (!domain || domains.has(domain) || candidate.sourceQuality?.tier === 'low'
        || !fetchedByUrl.get(candidate.url)?.ok) continue;
    const url = canonicalSourceUrl(candidate.url);
    const owner = result.find(pool => [...pool.recommended, ...pool.reserve].some(entry =>
      canonicalSourceUrl(entry.url) === url && ['net-new', 'net-new-reserve'].includes(entry.allocation)));
    const pool = (owner ? [owner] : result).toSorted((left, right) => left.recommended.length - right.recommended.length)
      .find(entry => successfulPoolMetrics(entry, fetchedByUrl).successful < (entry.evidenceTarget.maxSources ?? Infinity));
    if (!pool) continue;
    pool.recommended.push({ ...candidate, allocation: owner ? 'net-new' : 'report-diversity', requiredForReportDomains: true });
    pool.reserve = pool.reserve.filter(entry => canonicalSourceUrl(entry.url) !== url);
    domains.add(domain);
  }
  return result;
}
