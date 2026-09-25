/**
 * Optional dispatcher for the existing hourly Cloudflare trigger (0 * * * *).
 * GitHub Actions currently owns scheduling; do not enable both schedulers.
 * Required secrets: GITHUB_TOKEN (Actions: write), GITHUB_REPO (owner/repo).
 * Optional variable: GITHUB_REF (defaults to main).
 * Model selection belongs to the workflows, not this dispatcher.
 */
const dispatches = [
  {
    workflow: 'research-unicorns.yml',
    isDue: (hour) => hour % 6 === 0,
    inputs: { industry: 'Any', unicornCount: '1', profile: 'fast' },
  },
  {
    workflow: 'translate-reports-zh.yml',
    isDue: (hour) => hour % 2 === 0,
    inputs: { reportCount: '1' },
  },
  {
    workflow: 'refresh-portfolio.yml',
    isDue: (hour) => hour === 2,
    inputs: { maxBatch: '0', profile: 'fast' },
  },
];

export default {
  async scheduled(event, env) {
    const scheduledAt = new Date(event.scheduledTime);
    if (!Number.isFinite(scheduledAt.getTime())) {
      throw new Error('Invalid scheduledTime');
    }
    const due = scheduledAt.getUTCMinutes() === 0
      ? dispatches.filter((dispatch) => dispatch.isDue(scheduledAt.getUTCHours()))
      : [];
    if (due.length === 0) {
      console.log(`No workflows due at ${scheduledAt.toISOString()}`);
      return;
    }
    if (!env.GITHUB_TOKEN) throw new Error('Missing GITHUB_TOKEN secret');
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO ?? '')) {
      throw new Error('GITHUB_REPO must be an owner/repo string');
    }
    const ref = env.GITHUB_REF || 'main';
    const results = await Promise.allSettled(due.map(async ({ workflow, inputs }) => {
      const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'startup-cloudflare-scheduler',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ ref, inputs }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new Error(`GitHub dispatch ${workflow} failed: HTTP ${response.status}`);
      }
      console.log(`Dispatched ${workflow} on ${ref}`);
    }));
    const failures = results.flatMap((result, index) => (
      result.status === 'rejected'
        ? [`${due[index].workflow}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
        : []
    ));
    if (failures.length > 0) {
      throw new Error(`Workflow dispatch failed: ${failures.join('; ')}`);
    }
  },
};
