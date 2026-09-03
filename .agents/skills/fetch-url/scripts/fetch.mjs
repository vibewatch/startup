#!/usr/bin/env node
// Fetch a URL with optional readable-text extraction. Used by the fetch-url skill.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, env, exit } from 'node:process';

const DEFAULT_URL = 'https://openai.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const DEFAULT_CACHE_DIR = env.FETCH_URL_CACHE_DIR
  ? resolve(env.FETCH_URL_CACHE_DIR)
  : resolve(process.cwd(), '.fetch-cache');
export const DEFAULT_CACHE_TTL_HOURS = 24 * 7;
const DEFAULT_PROFILE = 'bingbot';
const DEFAULT_THROTTLE_MS = 750;
// Maximum response body size (50 MB). Prevents memory exhaustion from
// unexpectedly large downloads (e.g. PDF archives served at trusted URLs).
const MAX_BODY_BYTES = 50 * 1024 * 1024;
// Only allow http/https URLs to prevent SSRF via javascript:, file:, data: schemes.
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

// curl-impersonate is shipped as a single binary `curl-impersonate` plus a
// family of wrapper shell scripts (`curl_chrome120`, `curl_firefox133`, ...)
// that pass the right --ciphers / --curves / --http2-settings / -H combination
// to reproduce a given browser's TLS+HTTP fingerprint. We invoke the wrappers
// directly. See SKILL.md for installation instructions.
const DEFAULT_CURL_IMPERSONATE_DIR = env.CURL_IMPERSONATE_DIR
  ? resolve(env.CURL_IMPERSONATE_DIR)
  : resolve(env.HOME ?? '', '.local', 'share', 'curl-impersonate');

