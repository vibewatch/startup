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
