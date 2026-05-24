import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  slugify,
  normalizeCompanyName,
  normalizeDomain,
  canonicalSourceUrl,
  companySlugFromRunId,
  runDateFromRunId,
  nowRunTimestamp,
  isRunId,
  researchCacheDir,
  hasText,
  parseDate,
  registrableDomain,
  collectClaimRefs,
  normalizeRevision,
} from '../.agents/skills/startup-research/scripts/utils.mjs';

describe('slugify', () => {
  it('lowercases and replaces non-alphanumeric with hyphens', () => {
    assert.equal(slugify('Hello World'), 'hello-world');
  });

  it('replaces ampersand with "and"', () => {
    assert.equal(slugify('A & B'), 'a-and-b');
  });

  it('strips leading/trailing hyphens', () => {
    assert.equal(slugify('  --hello--  '), 'hello');
  });

  it('normalizes unicode (NFKD)', () => {
    assert.equal(slugify('café'), 'cafe');
  });

  it('truncates at 80 characters', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long).length, 80);
  });

  it('returns "startup" for empty/null input', () => {
    assert.equal(slugify(''), 'startup');
    assert.equal(slugify(null), 'startup');
    assert.equal(slugify(undefined), 'startup');
  });
});

describe('normalizeCompanyName', () => {
  it('removes corporate suffixes', () => {
    assert.equal(normalizeCompanyName('OpenAI Inc.'), 'openai');
    assert.equal(normalizeCompanyName('Acme Corp'), 'acme');
    assert.equal(normalizeCompanyName('Widgets LLC'), 'widgets');
    assert.equal(normalizeCompanyName('British Ltd'), 'british');
  });

  it('lowercases and normalizes whitespace', () => {
    assert.equal(normalizeCompanyName('  Hello   World  '), 'hello world');
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeCompanyName(null), '');
    assert.equal(normalizeCompanyName(undefined), '');
  });
});

describe('normalizeDomain', () => {
  it('extracts hostname from full URL', () => {
    assert.equal(normalizeDomain('https://www.example.com/page'), 'example.com');
  });

  it('strips www prefix', () => {
    assert.equal(normalizeDomain('https://www.openai.com'), 'openai.com');
  });

  it('handles bare domain input', () => {
    assert.equal(normalizeDomain('example.com'), 'example.com');
  });

  it('returns empty string for invalid input', () => {
    assert.equal(normalizeDomain(''), '');
    assert.equal(normalizeDomain(null), '');
  });
});

describe('canonicalSourceUrl', () => {
  it('strips UTM parameters', () => {
    const result = canonicalSourceUrl('https://example.com/page?utm_source=twitter&utm_medium=social');
    assert.equal(result, 'https://example.com/page');
  });

  it('strips tracking params (fbclid, gclid)', () => {
    const result = canonicalSourceUrl('https://example.com/?fbclid=abc123&foo=bar');
    assert.equal(result, 'https://example.com?foo=bar');
  });

  it('strips hash fragments', () => {
    const result = canonicalSourceUrl('https://example.com/page#section');
    assert.equal(result, 'https://example.com/page');
  });

  it('strips www prefix', () => {
    const result = canonicalSourceUrl('https://www.example.com/page');
    assert.equal(result, 'https://example.com/page');
  });

  it('removes trailing slash', () => {
    const result = canonicalSourceUrl('https://example.com/');
    assert.equal(result, 'https://example.com');
  });

  it('sorts query parameters', () => {
    const result = canonicalSourceUrl('https://example.com?z=1&a=2');
    assert.equal(result, 'https://example.com?a=2&z=1');
  });

  it('returns empty string for empty input', () => {
    assert.equal(canonicalSourceUrl(''), '');
    assert.equal(canonicalSourceUrl(null), '');
  });

  it('rejects non-http(s) schemes', () => {
    assert.equal(canonicalSourceUrl('javascript:alert(1)'), '');
    assert.equal(canonicalSourceUrl('data:text/html,<h1>hi</h1>'), '');
    assert.equal(canonicalSourceUrl('file:///etc/passwd'), '');
  });
});

describe('RUN_ID_RE and isRunId', () => {
  it('matches valid run IDs', () => {
    assert.ok(isRunId('20240101120000-acme-corp'));
    assert.ok(isRunId('20250524080000-openai'));
  });

  it('rejects invalid run IDs', () => {
    assert.ok(!isRunId(''));
    assert.ok(!isRunId(null));
    assert.ok(!isRunId('not-a-runid'));
    assert.ok(!isRunId('2024-acme'));
    assert.ok(!isRunId('/absolute/path/20240101120000-acme'));
  });
});

