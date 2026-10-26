import { canonicalSourceUrl, registrableDomain } from './utils.mjs';

export const NET_NEW_RESERVE_COUNT = 2;

function isCompanyControlledPoolCandidate(candidate) {
  const reasons = candidate?.sourceQuality?.reasons ?? [];
  return reasons.includes('official-domain') || reasons.includes('wire-service');
}

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
      successfulCandidates.map((candidate) => registrableDomain(candidate.url)).filter(Boolean),
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
  while (true) {
    const sourcesSatisfied = metrics.successful >= pool.evidenceTarget.minSources;
    const domainsSatisfied = metrics.successfulDomains.size >= pool.evidenceTarget.minDomains;
    const netNewSatisfied = metrics.successfulNetNew >= pool.evidenceTarget.minNetNewSources;
    if (sourcesSatisfied && domainsSatisfied && netNewSatisfied) break;
    const orderedReserve = netNewSatisfied
      ? [
        ...reserve.filter((entry) => entry.allocation !== 'net-new-reserve'),
        ...reserve.filter((entry) => entry.allocation === 'net-new-reserve'),
      ]
      : reserve;
    const candidate = orderedReserve.find((entry) => {
      if (usedUrls.has(canonicalSourceUrl(entry.url)) || !fetchedByUrl.get(entry.url)?.ok) return false;
      const domain = registrableDomain(entry.url);
      const addsNeededSource = !sourcesSatisfied;
      const addsNeededDomain = !domainsSatisfied && domain && !metrics.successfulDomains.has(domain);
      const addsNeededNetNew = !netNewSatisfied && entry.allocation === 'net-new-reserve';
      return addsNeededSource || addsNeededDomain || addsNeededNetNew;
    });
    if (!candidate) break;

    const domain = registrableDomain(candidate.url);
    const allocation = (!netNewSatisfied && candidate.allocation === 'net-new-reserve')
      ? 'net-new'
      : 'reserve-recovery';
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
  const needsNetNew = pool => {
    const okNetNew = uniqueCandidates(pool.recommended).filter(
      candidate => candidate.allocation === 'net-new' && fetchedByUrl.get(candidate.url)?.ok,
    ).length;
    return okNetNew < pool.evidenceTarget.minNetNewSources;
  };
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
      if (!deficient.has(pool.key) || !needsNetNew(pool) || !available.length) continue;
      if (pool.reserve.length < 6) {
        const candidate = available.shift();
        pool.reserve.push({ ...candidate, allocation: 'net-new-reserve' });
        transferred.add(canonicalSourceUrl(candidate.url));
      } else if (pool.reserve.filter(entry => entry.allocation === 'net-new-reserve').length < pool.evidenceTarget.minNetNewSources) {
        const replaceIdx = pool.reserve.findLastIndex(entry => entry.allocation !== 'net-new-reserve');
        if (replaceIdx >= 0) {
          const candidate = available.shift();
          pool.reserve[replaceIdx] = { ...candidate, allocation: 'net-new-reserve' };
          transferred.add(canonicalSourceUrl(candidate.url));
        }
      }
    }
  }
  for (let round = 0; round < 6 && available.some(candidate => !fetchedByUrl.has(candidate.url)); round += 1) {
    for (const pool of result) {
      const index = available.findIndex(candidate => !fetchedByUrl.has(candidate.url));
      if (!deficient.has(pool.key) || index < 0) continue;
      if (pool.reserve.length < 6) {
        const [candidate] = available.splice(index, 1);
        pool.reserve.push({ ...candidate, allocation: 'net-new-reserve' });
        transferred.add(canonicalSourceUrl(candidate.url));
      } else if (needsNetNew(pool)
          && pool.reserve.filter(entry => entry.allocation === 'net-new-reserve').length < pool.evidenceTarget.minNetNewSources) {
        const replaceIdx = pool.reserve.findLastIndex(entry => entry.allocation !== 'net-new-reserve');
        if (replaceIdx >= 0) {
          const [candidate] = available.splice(index, 1);
          pool.reserve[replaceIdx] = { ...candidate, allocation: 'net-new-reserve' };
          transferred.add(canonicalSourceUrl(candidate.url));
        }
      }
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
      .sort((left, right) => Number(!metrics.successfulDomains.has(registrableDomain(right.url)))
        - Number(!metrics.successfulDomains.has(registrableDomain(left.url))));
    for (const candidate of shared) {
      if (pool.reserve.length < 6) {
        pool.reserve.push({ ...candidate, allocation: 'shared-recovery' });
      } else if (metrics.successfulDomains.size < pool.evidenceTarget.minDomains
          && !metrics.successfulDomains.has(registrableDomain(candidate.url))) {
        const replaceIdx = pool.reserve.findLastIndex(entry =>
          entry.allocation !== 'net-new-reserve'
          && metrics.successfulDomains.has(registrableDomain(entry.url)));
        if (replaceIdx >= 0) {
          pool.reserve[replaceIdx] = { ...candidate, allocation: 'shared-recovery' };
        }
      }
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
  for (const pool of result) {
    let seenOkNetNew = 0;
    pool.recommended = pool.recommended.map(entry => {
      if (entry.allocation === 'net-new' && fetchedByUrl.get(entry.url)?.ok) {
        seenOkNetNew += 1;
        if (seenOkNetNew > pool.evidenceTarget.minNetNewSources) {
          return { ...entry, allocation: 'reserve-recovery' };
        }
      }
      return entry;
    });
  }
  const usable = uniqueCandidates(candidates).filter(candidate =>
    candidate.sourceQuality?.tier !== 'low' && fetchedByUrl.get(candidate.url)?.ok);
  const externalCount = recommended => recommended.filter(candidate =>
    fetchedByUrl.get(candidate.url)?.ok
    && !candidate.sourceQuality?.reasons?.includes('official-domain')).length;
  const hasNetNewDeficit = result.some(
    pool => successfulPoolMetrics(pool, fetchedByUrl).successfulNetNew < pool.evidenceTarget.minNetNewSources,
  );
  const exclusive = new Set(result.flatMap(pool => [
    ...pool.recommended,
    ...(hasNetNewDeficit && successfulPoolMetrics(pool, fetchedByUrl).successfulNetNew >= pool.evidenceTarget.minNetNewSources
      ? []
      : pool.reserve),
  ]
    .filter(candidate => ['net-new', 'net-new-reserve'].includes(candidate.allocation))
    .map(candidate => canonicalSourceUrl(candidate.url))));
  for (const pool of result) {
    for (const candidate of usable) {
      if (successfulPoolMetrics(pool, fetchedByUrl).successfulNetNew >= pool.evidenceTarget.minNetNewSources) break;
      const url = canonicalSourceUrl(candidate.url);
      if (exclusive.has(url)) continue;
      if (result.some(sibling => sibling !== pool && sibling.recommended.some(entry =>
        canonicalSourceUrl(entry.url) === url && entry.requiredForRefreshEvidence))) continue;
      if (!pool.recommended.some(entry => canonicalSourceUrl(entry.url) === url)
          && successfulPoolMetrics(pool, fetchedByUrl).successful >= (pool.evidenceTarget.maxSources ?? Infinity)) continue;
      const requiredForReportDomains = result.some(entry => entry.recommended.some(selected =>
        canonicalSourceUrl(selected.url) === url
        && (selected.requiredForReportDomains || selected.allocation === 'report-diversity')));
      const requiredForRefreshEvidence = result.some(entry => entry.recommended.some(selected =>
        canonicalSourceUrl(selected.url) === url && selected.requiredForRefreshEvidence));
      const replacements = [];
      let safe = true;
      for (const sibling of result.filter(other => other !== pool)) {
        const beforeMetrics = successfulPoolMetrics(sibling, fetchedByUrl);
        const targetSources = Math.min(sibling.evidenceTarget.minSources, beforeMetrics.successful);
        const targetDomains = Math.min(sibling.evidenceTarget.minDomains, beforeMetrics.successfulDomains.size);
        const targetNetNew = Math.min(sibling.evidenceTarget.minNetNewSources, beforeMetrics.successfulNetNew);
        const removed = sibling.recommended.find(entry => canonicalSourceUrl(entry.url) === url);
        const recommended = sibling.recommended.filter(entry => canonicalSourceUrl(entry.url) !== url);
        if (recommended.length === sibling.recommended.length) continue;
        const minExternal = Math.min(Math.ceil(sibling.evidenceTarget.minSources / 2),
          externalCount(sibling.recommended));
        let metrics = successfulPoolMetrics({ ...sibling, recommended }, fetchedByUrl);
        if (metrics.successful < targetSources
            || metrics.successfulDomains.size < targetDomains
            || externalCount(recommended) < minExternal
            || removed.allocation === 'independent-candidate') {
          const local = new Set(recommended.map(entry => canonicalSourceUrl(entry.url)));
          const replacement = usable.find(entry => {
            const key = canonicalSourceUrl(entry.url);
            if (key === url || local.has(key) || exclusive.has(key)) return false;
            if (!candidate.sourceQuality?.reasons?.includes('official-domain')
                && entry.sourceQuality?.reasons?.includes('official-domain')) return false;
            const restored = successfulPoolMetrics({ ...sibling, recommended: [...recommended, entry] }, fetchedByUrl);
            return restored.successful >= targetSources
              && restored.successfulDomains.size >= targetDomains
              && externalCount([...recommended, entry]) >= minExternal;
          });
          if (!replacement) { safe = false; break; }
          recommended.push({ ...replacement, allocation: removed.allocation === 'independent-candidate'
            ? 'independent-candidate' : 'shared-recovery' });
          metrics = successfulPoolMetrics({ ...sibling, recommended }, fetchedByUrl);
        }
        if (metrics.successfulNetNew < targetNetNew) {
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
      const selected = { ...candidate, allocation: 'net-new',
        ...(requiredForReportDomains ? { requiredForReportDomains: true } : {}),
        ...(requiredForRefreshEvidence ? { requiredForRefreshEvidence: true } : {}) };
      if (index < 0) pool.recommended.push(selected);
      else pool.recommended[index] = selected;
      exclusive.add(url);
    }
  }
  return result;
}

export function recoverRefreshEvidence(pools, candidates, fetchedByUrl) {
  const result = pools.map(pool => ({
    ...pool, recommended: [...pool.recommended], reserve: [...pool.reserve],
  }));
  const exclusiveOwner = new Map(result.flatMap(pool => [...pool.recommended, ...pool.reserve]
    .filter(candidate => ['net-new', 'net-new-reserve'].includes(candidate.allocation))
    .map(candidate => [canonicalSourceUrl(candidate.url), pool.key])));
  for (const pool of result) {
    let retained = 0;
    const orderedCandidates = uniqueCandidates(candidates).sort((left, right) => (
      Number(Boolean(right.priorSources?.some(source => source.chapter === pool.key && source.stance === 'adverse')))
        - Number(Boolean(left.priorSources?.some(source => source.chapter === pool.key && source.stance === 'adverse')))
    ));
    for (const candidate of orderedCandidates) {
      const url = canonicalSourceUrl(candidate.url);
      const owner = exclusiveOwner.get(url);
      if (candidate.sourceQuality?.tier === 'low' || !fetchedByUrl.get(candidate.url)?.ok
          || (owner && owner !== pool.key)
          || !candidate.priorSources?.some(source => source.chapter === pool.key)) continue;
      if (retained >= 2) {
        const inPool = pool.recommended.some(entry => canonicalSourceUrl(entry.url) === url)
          || pool.reserve.some(entry => canonicalSourceUrl(entry.url) === url);
        if (!inPool) {
          const reserveEntry = { ...candidate, allocation: owner ? 'net-new-reserve' : 'refresh-reserve' };
          if (pool.reserve.length < 6) {
            pool.reserve.push(reserveEntry);
          } else {
            const replaceIdx = pool.reserve.findLastIndex(entry =>
              entry.allocation !== 'net-new-reserve'
              && (!fetchedByUrl.get(entry.url)?.ok || isCompanyControlledPoolCandidate(entry)));
            if (replaceIdx >= 0) pool.reserve[replaceIdx] = reserveEntry;
          }
        }
        continue;
      }
      const index = pool.recommended.findIndex(entry => canonicalSourceUrl(entry.url) === url);
      if (index < 0 && successfulPoolMetrics(pool, fetchedByUrl).successful >= (pool.evidenceTarget.maxSources ?? Infinity)) {
        const removableIndex = pool.recommended.findLastIndex(entry =>
          isCompanyControlledPoolCandidate(entry)
          && entry.allocation !== 'net-new'
          && !entry.requiredForReportDomains
          && !entry.requiredForRefreshEvidence);
        if (removableIndex < 0) continue;
        pool.recommended.splice(removableIndex, 1);
      }
      const selected = { ...(index < 0 ? { ...candidate, allocation: owner ? 'net-new' : 'refresh-recovery' }
        : pool.recommended[index]), requiredForRefreshEvidence: true };
      if (index < 0) pool.recommended.push(selected);
      else pool.recommended[index] = selected;
      pool.reserve = pool.reserve.filter(entry => canonicalSourceUrl(entry.url) !== url);
      retained += 1;
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
    .map(candidate => registrableDomain(candidate.url))));
  for (const candidate of uniqueCandidates(candidates)) {
    if (domains.size >= target) break;
    const domain = registrableDomain(candidate.url);
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
