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
