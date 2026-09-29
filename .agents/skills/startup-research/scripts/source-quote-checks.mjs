import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isAccessErrorResponse } from '../../fetch-url/scripts/fetch.mjs';
import { canonicalSourceUrl, FINAL_ARTIFACTS, hasText, isRunId, researchCacheDir } from './utils.mjs';

function readPrefetchedText(outputFile) {
  const match = outputFile.match(/(?:^|\/)(\.research-cache\/([^/]+)\/fetched\/([a-f0-9]{16}\.txt))$/u);
  if (!match || !isRunId(match[2])) return readFileSync(outputFile, 'utf8');
  const [, sourcePath, runId, filename] = match;
  const cache = researchCacheDir(runId);
  const manifestPath = join(cache, 'source-evidence-manifest.json');
  const manifestStat = lstatSync(manifestPath, { throwIfNoEntry: false });
  if (!manifestStat) return readFileSync(outputFile, 'utf8');

  // Replay original runner paths only through an explicitly restored, hash-checked archive.
  const localFile = join(cache, 'fetched', filename);
  for (const path of [dirname(cache), cache, manifestPath, dirname(localFile), localFile]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('archived source replay rejects symlinked paths');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 'research-evidence-archive-v1' || manifest.runId !== runId
      || typeof manifest.workspaceRoot !== 'string' || !isAbsolute(manifest.workspaceRoot)
      || !Array.isArray(manifest.files)) {
    throw new Error('invalid source archive manifest');
  }
  if (resolve(manifest.workspaceRoot, sourcePath) !== resolve(manifest.workspaceRoot, outputFile)) {
    throw new Error('archive manifest does not match the original source path');
  }
  const entries = manifest.files.filter(entry => entry?.sourcePath === sourcePath);
  const entry = entries[0];
  if (entries.length !== 1 || entry.archivedPath !== `research-evidence/${runId}/fetched/${filename}`
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new Error('missing, ambiguous or invalid source archive manifest entry');
  }
  const bytes = readFileSync(localFile);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('archived source size or SHA-256 does not match the original manifest');
  }
  return bytes.toString('utf8');
}

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

function matchesOrderedQuote(quote, text) {
  const fragments = quote.split(/\.{3,}/u).map((part) => part.trim()).filter(Boolean);
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

export function isVerbatimSourceQuote(quote, sourceText) {
  const text = normalizeText(sourceText);
  const normalizedQuote = normalizeText(quote);
  if (matchesOrderedQuote(normalizedQuote, text)) return true;
  const wordDashSpacing = /(?<=\p{L})\s*-\s*(?=\p{L})/gu;
  return matchesOrderedQuote(
    normalizedQuote.replace(wordDashSpacing, '-'),
    text.replace(wordDashSpacing, '-'),
  );
}

export function checkDistinctChapterSources(sources, file) {
  const seen = new Map();
  const issues = [];
  for (const source of sources) {
    const url = canonicalSourceUrl(source?.url);
    if (!url) continue;
    if (seen.has(url)) {
      issues.push({
        path: `${file}:localEvidence.sources.${source.id}`,
        code: 'duplicateSourceUrl',
        message: `Sources ${seen.get(url)} and ${source.id} cite the same canonical URL: ${url}`,
        fix: 'Keep one source ID per canonical URL and update its claim references. Meet the source floor with distinct relevant evidence, not duplicate IDs or tracking-URL variants.',
      });
    } else seen.set(url, source.id);
  }
  return issues;
}

export function checkPrefetchedSourceQuotes(sources, fetchedSources, file) {
  const fetchedByUrl = new Map(fetchedSources.map((entry) => [canonicalSourceUrl(entry.url), entry]));
  const textByFile = new Map();
  const issues = file === FINAL_ARTIFACTS.evidence.file ? [] : checkDistinctChapterSources(sources, file);
  for (const source of sources) {
    const path = `${file}:localEvidence.sources.${source.id}.keyQuote`;
    const fetched = fetchedByUrl.get(canonicalSourceUrl(source.url));
    let text;
    try {
      if (!fetched?.ok || !hasText(fetched.outputFile)) throw new Error('no successful prefetched text file');
      if (!textByFile.has(fetched.outputFile)) textByFile.set(fetched.outputFile, readPrefetchedText(fetched.outputFile));
      text = textByFile.get(fetched.outputFile);
      if (!hasText(text)) throw new Error('prefetched source has no readable text');
    } catch (error) {
      issues.push({
        path,
        code: 'sourceQuoteTextMissing',
        message: `Cannot verify quotation for ${source.url}: ${error.message}`,
        fix: 'Restore the original successful prefetched text before finalization; do not fabricate evidence or fetch-trail entries.',
      });
      continue;
    }
    if (isAccessErrorResponse({ ...fetched, body: text })) {
      issues.push({
        path: `${file}:localEvidence.sources.${source.id}`,
        code: 'sourceContentBlocked',
        message: `Fetched text for ${source.url} is an access-error page, not source evidence.`,
        fix: 'Replace this citation and its dependent claims using relevant successful evidence in the assigned pool, or report an evidence blocker. Never quote an access-error message as support.',
      });
      continue;
    }
    if (!hasText(source?.keyQuote)) continue;
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
