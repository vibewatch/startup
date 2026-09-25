import { normalizeDomain } from './utils.mjs';

export const NET_NEW_RESERVE_COUNT = 2;

export function netNewAllocationTarget(minimum) {
  return minimum + NET_NEW_RESERVE_COUNT;
}

export function successfulPoolMetrics(pool, fetchedByUrl) {
  const successfulCandidates = pool.recommended.filter(
    (candidate) => fetchedByUrl.get(candidate.url)?.ok,
  );
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
  const metrics = successfulPoolMetrics(pool, fetchedByUrl);
  const promoted = [];
  for (const candidate of pool.reserve) {
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

    const allocation = addsNeededNetNew ? 'net-new' : 'reserve-recovery';
    promoted.push({ ...candidate, allocation });
    metrics.successful += 1;
    if (domain) metrics.successfulDomains.add(domain);
    if (allocation === 'net-new') metrics.successfulNetNew += 1;
  }

  const promotedUrls = new Set(promoted.map((candidate) => candidate.url));
  return {
    promoted,
    reserve: pool.reserve.filter((candidate) => !promotedUrls.has(candidate.url)),
    ...metrics,
  };
}
