import { defineConfig } from 'astro/config';
import { readReportRedirects } from '../.agents/skills/startup-research/scripts/report-retention.mjs';
import { reportRedirectRoutes } from './src/lib/report-paths.mjs';

// Project pages base path. Keep '/' for the attached custom domain.
const SITE = process.env.SITE_URL || 'https://startup.genisisiq.com';
const BASE = process.env.BASE_PATH ?? '/';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  output: 'static',
  redirects: reportRedirectRoutes(readReportRedirects(), BASE),
  build: {
    format: 'directory',
  },
  markdown: {
    syntaxHighlight: false,
  },
});