const SEARCH_ENGINE_PROFILES = {
  googlebot: {
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  bingbot: {
    userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
};

// Browser profiles delegate to a curl-impersonate wrapper for TLS/JA3 +
// HTTP/2 fingerprint. The wrapper already sets a complete fingerprint-matched
// header set (User-Agent, Accept, Accept-Language, Sec-Fetch-*, etc.); we do
// NOT layer our own headers on top of it. The `userAgent` field below is only
// used when curl-impersonate is unavailable and we fall back to plain fetch().
const BROWSER_PROFILES = {
  'desktop-chrome': {
    wrapper: 'curl_chrome120',
    userAgent: DEFAULT_USER_AGENT,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  'desktop-firefox': {
    wrapper: 'curl_firefox133',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    },
  },
  'desktop-safari': {
    wrapper: 'curl_safari180',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
  'mobile-safari': {
    wrapper: 'curl_safari180_ios',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  },
};

const ALL_PROFILES = { ...BROWSER_PROFILES, ...SEARCH_ENGINE_PROFILES };
const PROFILE_ORDER = Object.keys(BROWSER_PROFILES);
const ALL_PROFILE_NAMES = Object.keys(ALL_PROFILES);

// Cache the resolved absolute path for each wrapper so we only stat() once.
const WRAPPER_PATH_CACHE = new Map();
function resolveWrapperPath(wrapper) {
  if (!wrapper) return null;
  if (WRAPPER_PATH_CACHE.has(wrapper)) return WRAPPER_PATH_CACHE.get(wrapper);
  const candidates = [
    join(DEFAULT_CURL_IMPERSONATE_DIR, wrapper),
    ...((env.PATH ?? '').split(delimiter).filter(Boolean).map((p) => join(p, wrapper))),
  ];
  let resolved = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) { resolved = candidate; break; }
  }
  WRAPPER_PATH_CACHE.set(wrapper, resolved);
  return resolved;
}

// Per-host strategy fast-path. Pre-computed by `probe.mjs` and
// stored at references/host-strategies.json. When a URL's host has a known
// winning strategy (e.g. reuters.com -> desktop-firefox, wsj.com -> wayback),
// we skip the full origin->reader->wayback fallback chain and try that
// strategy first; if it fails we still drop back to the standard chain.
const HOST_STRATEGIES_PATH = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', 'references', 'host-strategies.json');
  } catch {
    return null;
  }
})();
let HOST_STRATEGIES_CACHE = null;
function loadHostStrategies() {
  if (HOST_STRATEGIES_CACHE !== null) return HOST_STRATEGIES_CACHE;
  HOST_STRATEGIES_CACHE = {};
  if (!HOST_STRATEGIES_PATH || !existsSync(HOST_STRATEGIES_PATH)) return HOST_STRATEGIES_CACHE;
  try {
    HOST_STRATEGIES_CACHE = JSON.parse(readFileSync(HOST_STRATEGIES_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[fetch-url] could not load host strategies: ${err.message}`);
    HOST_STRATEGIES_CACHE = {};
  }
  return HOST_STRATEGIES_CACHE;
}

// Multi-level public suffixes that appear in our host map. Listed explicitly
// so we don't pull in a full PSL dependency. Add entries here when adding
// hosts under a ccTLD-style suffix that isn't already covered.
const MULTI_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'plc.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
  'com.au', 'org.au', 'gov.au', 'edu.au', 'net.au',
  'co.in', 'org.in', 'gov.in', 'ac.in', 'net.in',
  'com.cn', 'org.cn', 'gov.cn', 'edu.cn', 'net.cn',
  'com.hk', 'org.hk', 'gov.hk',
  'com.sg', 'org.sg',
  'com.br', 'gov.br',
  'co.kr', 'or.kr', 'go.kr',
  'co.nz', 'govt.nz', 'org.nz',
]);

// Best-effort registrable-domain extractor (eTLD+1). Used as the third lookup
// fallback so a bare 'sec.gov' entry can match 'data.sec.gov'/'efts.sec.gov'
// without pulling in the full Public Suffix List.
export function registrableDomain(host) {
  if (!host) return null;
  const lower = String(host).toLowerCase();
  const parts = lower.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_LEVEL_TLDS.has(last2)) {
    return parts.slice(-3).join('.');
  }
  return last2;
}

// Three-layer lookup, in cost order:
//   1. exact host match           (www.reuters.com -> www.reuters.com)
//   2. www. alias swap            (openai.com -> www.openai.com, or vice versa)
//   3. registrable-domain match   (data.sec.gov -> sec.gov, only if 'sec.gov'
//      is *explicitly* in the map; we never auto-coerce to avoid wrongly
//      collapsing peers like en.wikipedia.org / www.wikipedia.org which can
//      have different working strategies).
// Returns the matched entry (including null-strategy entries for known
// failures) annotated with `_matchedKey`, or null if nothing matched.
export function lookupHostStrategy(url) {
  let host;
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  const map = loadHostStrategies();
  const has = (k) => k && Object.prototype.hasOwnProperty.call(map, k);
  const wrap = (k) => ({ ...map[k], _matchedKey: k });

  if (has(host)) return wrap(host);

  const aliased = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (aliased !== host && has(aliased)) return wrap(aliased);

  const reg = registrableDomain(host);
  if (reg && reg !== host && reg !== aliased && has(reg)) return wrap(reg);

  return null;
}

const BLOCK_TAGS = 'p|div|section|article|header|footer|nav|aside|main|ul|ol|li|tr|td|th|h[1-6]|blockquote|pre|figure|figcaption|table';
const BLOCK_TAG_RE = new RegExp(`<\\/?(${BLOCK_TAGS})(?:\\s[^>]*)?>`, 'gi');

// Magic-byte sniff: real PDFs start with `%PDF-` within the first 1KB.
// We detect PDFs from the response body, never from the URL extension or
// Content-Type, so an HTML error page served at a .pdf URL still flows
// through the HTML path.
export function looksLikePdfBuffer(buf) {
  if (!Buffer.isBuffer(buf)) return false;
  const head = buf.slice(0, 1024).toString('ascii');
  return /%PDF-/.test(head);
}

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

const NOISE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'CANVAS']);
const PROTECTED_EXTRACTION_TAGS = new Set(['HTML', 'HEAD', 'BODY', 'MAIN', 'ARTICLE']);
const NOISE_HINT_RE = /\b(cookie|cookies|consent|gdpr|privacy[-_\s]?preferences?|newsletter|subscribe[-_\s]?(modal|popup|form|box|banner)|sign[-_\s]?up[-_\s]?(modal|popup|form|box|banner)|modal|popup|overlay|interstitial|ad[-_\s]?(container|slot|banner|unit)|advertisement|social[-_\s]?(share|links?)|share[-_\s]?(buttons?|bar|widget)|related[-_\s]?(articles?|posts?)|recommended[-_\s]?(articles?|posts?)|recirculation)\b/i;
const NOISE_TEXT_RE = /\b(cookie|cookies|consent|gdpr|newsletter|subscribe to|sign up for|share this|advertisement|sponsored)\b/i;
const BOILERPLATE_LINE_PATTERNS = [
  /^skip to (main )?content$/i,
  /^(menu|open menu|close menu)$/i,
  /^(sign in|log in)$/i,
  /^(accept|reject|allow|deny)( all)? cookies?$/i,
  /^(manage|customize|change|set) (cookies?|preferences|privacy settings)$/i,
  /^cookie (settings|preferences|policy)$/i,
  /^this (site|website) uses cookies\b.{0,220}$/i,
  /^we use cookies\b.{0,220}$/i,
  /^by (continuing|clicking|using this site)\b.{0,220}\bcookies?\b/i,
  /^(subscribe|sign up) (to|for) (our|the) newsletter\.?$/i,
  /^get (the )?(latest|updates) (in )?your inbox\.?$/i,
  /^share this (article|post|page)$/i,
  /^(share|follow us)( on .*)?$/i,
  /^advertisement$/i,
  /^sponsored( content)?$/i,
  /^(related|recommended) (articles|posts|content)$/i,
  /^(read more|learn more)$/i,
  /^all rights reserved\.?$/i,
  /^©\s?\d{4}.*all rights reserved\.?$/i,
];

function readOptionValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return { error: `Missing value for ${flag}.`, value: null };
  }
  return { error: null, value };
}

function parseNumberOption(value, flag, { min = -Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) {
    return { error: `Invalid ${flag}: ${value}.`, value: null };
  }
  return { error: null, value: number };
}

function printUsageError(error) {
  console.error(error);
  console.error('Run with --help to see supported options.');
}

// When STARTUP_FETCH_LOG_PATH is set, every main() invocation appends a
// single JSON line describing the fetch (url, finalUrl, source, status,
// profile, ok, sha256, bytes, ts). Downstream graders consume the log to
// verify that every cited URL in a report was actually retrieved through
// fetch-url at least once. The env-var guard keeps fetch-url generic: when
// the var is unset (interactive use), nothing is logged.
function appendFetchLog(entry) {
  const path = env.STARTUP_FETCH_LOG_PATH;
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // Logging is best-effort; never let it kill the fetch.
  }
}

function bodySha256(body) {
  if (!body) return null;
  try {
    return createHash('sha256').update(body).digest('hex');
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const opts = {
    url: DEFAULT_URL,
    file: null,
    raw: false,
    userAgent: DEFAULT_USER_AGENT,
    viaWayback: false,
    noWayback: false,
    viaReader: false,
    noReader: false,
    profile: DEFAULT_PROFILE,
    profileOverride: false,
    retryProfiles: true,
    userAgentOverride: false,
    throttleMs: DEFAULT_THROTTLE_MS,
    help: false,
    cacheDir: DEFAULT_CACHE_DIR,
    cacheTtlHours: DEFAULT_CACHE_TTL_HOURS,
    noCache: false,
    refreshCache: false,
    noHostMap: false,
    ignoreHostMapFailures: false,
    mainContent: true,
    maxChars: null,
    json: false,
    error: null,
  };
  const readValue = (flag, index) => {
    const parsed = readOptionValue(args, index, flag);
    if (parsed.error) opts.error = parsed.error;
    return parsed.value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--raw' || arg === '--raw-html') opts.raw = true;
    else if (arg === '--out' || arg === '-o') {
      const value = readValue(arg, i);
      if (opts.error) break;
      opts.file = value;
      i += 1;
    }
    else if (arg === '--user-agent') {
      const value = readValue(arg, i);
      if (opts.error) break;
      opts.userAgent = value;
      opts.userAgentOverride = true;
      i += 1;
    }
    else if (arg === '--profile') {
      const value = readValue(arg, i);
      if (opts.error) break;
      opts.profile = value;
      opts.profileOverride = true;
      i += 1;
    }
    else if (arg === '--no-retry-profiles') opts.retryProfiles = false;
    else if (arg === '--via-wayback') opts.viaWayback = true;
    else if (arg === '--no-wayback') opts.noWayback = true;
    else if (arg === '--via-reader') opts.viaReader = true;
    else if (arg === '--no-reader') opts.noReader = true;
    else if (arg === '--throttle-ms') {
      const value = readValue(arg, i);
      if (opts.error) break;
      const parsed = parseNumberOption(value, arg, { min: 0 });
      if (parsed.error) { opts.error = parsed.error; break; }
      opts.throttleMs = parsed.value;
      i += 1;
    }
    else if (arg === '--no-throttle') opts.throttleMs = 0;
    else if (arg === '--cache-dir') {
      const value = readValue(arg, i);
      if (opts.error) break;
      opts.cacheDir = resolve(value);
      i += 1;
    }
    else if (arg === '--cache-ttl-hours') {
      const value = readValue(arg, i);
      if (opts.error) break;
      const parsed = parseNumberOption(value, arg, { min: 0 });
      if (parsed.error) { opts.error = parsed.error; break; }
      opts.cacheTtlHours = parsed.value;
      i += 1;
    }
    else if (arg === '--no-cache') opts.noCache = true;
    else if (arg === '--refresh-cache') opts.refreshCache = true;
    else if (arg === '--no-host-map') opts.noHostMap = true;
    else if (arg === '--ignore-host-map-failures') opts.ignoreHostMapFailures = true;
    else if (arg === '--main-content') opts.mainContent = true;
    else if (arg === '--full-text' || arg === '--no-main-content') opts.mainContent = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--max-chars') {
      const value = readValue(arg, i);
      if (opts.error) break;
      const parsed = parseNumberOption(value, arg, { min: 0 });
      if (parsed.error) { opts.error = parsed.error; break; }
      opts.maxChars = parsed.value;
      i += 1;
    }
    else if (arg.startsWith('-')) {
      opts.error = `Unknown option: ${arg}.`;
      break;
    }
    else opts.url = arg;
  }
  return opts;
}

function help() {
  console.log(`Usage: node .agents/skills/fetch-url/scripts/fetch.mjs [url] [--full-text] [--raw] [--out <file>] [--json] [--user-agent <ua>] [--profile <name>] [--via-reader | --no-reader] [--via-wayback | --no-wayback] [--cache-dir <path>] [--cache-ttl-hours <n>] [--no-cache] [--refresh-cache] [--max-chars N]

Default URL: ${DEFAULT_URL}

Profiles: ${ALL_PROFILE_NAMES.join(', ')}. Browser profiles use curl-impersonate for TLS/JA3 fingerprinting. Search engine profiles use standard fetch.

Fallbacks: origin fetch uses browser-like headers and, by default, retries other ordinary browser profiles on bot-challenge responses. If still blocked, it tries r.jina.ai reader text, then Wayback Machine snapshots. Use --no-retry-profiles, --no-reader, or --no-wayback to narrow the chain. Use --via-reader or --via-wayback to force a fallback path.

Throttling: network attempts wait ${DEFAULT_THROTTLE_MS}ms by default to avoid hammering a host. Use --throttle-ms <n> or --no-throttle.

Caching: enabled by default at ${DEFAULT_CACHE_DIR} (override with --cache-dir or FETCH_URL_CACHE_DIR env). Cached responses younger than ${DEFAULT_CACHE_TTL_HOURS}h are reused. Use --refresh-cache to bypass the read but still write, --no-cache to disable read+write entirely.

Output: default output is readable text. HTML pages use Mozilla Readability to extract main content by default; PDFs output extracted text. Use --full-text only as an escape hatch when Readability likely dropped useful non-article content (product/home pages, pricing pages, docs tables, feature grids, logos, navigation context). It is not cleaner; it intentionally keeps header/footer/navigation text. Use --raw only for diagnostics or archival raw HTML/PDF bytes. Use --json for a structured object with status, final URL, source, title/PDF metadata, and extracted body/text.

Wayback fallback: bot-protected sites (DataDome/Cloudflare challenge, 401/403/451/503) automatically retry through web.archive.org. Use --via-wayback to force, --no-wayback to disable.

PDF support: PDF responses (detected by %PDF- magic bytes) are routed to the pdfjs-dist text extractor. Text is emitted with '--- Page N ---' page markers. Use --max-chars N to cap any text output and protect agent context. Use --raw --out file.pdf to save raw PDF bytes.`);
}

function wait(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function buildHeaders(profileName, userAgentOverride = null) {
  const profile = ALL_PROFILES[profileName] ?? ALL_PROFILES[DEFAULT_PROFILE];
  return {
    ...profile.headers,
    'User-Agent': userAgentOverride ?? profile.userAgent,
  };
}

function profileSequence(opts) {
  // When the caller forces a custom UA we keep the requested profile (so its
  // TLS/JA3 fingerprint via curl-impersonate is preserved) and only swap the
  // headers in.
  if (opts.userAgentOverride) {
    return [{
      name: 'custom',
      profile: opts.profile,
      headers: buildHeaders(opts.profile, opts.userAgent),
    }];
  }
  const first = ALL_PROFILES[opts.profile] ? opts.profile : DEFAULT_PROFILE;
  const names = opts.retryProfiles
    ? [first, ...PROFILE_ORDER.filter((name) => name !== first)]
    : [first];
  // Each retry uses its profile end-to-end so both headers AND JA3 fingerprint
  // change. Letting fetchUrl build headers from `profile` keeps that in sync.
  return names.map((name) => ({ name, profile: name, headers: null }));
}

// Always returns `body` as a Buffer. Callers decode to utf-8 themselves when
// they want a string view (HTML path) and pass the Buffer through unchanged
// when they want bytes (PDF path, --out).
export async function fetchUrl(url, { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = null, profile = DEFAULT_PROFILE, headers = null, throttleMs = 0 } = {}) {
  // Validate URL scheme to prevent SSRF
  try {
    const parsed = new URL(url);
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
      throw new Error(`[fetch-url] Blocked URL with disallowed scheme: ${parsed.protocol}`);
    }
  } catch (err) {
    if (err.message.includes('Blocked URL')) throw err;
    throw new Error(`[fetch-url] Invalid URL: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const profileData = ALL_PROFILES[profile] ?? ALL_PROFILES[DEFAULT_PROFILE];

  try {
    await wait(throttleMs);

    // Use a curl-impersonate wrapper for browser profiles. The wrapper script
    // already sets the full TLS+HTTP fingerprint headers (User-Agent, Accept,
    // Accept-Language, Sec-Fetch-*, etc.); we deliberately do NOT pass our own
    // -H values on top of it, otherwise the fingerprint stops matching the UA.
    // We only forward `-A <ua>` when the user supplied an explicit override.
    const wrapperPath = profileData.wrapper && !SEARCH_ENGINE_PROFILES[profile]
      ? resolveWrapperPath(profileData.wrapper)
      : null;
    if (wrapperPath) {
      const { spawn } = await import('node:child_process');
      return new Promise((resolvePromise, rejectPromise) => {
        // Sentinel that curl appends after the body via -w; lets us recover the
        // final URL after redirects without parsing every header block.
        const META_SEPARATOR = '__CURL_IMPERSONATE_META_5e8f1a__';
        const args = [
          '-s', '-L', '-D', '-',
          '--connect-timeout', String(Math.round(timeoutMs / 1000)),
          '-w', `\n${META_SEPARATOR}\n%{url_effective}`,
        ];
        if (userAgent) args.push('-A', userAgent);
        args.push(url);

        const child = spawn(wrapperPath, args);
        // Collect stdout as raw Buffers so binary bodies (PDFs) survive intact.
        // Headers are ASCII; we decode just the header section to utf-8 below.
        const stdoutChunks = [];
        child.stderr.setEncoding('utf8');
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
        child.stderr.on('data', (chunk) => { stderr += chunk; });

        // Wire the AbortController (driven by the outer timeoutMs timer) to
        // actually kill the curl subprocess; --connect-timeout alone only
        // covers TCP handshake, so a slow body would otherwise hang forever.
        const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* noop */ } };
        controller.signal.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
          controller.signal.removeEventListener('abort', onAbort);
          if (code !== 0) {
            return rejectPromise(new Error(`curl-impersonate (${profileData.wrapper}) exited with code ${code}: ${stderr}`));
          }

          const fullBuffer = Buffer.concat(stdoutChunks);

          // Recover the post-redirect final URL from the -w sentinel.
          const metaMarker = Buffer.from(`\n${META_SEPARATOR}\n`, 'utf8');
          let payloadBuf = fullBuffer;
          let finalUrl = url;
          const metaIdx = fullBuffer.lastIndexOf(metaMarker);
          if (metaIdx >= 0) {
            payloadBuf = fullBuffer.slice(0, metaIdx);
            finalUrl = fullBuffer.slice(metaIdx + metaMarker.length).toString('utf8').trim() || url;
          }

          // With -L curl emits one header block per hop separated by \r\n\r\n.
          // The actual response body follows the LAST `HTTP/...` block; earlier
          // blocks are 30x redirect responses that must NOT be glued into the body.
          const headerSep = Buffer.from('\r\n\r\n', 'utf8');
          const blockStarts = [0];
          let sepIdx = payloadBuf.indexOf(headerSep, 0);
          while (sepIdx >= 0) {
            blockStarts.push(sepIdx + headerSep.length);
            sepIdx = payloadBuf.indexOf(headerSep, sepIdx + headerSep.length);
          }
          let lastHttpBlockIdx = -1;
          for (let i = 0; i < blockStarts.length; i += 1) {
            const s = blockStarts[i];
            if (payloadBuf.slice(s, s + 5).toString('ascii') === 'HTTP/') {
              lastHttpBlockIdx = i;
            }
          }

          let headerBlock = '';
          let bodyBuf;
          if (lastHttpBlockIdx >= 0) {
            const s = blockStarts[lastHttpBlockIdx];
            const e = payloadBuf.indexOf(headerSep, s);
            if (e >= 0) {
              headerBlock = payloadBuf.slice(s, e).toString('utf8');
              bodyBuf = payloadBuf.slice(e + headerSep.length);
            } else {
              headerBlock = payloadBuf.slice(s).toString('utf8');
              bodyBuf = Buffer.alloc(0);
            }
          } else {
            bodyBuf = payloadBuf;
          }

          const headerLines = headerBlock.split('\r\n');
          const statusLine = headerLines.find(l => l.startsWith('HTTP/'));
          const status = statusLine ? Number(statusLine.split(' ')[1]) : 500;
          const contentTypeLine = headerLines.find(l => l.toLowerCase().startsWith('content-type:'));
          const contentType = contentTypeLine ? contentTypeLine.split(':')[1].trim() : null;

          resolvePromise({
            url,
            finalUrl,
            status,
            ok: status >= 200 && status < 300,
            contentType,
            contentLength: bodyBuf.length,
            elapsedMs: Date.now() - started,
            profile,
            body: bodyBuf,
          });
        });

        child.on('error', (err) => {
          controller.signal.removeEventListener('abort', onAbort);
          rejectPromise(new Error(`Failed to start curl-impersonate wrapper at ${wrapperPath}: ${err.message}`));
        });
      });
    }

    // Fallback to standard fetch for search engine bots or if no impersonation is defined.
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: headers ?? buildHeaders(profile, userAgent),
    });
    // Enforce max body size to prevent memory exhaustion
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && Number(contentLengthHeader) > MAX_BODY_BYTES) {
      throw new Error(`[fetch-url] Response too large (${contentLengthHeader} bytes > ${MAX_BODY_BYTES} limit): ${url}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) {
      throw new Error(`[fetch-url] Response body too large (${body.length} bytes > ${MAX_BODY_BYTES} limit): ${url}`);
    }
    return {
      url,
      finalUrl: response.url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      contentLength: body.length,
      elapsedMs: Date.now() - started,
      profile,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractTitle(html) {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
    ?? html.match(/^Title:\s*(.+)$/im)?.[1]?.replace(/\s+/g, ' ').trim()
    ?? null;
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITY_MAP[name.toLowerCase()] ?? match);
}

function normalizePlainText(text) {
  return String(text ?? '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function elementSignalText(el) {
  return [
    el.id,
    el.className,
    el.getAttribute?.('role'),
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('data-testid'),
    el.getAttribute?.('data-test'),
  ].filter((value) => typeof value === 'string' && value.trim()).join(' ');
}

function isLikelyNoiseElement(el) {
  const tag = el.tagName?.toUpperCase?.() ?? '';
  if (NOISE_TAGS.has(tag)) return true;
  if (PROTECTED_EXTRACTION_TAGS.has(tag)) return false;
  if (el.hasAttribute?.('hidden') || String(el.getAttribute?.('aria-hidden') ?? '').toLowerCase() === 'true') return true;

  const role = String(el.getAttribute?.('role') ?? '').toLowerCase();
  const signal = elementSignalText(el);
  const text = normalizePlainText(el.textContent ?? '').slice(0, 2000);
  const combined = `${signal} ${text}`;

  if ((role === 'dialog' || role === 'alertdialog') && NOISE_TEXT_RE.test(combined)) return true;
  if (tag === 'FORM' && /\b(newsletter|subscribe|sign up|email updates?)\b/i.test(combined) && text.length < 1200) return true;
  if (NOISE_HINT_RE.test(signal) && (text.length < 2000 || NOISE_TEXT_RE.test(text))) return true;
  return false;
}

function cleanDomForExtraction(document) {
  let removedNodes = 0;
  for (const el of [...document.querySelectorAll('*')]) {
    if (!el.isConnected) continue;
    if (isLikelyNoiseElement(el)) {
      el.remove();
      removedNodes += 1;
    }
  }
  return { removedNodes };
}

function legalNavTermCount(line) {
  const lower = line.toLowerCase();
  return [
    'privacy policy',
    'terms of service',
    'terms of use',
    'cookie policy',
    'accessibility',
    'do not sell',
  ].filter((term) => lower.includes(term)).length;
}

function isBoilerplateLine(line) {
  if (!line) return false;
  if (BOILERPLATE_LINE_PATTERNS.some((pattern) => pattern.test(line))) return true;
  if (line.length <= 180 && legalNavTermCount(line) >= 2 && line.split(/\s+/).length <= 18) return true;
  return false;
}

function canonicalShortLine(line) {
  return line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function cleanExtractedText(text) {
  const normalized = normalizePlainText(text);
  if (!normalized) return { text: '', removedLines: 0, dedupedLines: 0 };

  const out = [];
  const seenShortLines = new Set();
  let removedLines = 0;
  let dedupedLines = 0;
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (out.length && out.at(-1) !== '') out.push('');
      continue;
    }
    if (isBoilerplateLine(line)) {
      removedLines += 1;
      continue;
    }

    const key = canonicalShortLine(line);
    const wordCount = key ? key.split(/\s+/).length : 0;
    if (key && line.length <= 80 && wordCount <= 10) {
      if (seenShortLines.has(key)) {
        dedupedLines += 1;
        continue;
      }
      seenShortLines.add(key);
    }
    out.push(line);
  }

  return {
    text: normalizePlainText(out.join('\n')),
    removedLines,
    dedupedLines,
  };
}

function buildCleaningMetadata(domStats, textStats) {
  return {
    removedNodes: domStats?.removedNodes ?? 0,
    removedLines: textStats?.removedLines ?? 0,
    dedupedLines: textStats?.dedupedLines ?? 0,
  };
}

function cleanHtmlText(html) {
  return cleanExtractedText(htmlToText(html));
}

function fullTextExtraction(textStats, { domStats = null, fallbackReason = null } = {}) {
  return {
    text: textStats.text,
    method: 'full-text',
    used: false,
    ...(fallbackReason ? { fallbackReason } : {}),
    cleaning: buildCleaningMetadata(domStats, textStats),
  };
}

export function htmlToText(html) {
  const stripped = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]+>/g, '');
  return normalizePlainText(decodeEntities(stripped));
}

function looksLikeHtml(text, contentType) {
  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('html') || type.includes('xml')) return true;
  return /<(html|body|article|main|section|div|p|header|footer|nav)\b/i.test(String(text ?? '').slice(0, 200_000));
}

async function extractHtmlText(html, url, contentType, { mainContent = true } = {}) {
  const fallbackText = cleanHtmlText(html);
  if (!looksLikeHtml(html, contentType)) {
    return fullTextExtraction(fallbackText, { fallbackReason: 'not-html' });
  }

  let dom;
  try {
    const [{ Readability } = {}, { JSDOM }] = await Promise.all([
      mainContent ? import('@mozilla/readability') : Promise.resolve({}),
      import('jsdom'),
    ]);
    dom = new JSDOM(html, { url });
    const domCleaning = cleanDomForExtraction(dom.window.document);
    const cleanedFullText = cleanHtmlText(dom.serialize());

    if (!mainContent) return fullTextExtraction(cleanedFullText, { domStats: domCleaning });

    const article = new Readability(dom.window.document).parse();
    const articleText = article?.content ? htmlToText(article.content) : normalizePlainText(article?.textContent ?? '');
    const cleanedArticleText = cleanExtractedText(articleText);
    if (!cleanedArticleText.text) {
      return fullTextExtraction(cleanedFullText.text ? cleanedFullText : fallbackText, {
        domStats: domCleaning,
        fallbackReason: 'readability-empty',
      });
    }
    return {
      text: cleanedArticleText.text,
      method: 'readability',
      used: true,
      contentSource: article?.content ? 'article-html' : 'article-text',
      title: article?.title ?? null,
      byline: article?.byline ?? null,
      excerpt: article?.excerpt ?? null,
      siteName: article?.siteName ?? null,
      length: article?.length ?? cleanedArticleText.text.length,
      cleaning: buildCleaningMetadata(domCleaning, cleanedArticleText),
    };
  } catch (err) {
    return fullTextExtraction(fallbackText, { fallbackReason: err.message });
  } finally {
    dom?.window?.close?.();
  }
}

// Extract text from a PDF Buffer using pdfjs-dist. Returns
// { text, numPages, info, truncated }. `maxChars` caps the total output
// length to protect agent context; truncation is signalled in the returned
// `truncated` flag.
//
// Each emitted page is prefixed with a `--- Page N ---` marker so callers can
// quote specific pages in citations.
export async function pdfToText(buffer, { maxChars = null } = {}) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdfjs mutates its input buffer; clone so the caller's body stays intact
  // (we still want to print byte counts, write --out, etc. on the same data).
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    // verbosity 0 = errors only. Without this, pdfjs prints noisy
    // "Warning: Invalid stream" / "XRef entry" lines for nearly every
    // real-world PDF and drowns the actual program output.
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const info = (await doc.getMetadata().catch(() => null))?.info ?? null;

  const parts = [];
  let totalChars = 0;
  let truncated = false;
  for (let i = 1; i <= numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct line breaks: pdfjs items expose `hasEOL` for explicit line
    // ends, otherwise we space-join. This is a best-effort layout — column
    // detection would need positional clustering which we skip in v1.
    let pageText = '';
    for (const item of content.items) {
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
      else pageText += ' ';
    }
    pageText = pageText.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    const header = `\n--- Page ${i} ---\n`;
    const block = header + pageText;
    if (maxChars && totalChars + block.length > maxChars) {
      const remaining = Math.max(0, maxChars - totalChars);
      if (remaining > 0) parts.push(block.slice(0, remaining));
      truncated = true;
      break;
    }
    parts.push(block);
    totalChars += block.length;
    page.cleanup();
  }
  await doc.cleanup();
  await doc.destroy();

  const text = parts.join('').replace(/^\n+/, '');
  return { text, numPages, info, truncated };
}

// Wayback Machine fallback for bot-protected sites. The /web/<year>/<url>
// form 302s to the closest snapshot, so callers do not need to know the
// snapshot timestamp ahead of time.
export function waybackUrl(url, year = new Date().getUTCFullYear()) {
  return `https://web.archive.org/web/${year}/${url}`;
}

export function readerUrl(url) {
  return `https://r.jina.ai/http://${url}`;
}

// ---------------------------------------------------------------------------
// On-disk cache (default ON). Avoids repeat bandwidth and rate-limit hits
// when the same URL is fetched across chapters in a startup-research run.
// Cache key is a SHA-256 of the canonicalized URL plus a source variant
// suffix (`:origin`, `:reader`, `:wayback`) so fallback fetches never collide.
// Bodies are stored as base64-encoded bytes regardless of content type, so
// HTML and PDF roundtrip identically.
// ---------------------------------------------------------------------------
function cacheVariantName(variant) {
  return String(variant ?? 'origin');
}

export function canonicalCacheKey(url, variant = 'origin') {
  let canonical = url;
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.searchParams && [...u.searchParams.keys()].length > 0) {
      const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
      u.search = '';
      for (const [k, v] of params) u.searchParams.append(k, v);
    }
    u.hostname = u.hostname.toLowerCase();
    canonical = u.toString();
  } catch {
    canonical = String(url);
  }
  const suffix = `:${cacheVariantName(variant)}`;
  return createHash('sha256').update(canonical + suffix).digest('hex').slice(0, 32);
}

