export async function register() {
  // Only run on server startup
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      console.warn(
        '\n⚠️  WARNING: OPENROUTER_API_KEY is not set.\n' +
        '   The /api/generate-cad endpoint will not work without it.\n' +
        '   Set it in your .env.local file or environment variables.\n'
      );
    } else {
      console.log('✓ OPENROUTER_API_KEY is configured');
    }

    const cadWorkerUrl = process.env.CAD_WORKER_URL || 'http://localhost:8000';
    console.log(`✓ CAD Worker URL: ${cadWorkerUrl}`);

    // In production, the rate limiter must trust the proxy header to key
    // per-IP. Without TRUST_PROXY (>= 1), all callers collapse into one bucket
    // and a single active user can lock out everyone else.
    const { trustedProxyHops, trustsCloudflareHeader } = await import('@/lib/rate-limit');
    if (process.env.NODE_ENV === 'production' && trustedProxyHops() === 0 && !trustsCloudflareHeader()) {
      console.warn(
        '\n⚠️  WARNING: TRUST_PROXY is not set in production.\n' +
        '   The rate limiter will treat ALL traffic as a single bucket,\n' +
        '   so one user can block the endpoint for everyone else.\n' +
        '   Behind trusted proxies set TRUST_PROXY to their count (CDN + reverse proxy = 2),\n' +
        '   and only if the origin accepts traffic from those proxies alone.\n'
      );
    }

    if (process.env.EMERGENCY_DISABLE_GENERATION === '1') {
      console.warn(
        '\n⚠️  EMERGENCY_DISABLE_GENERATION=1 — /api/generate-cad will return 503.\n'
      );
    }

    // An unrecognised WEB_SEARCH value disables search (fails closed); say so.
    const { webSearchEnvWarning } = await import('@/lib/web-search');
    const webSearchWarning = webSearchEnvWarning();
    if (webSearchWarning) console.warn(`\n⚠️  ${webSearchWarning}\n`);
  }
}