describe('companySlugFromRunId', () => {
  it('extracts slug from valid run ID', () => {
    assert.equal(companySlugFromRunId('20240101120000-acme-corp'), 'acme-corp');
    assert.equal(companySlugFromRunId('20250524080000-openai'), 'openai');
  });

  it('throws on invalid run ID', () => {
    assert.throws(() => companySlugFromRunId('invalid'), /runId matching/);
    assert.throws(() => companySlugFromRunId(null), /runId matching/);
  });
});

describe('runDateFromRunId', () => {
  it('extracts YYYY-MM-DD from run ID', () => {
    assert.equal(runDateFromRunId('20240315120000-acme'), '2024-03-15');
    assert.equal(runDateFromRunId('20250524080000-test'), '2025-05-24');
  });

  it('throws on invalid run ID', () => {
    assert.throws(() => runDateFromRunId('bad'), /runId matching/);
  });
});

describe('nowRunTimestamp', () => {
  it('formats a date as YYYYMMDDHHmmss (UTC)', () => {
    const date = new Date('2024-03-15T09:05:03Z');
    assert.equal(nowRunTimestamp(date), '20240315090503');
  });

  it('returns 14-character string', () => {
    assert.equal(nowRunTimestamp().length, 14);
  });
});

describe('researchCacheDir', () => {
  it('returns a path containing the runId', () => {
    const dir = researchCacheDir('20240101120000-acme');
    assert.ok(dir.includes('20240101120000-acme'));
    assert.ok(dir.includes('.research-cache'));
  });

  it('throws on invalid runId', () => {
    assert.throws(() => researchCacheDir('bad'), /runId matching/);
    assert.throws(() => researchCacheDir(null), /runId matching/);
  });
});

describe('hasText', () => {
  it('returns true for non-empty strings', () => {
    assert.ok(hasText('hello'));
    assert.ok(hasText(' x '));
  });

  it('returns false for empty/whitespace/non-string', () => {
    assert.ok(!hasText(''));
    assert.ok(!hasText('   '));
    assert.ok(!hasText(null));
    assert.ok(!hasText(undefined));
    assert.ok(!hasText(42));
  });
});

describe('parseDate', () => {
  it('parses YYYY-MM-DD strings', () => {
    const d = parseDate('2024-03-15');
    assert.ok(d instanceof Date);
    assert.equal(d.toISOString().slice(0, 10), '2024-03-15');
  });

  it('returns null for invalid input', () => {
    assert.equal(parseDate(''), null);
    assert.equal(parseDate(null), null);
    assert.equal(parseDate('not-a-date'), null);
  });

  it('handles Date objects', () => {
    const d = parseDate(new Date('2024-06-01T00:00:00Z'));
    assert.equal(d.toISOString().slice(0, 10), '2024-06-01');
  });
});

describe('registrableDomain', () => {
  it('extracts eTLD+1 from full URL', () => {
    assert.equal(registrableDomain('https://blog.example.com/page'), 'example.com');
  });

  it('returns empty string for invalid input', () => {
    assert.equal(registrableDomain(''), '');
    assert.equal(registrableDomain(null), '');
  });
});

describe('collectClaimRefs', () => {
  it('collects claimRefs from nested objects', () => {
    const data = {
      sections: [
        { claimRefs: ['ref1', 'ref2'], content: 'hello' },
        { nested: { claimRefs: ['ref3'] } },
      ],
    };
    const refs = collectClaimRefs(data);
    assert.deepEqual(refs, ['ref1', 'ref2', 'ref3']);
  });

  it('returns empty array when no claimRefs exist', () => {
    assert.deepEqual(collectClaimRefs({ foo: 'bar' }), []);
    assert.deepEqual(collectClaimRefs(null), []);
  });
});

describe('normalizeRevision', () => {
  it('defaults to "current" status', () => {
    const r = normalizeRevision({});
    assert.equal(r.status, 'current');
    assert.equal(r.refreshOfRunId, null);
    assert.equal(r.supersededByRunId, null);
  });

  it('preserves superseded status', () => {
    const r = normalizeRevision({ status: 'superseded', supersededByRunId: '20240101120000-new' });
    assert.equal(r.status, 'superseded');
    assert.equal(r.supersededByRunId, '20240101120000-new');
  });

  it('handles non-object input gracefully', () => {
    const r = normalizeRevision(null);
    assert.equal(r.status, 'current');
  });
});
