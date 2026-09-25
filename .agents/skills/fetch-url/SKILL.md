---
name: fetch-url
description: "Use when: fetching raw HTML or readable text from a URL/link/page, extracting text from a PDF (10-K, S-1, prospectus, investor deck, white paper, court filing, regulatory report), saving a body to disk, extracting a page title, or inspecting official website pages. Keywords: fetch URL, fetch link, HTTP GET, scrape HTML, html to text, plain text, strip tags, page title, sitemap, PDF, pdf to text, parse PDF, extract PDF text, 10-K, S-1, prospectus, SEC filing."
argument-hint: "<url> [--json] [--out <file>] [--full-text]"
---

# Fetch URL

Fetch one URL and return useful readable content. By default, HTML pages return main-content text and PDFs return extracted text. Use `./scripts/fetch.mjs` directly.

## Start here

```sh
node .agents/skills/fetch-url/scripts/fetch.mjs <url>
```

Use this default for normal source review. It is the preferred agent path: URL in, readable content out.

## Startup-research audit trail

When this skill is used inside the `startup-research` workflow, preserve the `STARTUP_FETCH_LOG_PATH` environment variable that `create-report-run.mjs` printed for the run (or source `.research-cache/<runId>/env.sh` if it exists). Every fetch appends one JSONL entry to that trail; `check-chapter --strict` uses it to verify that cited URLs were actually retrieved during the run. If the variable is missing, fetches still work, but startup-research strict validation will fail with `fetchTrailMissing` once sources are cited.

## Common parameters

- `--json`: use when another script/agent step needs structured fields such as status, final URL, source/cache state, title/PDF metadata, extraction mode, and output text.
- `--out <file>` / `-o <file>`: use when the output is long, should be grepped later, or should be kept as a diagnostic artifact. By default this saves the same readable text that would be printed.
- `--full-text` / `--no-main-content`: use only when the default output looks suspiciously short or misses important page sections. This keeps more page chrome and is useful for product/home pages, pricing pages, feature grids, docs tables, customer logos, or navigation context. It is not a cleaner mode.
- `--raw` / `--raw-html`: use only for diagnostics or archival when you need original HTML or raw PDF bytes. For PDFs, pair it with `--out`, e.g. `--raw --out report.pdf`.

## PDF scenarios

- Normal PDF review: `node .agents/skills/fetch-url/scripts/fetch.mjs <pdf-url>`
- Save extracted text: add `--out report.txt`.
- Save the original PDF file: add `--raw --out report.pdf`.

Scanned PDFs without a text layer may return empty/whitespace text; this skill does not OCR.

## Rare troubleshooting parameters

Use these only when the simple command is blocked, stale, or needs a controlled retry.

- `--refresh-cache`: use when a page likely changed and cached content may be stale.
- `--no-cache`: use when you need one network-truth check and do not want to read or write cache.
- `--cache-dir <path>`: use when multiple runs should share a specific cache location.
- `--cache-ttl-hours <n>`: use when the default cache lifetime is too short or too long for a source.
- `--profile <name>`: use when a source behaves differently by caller identity. Supported names: `bingbot`, `googlebot`, `desktop-chrome`, `desktop-firefox`, `desktop-safari`, `mobile-safari`.
- `--user-agent <ua>`: use only when you must test a specific User-Agent string.
- `--no-retry-profiles`: use to reproduce the first attempt without automatic identity retries.
- `--via-reader`: use when the origin page is blocked or too noisy and a reader-style copy is acceptable.
- `--via-wayback`: use when the live page is blocked, removed, or you need an archived snapshot.
- `--no-reader` / `--no-wayback`: use when you must avoid fallback sources and inspect only the live/origin behavior.
- `--no-host-map`: use when you want to ignore saved per-host strategy choices for a fresh diagnostic attempt.
- `--ignore-host-map-failures`: use when a host was previously marked as blocked but you want to test it again.
- `--throttle-ms <n>`: use to slow down requests to sensitive hosts.
- `--no-throttle`: use only for quick local diagnostics where rate pressure is not a concern.
- `--help`: print the script's full CLI help.

## Use for / do not use for

Use for single-URL source review, readable-text extraction, PDF text extraction, page-title/reachability checks, grep-friendly dumps, and local diagnostic snapshots.

Do not use for broad source discovery, multi-page crawling, JavaScript login flows, or interactive pages. Search first, then fetch direct URLs.

## Completion check

Confirm status, final URL, source/cache state, content type, bytes, elapsed time, title/PDF metadata, and whether output was truncated. For non-2xx responses, record the failure rather than inventing page content.

HTTP 200 alone does not establish successful retrieval. Recognized browser/security challenge pages and reader responses reporting upstream HTTP errors trigger fallbacks; if none succeeds, the command exits nonzero and records `ok: false` with an explicit error in both JSON output and the fetch trail. Cached access-error pages are retried rather than reused as evidence. A successful fetch still requires review for relevance and factual support.