function cachePath(dir, url, variant) {
  return join(dir, `${canonicalCacheKey(url, variant)}.json`);
}

function readCache(dir, url, variant, ttlHours) {
  const path = cachePath(dir, url, variant);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw?.fetchedAt || typeof raw.body !== 'string') return null;
    const ageMs = Date.now() - new Date(raw.fetchedAt).valueOf();
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    if (ttlHours > 0 && ageMs > ttlHours * 3_600_000) return null;
    return { ...raw, body: Buffer.from(raw.body, 'base64'), _cachePath: path, _ageMs: ageMs };
  } catch (err) {
    console.warn(`[fetch-url] cache read failed for ${path}: ${err.message}`);
    return null;
  }
}

function writeCache(dir, url, variant, result) {
  try {
    mkdirSync(dir, { recursive: true });
    const payload = {
      requestedUrl: url,
      finalUrl: result.finalUrl,
      status: result.status,
      ok: result.ok,
      contentType: result.contentType,
      contentLength: result.contentLength,
      elapsedMs: result.elapsedMs,
      profile: result.profile,
      body: Buffer.from(result.body).toString('base64'),
      source: cacheVariantName(variant),
      fetchedAt: new Date().toISOString(),
    };
    writeFileSync(cachePath(dir, url, variant), JSON.stringify(payload), 'utf8');
  } catch (err) {
    console.error(`[fetch-url] cache write failed: ${err.message}`);
  }
}

