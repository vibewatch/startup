import { readFileSync } from 'node:fs';
import { canonicalSourceUrl, hasText } from './utils.mjs';

function normalizeText(text) {
  return text.normalize('NFC')
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[–—−]/gu, '-')
    .replace(/…/gu, '...')
    .replace(/\s+/gu, ' ')
    .trim();
}

function completeBoundary(text, fragment, index) {
  const word = /[\p{L}\p{N}_]/u;
  const end = index + fragment.length;
  if (word.test(fragment[0]) && word.test(text[index - 1] ?? '')) return false;
  if (word.test(fragment.at(-1)) && word.test(text[end] ?? '')) return false;
  if (/^\p{Sc}?\d/u.test(fragment) && /(?:\d[.,]|[+\-\p{Sc}])$/u.test(text.slice(0, index))) return false;
  if (/\d/u.test(fragment.at(-1)) && /^(?:[.,]\d|[%‰])/u.test(text.slice(end))) return false;
  return true;
}

export function isVerbatimSourceQuote(quote, sourceText) {
  const text = normalizeText(sourceText);
  const fragments = normalizeText(quote).split(/\.{3,}/u).map((part) => part.trim()).filter(Boolean);
  if (fragments.length === 0) return false;
  let cursor = 0;
  for (const fragment of fragments) {
    let index = text.indexOf(fragment, cursor);
    while (index >= 0 && !completeBoundary(text, fragment, index)) {
      index = text.indexOf(fragment, index + 1);
    }
    if (index < 0) return false;
    cursor = index + fragment.length;
  }
  return true;
}

export function checkPrefetchedSourceQuotes(sources, fetchedSources, file) {
  const fetchedByUrl = new Map(fetchedSources.map((entry) => [canonicalSourceUrl(entry.url), entry]));
  const textByFile = new Map();
  const issues = [];
  for (const source of sources) {
    if (!hasText(source?.keyQuote)) continue;
    const path = `${file}:localEvidence.sources.${source.id}.keyQuote`;
    const fetched = fetchedByUrl.get(canonicalSourceUrl(source.url));
    let text;
    try {
      if (!fetched?.ok || !hasText(fetched.outputFile)) throw new Error('no successful prefetched text file');
      if (!textByFile.has(fetched.outputFile)) textByFile.set(fetched.outputFile, readFileSync(fetched.outputFile, 'utf8'));
      text = textByFile.get(fetched.outputFile);
    } catch (error) {
      issues.push({
        path,
        code: 'sourceQuoteTextMissing',
        message: `Cannot verify quotation for ${source.url}: ${error.message}`,
        fix: 'Restore the original successful prefetched text before finalization; do not fabricate evidence or fetch-trail entries.',
      });
      continue;
    }
    if (isVerbatimSourceQuote(source.keyQuote, text)) continue;
    issues.push({
      path,
      code: 'sourceQuoteMismatch',
      message: `Quotation is not a verbatim, ordered excerpt of the fetched text for ${source.url}`,
      fix: 'Use the original source wording, with ellipses only for omissions. Keep interpretations in analysis, not keyQuote; re-check dependent claims if the source does not support them.',
    });
  }
  return issues;
}
