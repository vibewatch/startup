import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCacheKey,
  looksLikePdfBuffer,
  looksLikeBotChallenge,
  waybackUrl,
  readerUrl,
  htmlToText,
  cleanExtractedText,
  extractTitle,
  stripWaybackToolbar,
  registrableDomain,
} from '../.agents/skills/fetch-url/scripts/fetch.mjs';

describe('canonicalCacheKey', () => {
  it('returns a 32-character hex string', () => {
    const key = canonicalCacheKey('https://example.com', 'origin');
    assert.equal(key.length, 32);
    assert.match(key, /^[0-9a-f]+$/);
  });

  it('produces different keys for different variants', () => {
    const origin = canonicalCacheKey('https://example.com', 'origin');
    const reader = canonicalCacheKey('https://example.com', 'reader');
    const wayback = canonicalCacheKey('https://example.com', 'wayback');
    assert.notEqual(origin, reader);
    assert.notEqual(origin, wayback);
    assert.notEqual(reader, wayback);
  });

  it('normalizes URL casing', () => {
    const a = canonicalCacheKey('https://EXAMPLE.COM/page', 'origin');
    const b = canonicalCacheKey('https://example.com/page', 'origin');
    assert.equal(a, b);
  });

  it('produces consistent keys for the same URL', () => {
    const a = canonicalCacheKey('https://example.com/path?a=1&b=2', 'origin');
    const b = canonicalCacheKey('https://example.com/path?a=1&b=2', 'origin');
    assert.equal(a, b);
  });

  it('normalizes query param order', () => {
    const a = canonicalCacheKey('https://example.com?z=1&a=2', 'origin');
    const b = canonicalCacheKey('https://example.com?a=2&z=1', 'origin');
    assert.equal(a, b);
  });
});

describe('looksLikePdfBuffer', () => {
  it('detects PDF magic bytes', () => {
    const pdf = Buffer.from('%PDF-1.4 some content');
    assert.ok(looksLikePdfBuffer(pdf));
  });

  it('rejects non-PDF content', () => {
    const html = Buffer.from('<html><body>Hello</body></html>');
    assert.ok(!looksLikePdfBuffer(html));
  });

  it('rejects non-buffer input', () => {
    assert.ok(!looksLikePdfBuffer('not a buffer'));
    assert.ok(!looksLikePdfBuffer(null));
  });
});

describe('looksLikeBotChallenge', () => {
  it('detects 403 status', () => {
    assert.ok(looksLikeBotChallenge({ status: 403, body: Buffer.alloc(0) }));
  });

  it('detects 503 status', () => {
    assert.ok(looksLikeBotChallenge({ status: 503, body: Buffer.alloc(0) }));
  });

  it('detects challenge markers in body', () => {
    const result = { status: 200, body: Buffer.from('Please enable JS and disable any ad blocker') };
    assert.ok(looksLikeBotChallenge(result));
  });

  it('passes normal 200 responses', () => {
    const result = { status: 200, body: Buffer.from('<html><body>Normal page</body></html>') };
    assert.ok(!looksLikeBotChallenge(result));
  });

  it('handles null/undefined', () => {
    assert.ok(!looksLikeBotChallenge(null));
    assert.ok(!looksLikeBotChallenge(undefined));
  });
});

describe('waybackUrl', () => {
  it('constructs a Wayback Machine URL', () => {
    const result = waybackUrl('https://example.com/page', 2024);
    assert.equal(result, 'https://web.archive.org/web/2024/https://example.com/page');
  });
});

describe('readerUrl', () => {
  it('constructs a Jina reader URL', () => {
    const result = readerUrl('example.com/page');
    assert.equal(result, 'https://r.jina.ai/http://example.com/page');
  });
});

describe('htmlToText', () => {
  it('strips HTML tags', () => {
    const text = htmlToText('<p>Hello <b>world</b></p>');
    assert.ok(text.includes('Hello'));
    assert.ok(text.includes('world'));
    assert.ok(!text.includes('<'));
  });

  it('strips script/style tags with content', () => {
    const text = htmlToText('<script>alert("x")</script><p>content</p><style>body{}</style>');
    assert.ok(!text.includes('alert'));
    assert.ok(!text.includes('body{}'));
    assert.ok(text.includes('content'));
  });

  it('decodes HTML entities', () => {
    const text = htmlToText('<p>&amp; &lt; &gt; &quot;</p>');
    assert.ok(text.includes('&'));
    assert.ok(text.includes('<'));
    assert.ok(text.includes('>'));
  });

  it('handles null/empty input', () => {
    assert.equal(htmlToText(''), '');
    assert.equal(htmlToText(null), '');
  });
});

describe('cleanExtractedText', () => {
  it('removes boilerplate lines', () => {
    const result = cleanExtractedText('Skip to main content\nReal article content here\nAll rights reserved.');
    assert.ok(!result.text.includes('Skip to main content'));
    assert.ok(!result.text.includes('All rights reserved'));
    assert.ok(result.text.includes('Real article content'));
    assert.ok(result.removedLines >= 2);
  });

  it('deduplicates short repeated lines', () => {
    const result = cleanExtractedText('Menu\nContent here\nMenu\nMore content');
    assert.ok(result.dedupedLines >= 1);
  });

  it('handles empty input', () => {
    const result = cleanExtractedText('');
    assert.equal(result.text, '');
  });
});

describe('extractTitle', () => {
  it('extracts title from HTML', () => {
    assert.equal(extractTitle('<html><head><title>Hello World</title></head></html>'), 'Hello World');
  });

  it('normalizes whitespace in title', () => {
    assert.equal(extractTitle('<title>  Hello   World  </title>'), 'Hello World');
  });

  it('returns null when no title', () => {
    assert.equal(extractTitle('<html><body>no title</body></html>'), null);
  });
});

describe('stripWaybackToolbar', () => {
  it('removes Wayback toolbar comments', () => {
    const html = '<html><!-- BEGIN WAYBACK TOOLBAR INSERT -->toolbar<!-- END WAYBACK TOOLBAR INSERT --><body>content</body></html>';
    const result = stripWaybackToolbar(html);
    assert.ok(!result.includes('WAYBACK TOOLBAR'));
    assert.ok(result.includes('content'));
  });

  it('handles null input', () => {
    assert.equal(stripWaybackToolbar(null), '');
  });
});

describe('registrableDomain (fetch-url)', () => {
  it('returns eTLD+1 for standard domains', () => {
    assert.equal(registrableDomain('blog.example.com'), 'example.com');
  });

  it('handles multi-level TLDs', () => {
    assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  });

  it('returns null for single-part hosts', () => {
    assert.equal(registrableDomain('localhost'), null);
  });

  it('returns null for empty input', () => {
    assert.equal(registrableDomain(''), null);
    assert.equal(registrableDomain(null), null);
  });
});