const BOT_CHALLENGE_STATUSES = new Set([401, 403, 429, 451, 503]);
const BOT_CHALLENGE_MARKERS = [
  'datadome',
  'please enable js',
  'cf-browser-verification',
  'just a moment...',
  'access denied',
  'attention required! | cloudflare',
  'checking your browser before accessing',
  'enable cookies',
  'bot detection',
  'captcha',
  'perimeterx',
  'px-captcha',
  'incapsula',
  'imperva',
];

export function looksLikeBotChallenge(result) {
  if (!result) return false;
  if (BOT_CHALLENGE_STATUSES.has(result.status)) return true;
  // Bodies are always Buffers; sniff utf-8 of the first 4KB. PDF buffers
  // decode to mostly garbage and never contain HTML challenge markers.
  const body = Buffer.isBuffer(result.body)
    ? result.body.slice(0, 4000).toString('utf8').toLowerCase()
    : '';
  return BOT_CHALLENGE_MARKERS.some((marker) => body.includes(marker));
}

// The Wayback toolbar injects <div id="wm-ipp-base">...</div> and a
// SCRIPT_PATH redirect block. Strip them so text output is just the
// archived page content.
export function stripWaybackToolbar(html) {
  return String(html ?? '')
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT[\s\S]*?END WAYBACK TOOLBAR INSERT\s*-->/gi, '')
    .replace(/<div[^>]*id=["']wm-ipp(?:-base|-print)?["'][\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
    .replace(/<script[^>]*src=["'][^"']*\/static\/_wb_\/[\s\S]*?<\/script>/gi, '')
    .replace(/<link[^>]*\/static\/_wb_\/[^>]*>/gi, '');
}

async function writeOutputFile(file, output, { isPdf, raw, contentLength }) {
  if (Buffer.isBuffer(output)) {
    await writeFile(file, output);
    return {
      path: file,
      kind: 'pdf',
      bytes: contentLength,
      message: `Wrote ${contentLength} bytes (PDF) to ${file}`,
    };
  }
  const kind = raw && !isPdf ? 'body' : 'text';
  await writeFile(file, output, 'utf8');
  return {
    path: file,
    kind,
    bytes: Buffer.byteLength(output, 'utf8'),
    message: `Wrote ${kind} to ${file}`,
  };
}

function buildJsonPayload({ result, source, cacheHit, cacheAgeMinutes, cacheTtlHours, isPdf, title, pdfMeta, pdfTruncated, textExtraction, outputTruncated, output, outputFile, raw }) {
  const outputIsBuffer = Buffer.isBuffer(output);
  const payload = {
    status: result.status,
    ok: result.ok,
    requestedUrl: result.url,
    finalUrl: result.finalUrl,
    source: cacheHit ? 'cache' : source,
    retrievalSource: source,
    cache: {
      hit: cacheHit,
      ageMinutes: cacheHit ? cacheAgeMinutes : null,
      ttlHours: cacheTtlHours,
    },
    contentType: result.contentType,
    profile: result.profile,
    bytes: result.contentLength,
    elapsedMs: result.elapsedMs,
    format: isPdf ? 'pdf' : 'html',
    title,
    truncated: outputTruncated,
    outputKind: outputIsBuffer ? 'bytes' : (raw && !isPdf ? 'body' : 'text'),
    outputBytes: outputIsBuffer ? output.length : Buffer.byteLength(output, 'utf8'),
  };
  if (textExtraction) {
    const { text: _text, ...extraction } = textExtraction;
    payload.extraction = extraction;
  }
  if (isPdf) {
    payload.pdf = {
      pages: pdfMeta?.numPages ?? null,
      title,
      author: pdfMeta?.info?.Author ?? null,
      truncated: pdfTruncated,
    };
  }
  if (outputFile) payload.outputFile = outputFile;
  if (outputIsBuffer) {
    if (!outputFile) payload.outputBase64 = output.toString('base64');
    else payload.outputOmitted = 'binary output written to file';
  } else {
    payload.output = output;
  }
  return payload;
}

export async function main(args = argv.slice(2)) {
  const opts = parseArgs(args);
  if (opts.help) {
    help();
    return;
  }
  if (opts.error) {
    printUsageError(opts.error);
    exit(2);
  }
  try {
    new URL(opts.url);
  } catch {
    console.error(`Invalid URL: ${opts.url}`);
    exit(2);
  }
  if (!ALL_PROFILES[opts.profile]) {
    console.error(`Unknown profile: ${opts.profile}. Expected one of: ${ALL_PROFILE_NAMES.join(', ')}`);
    exit(2);
  }
  if (opts.viaReader && opts.viaWayback) {
    console.error('Choose only one forced fallback: --via-reader or --via-wayback.');
    exit(2);
  }
  if (!Number.isFinite(opts.cacheTtlHours) || opts.cacheTtlHours < 0) {
    console.error(`Invalid --cache-ttl-hours: ${opts.cacheTtlHours}`);
    exit(2);
  }
  if (!Number.isFinite(opts.throttleMs) || opts.throttleMs < 0) {
    console.error(`Invalid --throttle-ms: ${opts.throttleMs}`);
    exit(2);
  }
  if (opts.maxChars !== null && (!Number.isFinite(opts.maxChars) || opts.maxChars < 0)) {
    console.error(`Invalid --max-chars: ${opts.maxChars}`);
    exit(2);
  }

  // Fast-path: when the user did not force a profile or fallback, consult the
  // pre-computed host -> winning-strategy map. Hosts where origin/desktop-*
  // historically fail (e.g. wsj.com, www.capterra.com) jump straight to
  // reader/wayback instead of paying ~3-5s to retry the full chain.
  if (!opts.noHostMap && !opts.profileOverride && !opts.viaReader && !opts.viaWayback) {
    const entry = lookupHostStrategy(opts.url);
    if (entry) {
      const host = new URL(opts.url).host;
      const matchedVia = entry._matchedKey === host
        ? ''
        : ` via ${entry._matchedKey}`;
      // Surface stale entries so the user knows when to consider --refresh.
      const STALE_DAYS = 90;
      let staleSuffix = '';
      if (entry.tested_at) {
        const ageMs = Date.now() - new Date(entry.tested_at).valueOf();
        const ageDays = Number.isFinite(ageMs) && ageMs >= 0 ? Math.floor(ageMs / 86_400_000) : null;
        if (ageDays !== null && ageDays > STALE_DAYS) {
          staleSuffix = ` STALE: ${ageDays}d old, consider re-running probe.mjs --refresh`;
        }
      }

      // Known-failure hosts (probe couldn't find any working strategy) short-
      // circuit instead of paying ~30-60s to fail through the full chain again.
      // The user can still force the attempt with --ignore-host-map-failures.
      if (entry.strategy === null) {
        if (opts.ignoreHostMapFailures) {
          console.error(`[fetch-url] host-map: ${host}${matchedVia} is known-failure (tested ${entry.tested_at ?? 'unknown'}); ignoring per --ignore-host-map-failures.`);
        } else {
          const note = entry.note ? ` (${entry.note})` : '';
          console.error(`[fetch-url] host-map: ${host}${matchedVia} is known to block all strategies (tested ${entry.tested_at ?? 'unknown'})${note}.${staleSuffix}`);
          console.error('[fetch-url] Use the official API or a real headless browser. Pass --ignore-host-map-failures to attempt anyway.');
          exit(4);
        }
      } else if (entry.kind === 'reader') {
        opts.viaReader = true;
        console.error(`[fetch-url] host-map: ${host}${matchedVia} -> reader (tested ${entry.tested_at}).${staleSuffix}`);
      } else if (entry.kind === 'wayback') {
        opts.viaWayback = true;
        console.error(`[fetch-url] host-map: ${host}${matchedVia} -> wayback (tested ${entry.tested_at}).${staleSuffix}`);
      } else if (ALL_PROFILES[entry.strategy]) {
        opts.profile = entry.strategy;
        // Skip the multi-profile retry loop — the map already says which one
        // works. If it now fails, we still drop into the reader/wayback chain.
        opts.retryProfiles = false;
        console.error(`[fetch-url] host-map: ${host}${matchedVia} -> ${entry.strategy} (tested ${entry.tested_at}).${staleSuffix}`);
      }
    }
  }

  let result;
  let source = opts.viaReader ? 'reader' : opts.viaWayback ? 'wayback' : 'origin';
  let cacheHit = false;
  let cacheAgeMinutes = null;
  const useCacheRead = !opts.noCache && !opts.refreshCache;
  const useCacheWrite = !opts.noCache;
  const targetUrl = opts.viaReader ? readerUrl(opts.url) : opts.viaWayback ? waybackUrl(opts.url) : opts.url;

  if (useCacheRead) {
    const cached = readCache(opts.cacheDir, opts.url, source, opts.cacheTtlHours);
    if (cached) {
      result = {
        url: cached.requestedUrl,
        finalUrl: cached.finalUrl,
        status: cached.status,
        ok: cached.ok,
        contentType: cached.contentType,
        contentLength: cached.contentLength,
        elapsedMs: cached.elapsedMs,
        profile: cached.profile,
        body: cached.body,
      };
      source = cached.source ?? 'origin';
      cacheHit = true;
      cacheAgeMinutes = Math.round(cached._ageMs / 60_000);
    }
  }

  if (!cacheHit) {
    try {
      if (opts.viaReader || opts.viaWayback) {
        result = await fetchUrl(targetUrl, {
          profile: opts.profile,
          userAgent: opts.userAgentOverride ? opts.userAgent : null,
          throttleMs: opts.throttleMs,
        });
      } else {
        for (const profileAttempt of profileSequence(opts)) {
          // Pass profile + headers from the attempt so both UA AND JA3
          // fingerprint actually rotate between retries (previously only the
          // headers rotated while curl-impersonate kept the original profile).
          result = await fetchUrl(opts.url, {
            profile: profileAttempt.profile,
            headers: profileAttempt.headers,
            throttleMs: opts.throttleMs,
          });
          result = { ...result, profile: profileAttempt.name };
          if (!looksLikeBotChallenge(result)) break;
          console.error(`[fetch-url] origin via ${profileAttempt.name} returned ${result.status} or bot-challenge body.`);
        }
      }
    } catch (err) {
      console.error(`Fetch failed: ${err.message}`);
      appendFetchLog({
        url: opts.url,
        finalUrl: null,
        source,
        status: 0,
        profile: opts.profile,
        ok: false,
        sha256: null,
        bytes: 0,
        error: err.message,
      });
      exit(1);
    }

    if (!opts.viaReader && !opts.viaWayback && !opts.noReader && looksLikeBotChallenge(result)) {
      console.error('[fetch-url] origin still looks blocked; retrying via r.jina.ai reader text.');
      try {
        const cachedReader = useCacheRead ? readCache(opts.cacheDir, opts.url, 'reader', opts.cacheTtlHours) : null;
        const fallback = cachedReader
          ? { ...cachedReader, url: opts.url, body: cachedReader.body }
          : await fetchUrl(readerUrl(opts.url), {
              profile: opts.profile,
              userAgent: opts.userAgentOverride ? opts.userAgent : null,
              throttleMs: opts.throttleMs,
            });
        if (fallback.ok && !looksLikeBotChallenge(fallback)) {
          result = fallback;
          source = 'reader';
          cacheHit = Boolean(cachedReader);
          cacheAgeMinutes = cachedReader ? Math.round(cachedReader._ageMs / 60_000) : null;
        } else {
          console.error(`[fetch-url] Reader fallback also blocked or failed (status ${fallback.status}); trying archive if enabled.`);
        }
      } catch (err) {
        console.error(`[fetch-url] Reader fallback failed: ${err.message}; trying archive if enabled.`);
      }
    }

    if (!opts.viaWayback && !opts.noWayback && looksLikeBotChallenge(result)) {
      console.error('[fetch-url] retrying via Wayback Machine.');
      try {
        const cachedWayback = useCacheRead ? readCache(opts.cacheDir, opts.url, 'wayback', opts.cacheTtlHours) : null;
        const fallback = cachedWayback
          ? { ...cachedWayback, url: opts.url, body: cachedWayback.body }
          : await fetchUrl(waybackUrl(opts.url), {
              profile: opts.profile,
              userAgent: opts.userAgentOverride ? opts.userAgent : null,
              throttleMs: opts.throttleMs,
            });
        if (fallback.ok && !looksLikeBotChallenge(fallback)) {
          result = fallback;
          source = 'wayback';
          cacheHit = Boolean(cachedWayback);
          cacheAgeMinutes = cachedWayback ? Math.round(cachedWayback._ageMs / 60_000) : null;
        } else {
          console.error(`[fetch-url] Wayback fallback also blocked (status ${fallback.status}); keeping previous response.`);
        }
      } catch (err) {
        console.error(`[fetch-url] Wayback fallback failed: ${err.message}; keeping previous response.`);
      }
    }

    if (useCacheWrite && !cacheHit && result.ok && !looksLikeBotChallenge(result)) {
      writeCache(opts.cacheDir, opts.url, source, result);
    }
  }

  // One log line per main() invocation (cache hit OR live fetch). Lets a
  // downstream "every cited URL was fetched at least once" gate cross-check
  // report bibliographies against the actual fetch trail without parsing
  // stderr or per-call JSON output. No-op when STARTUP_FETCH_LOG_PATH is
  // unset (so interactive CLI runs do not write side-channel files).
  appendFetchLog({
    url: opts.url,
    finalUrl: result.finalUrl,
    source,
    status: result.status,
    profile: result.profile ?? opts.profile,
    ok: Boolean(result.ok),
    sha256: bodySha256(result.body),
    bytes: result.contentLength ?? (result.body?.length ?? 0),
    cacheHit,
  });

  // Magic-byte sniff on the actual body is the only PDF signal: a .pdf URL
  // that returned an HTML error page still flows through the HTML path, and
  // a no-extension EDGAR URL that returns a real PDF is still detected.
  const isPdf = looksLikePdfBuffer(result.body);

  // Compute the displayable output. PDFs always go through pdfToText when we
  // need text; their raw bytes are never printed to stdout. HTML decodes the
  // Buffer to utf-8 once here, then optionally strips the Wayback toolbar
  // and runs the cleaned text extraction path.
  let output;
  let pdfMeta = null;
  let pdfTruncated = false;
  let textExtraction = null;
  let outputTruncated = false;
  let bodyStr = null;
  if (isPdf) {
    if (!opts.raw || !opts.file) {
      // Need text for the default output. Skip parsing only when the user
      // explicitly wants raw bytes via --raw --out.
      try {
        const parsed = await pdfToText(result.body, { maxChars: opts.maxChars });
        output = parsed.text;
        pdfMeta = { numPages: parsed.numPages, info: parsed.info };
        pdfTruncated = parsed.truncated;
        outputTruncated = parsed.truncated;
      } catch (err) {
        console.error(`[fetch-url] PDF parse failed: ${err.message}`);
        exit(1);
      }
    } else {
      output = result.body;
    }
  } else {
    bodyStr = result.body.toString('utf8');
    if (source === 'wayback') bodyStr = stripWaybackToolbar(bodyStr);
    if (!opts.raw) {
      textExtraction = await extractHtmlText(bodyStr, result.finalUrl, result.contentType, { mainContent: opts.mainContent });
      output = textExtraction.text;
    } else {
      output = bodyStr;
    }
  }

  if (typeof output === 'string' && opts.maxChars !== null && output.length > opts.maxChars) {
    output = output.slice(0, opts.maxChars);
    outputTruncated = true;
    if (isPdf) pdfTruncated = true;
  }

  const title = isPdf
    ? (pdfMeta?.info?.Title?.trim() || null)
    : (textExtraction?.title?.trim?.() || extractTitle(bodyStr));

  if (opts.json) {
    const outputFile = opts.file
      ? await writeOutputFile(opts.file, output, { isPdf, raw: opts.raw, contentLength: result.contentLength })
      : null;
    console.log(JSON.stringify(buildJsonPayload({
      result,
      source,
      cacheHit,
      cacheAgeMinutes,
      cacheTtlHours: opts.cacheTtlHours,
      isPdf,
      title,
      pdfMeta,
      pdfTruncated,
      textExtraction,
      outputTruncated,
      output,
      outputFile,
      raw: opts.raw,
    }), null, 2));
    if (!result.ok) exit(1);
    return;
  }

  console.log(`Status:        ${result.status} ${result.ok ? 'OK' : 'FAIL'}`);
  console.log(`Final URL:     ${result.finalUrl}`);
  if (cacheHit) console.log(`Source:        cache (age ${cacheAgeMinutes}m, ttl ${opts.cacheTtlHours}h, ${source})`);
  else if (source === 'reader') console.log('Source:        reader (r.jina.ai text view)');
  else if (source === 'wayback') console.log('Source:        wayback (web.archive.org snapshot)');
  else console.log('Source:        origin');
  console.log(`Content-Type:  ${result.contentType ?? '(none)'}`);
  console.log(`Profile:       ${result.profile ?? (opts.userAgentOverride ? 'custom' : opts.profile)}`);
  console.log(`Bytes:         ${result.contentLength}`);
  console.log(`Elapsed:       ${result.elapsedMs} ms${cacheHit ? ' (original)' : ''}`);
  if (isPdf) {
    console.log(`Format:        PDF`);
    console.log(`PDF pages:     ${pdfMeta?.numPages ?? '(unknown)'}`);
    if (pdfMeta?.info?.Author) console.log(`PDF author:    ${pdfMeta.info.Author}`);
    console.log(`PDF title:     ${title ?? '(not found)'}`);
    if (pdfTruncated) console.log(`Truncated:     yes (--max-chars ${opts.maxChars})`);
    if (typeof output === 'string') console.log(`Text bytes:    ${output.length}`);
  } else {
    console.log(`<title>:       ${title ?? '(not found)'}`);
    if (!opts.raw && textExtraction) {
      const extractionLabel = textExtraction.used
        ? 'main-content (Readability)'
        : `full-text${textExtraction.fallbackReason ? ` (${textExtraction.fallbackReason})` : ''}`;
      console.log(`Text mode:     ${extractionLabel}`);
    }
    if (outputTruncated) console.log(`Truncated:     yes (--max-chars ${opts.maxChars})`);
    if (!opts.raw) console.log(`Text bytes:    ${output.length}`);
  }

  if (opts.file) {
    const outputFile = await writeOutputFile(opts.file, output, { isPdf, raw: opts.raw, contentLength: result.contentLength });
    console.log(outputFile.message);
  } else if (isPdf && opts.raw) {
    // Raw PDF behavior on a TTY (--raw, no --out): show
    // metadata + a short text preview, but do NOT dump full text to terminal.
    // Omit --raw for the normal extracted-text path, or use --raw --out file.pdf for bytes.
    const preview = (typeof output === 'string' ? output : '').slice(0, 800);
    console.log(`Preview:\n${preview}${typeof output === 'string' && output.length > 800 ? '\n…' : ''}`);
    console.log(`(omit --raw for extracted text, use --raw --out file.pdf for raw bytes, --max-chars N to cap text size)`);
  } else if (!process.stdout.isTTY) {
    // Redirected/piped (e.g. `> file.txt`): emit the full body so callers do
    // not silently capture only the preview window. Interactive TTYs still
    // get the truncated preview below to protect terminal/agent context.
    if (!opts.raw || isPdf) console.log(`Text:\n${output}`);
    else console.log(`Body:\n${output}`);
  } else {
    const limit = !opts.raw ? 1000 : 500;
    const preview = !opts.raw
      ? output.slice(0, limit)
      : output.slice(0, limit).replace(/\s+/g, ' ').trim();
    if (!opts.raw) console.log(`Text:\n${preview}${output.length > limit ? '\n…' : ''}`);
    else console.log(`Preview:       ${preview}${output.length > limit ? '…' : ''}`);
  }
  if (!result.ok) exit(1);
}

if (import.meta.url === `file://${argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
