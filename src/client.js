/** HTTP client for the domscout API, independent of the MCP transport. */

export const DEFAULT_BASE_URL = 'https://api.domscout.io';

/** Long enough for a synchronous capture (24s budget) plus transfer. */
export const REQUEST_TIMEOUT_MS = 45_000;

export class DomscoutError extends Error {
  constructor(message, { status = null, code = null, requestId = null, suggestions = [], retriable = false } = {}) {
    super(message);
    this.name = 'DomscoutError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.suggestions = suggestions;
    this.retriable = retriable;
  }
}

// Explicit refusal codes take precedence over budget headers. Missing headers
// cannot establish an exhausted balance: gateway throttles omit them entirely.
const RETRIABLE_429_CODES = new Set(['RATE_LIMIT_EXCEEDED']);
const TERMINAL_429_CODES = new Set(['QUOTA_EXCEEDED', 'OVERAGE_CEILING_REACHED', 'FEEDBACK_LIMIT_REACHED']);

function classify(status, headers, code = null) {
  if (status === 429) {
    if (RETRIABLE_429_CODES.has(code)) return true;
    if (TERMINAL_429_CODES.has(code)) return false;
    const credits = headerNumber(headers, 'x-domscout-credits-remaining');
    const quota = headerNumber(headers, 'x-domscout-quota-remaining');
    if (credits === null || quota === null) return true;
    return !(credits <= 0 && quota <= 0);
  }
  return status >= 500 && status !== 501;
}

/** Reject malformed, non-HTTP and credential-bearing target URLs locally.
 * Public reachability is checked by the API against the address it actually dials.
 */
export function assertTargetUrlIsDialable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new DomscoutError(
      `Not a URL: ${JSON.stringify(url)}. Pass an absolute URL including the scheme, such as https://example.com/page.`,
      { status: 400, code: 'URL_INVALID', retriable: false },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DomscoutError(
      `These tools dial http and https only, not ${parsed.protocol.replace(/:$/, "")}.`,
      { status: 400, code: 'URL_SCHEME_NOT_ALLOWED', retriable: false },
    );
  }
  if (parsed.username || parsed.password) {
    throw new DomscoutError(
      'Credentials in the URL are not supported: these tools capture as an anonymous visitor. '
        + 'Use the REST API directly if the page needs authentication.',
      { status: 400, code: 'URL_INVALID', retriable: false },
    );
  }
}
export function createClient({
  apiKey = process.env.DOMSCOUT_API_KEY,
  baseUrl = process.env.DOMSCOUT_BASE_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) {
    throw new Error(
      'DOMSCOUT_API_KEY is not set. Create a key at https://www.domscout.io/dashboard/api-keys '
      + 'and pass it in the MCP server\'s env block.',
    );
  }

  const root = String(baseUrl).replace(/\/+$/, '');
  assertKeyStaysEncrypted(root);
  warnIfStageSuffix(root);

  async function request(method, routePath, body) {
    // Every URL-bearing tool reaches the API through here — capture, scrape and
    // crawl all carry the target as `body.url` — so this is the one place the
    // check belongs rather than six.
    if (body && typeof body.url === 'string') assertTargetUrlIsDialable(body.url);

    let response;
    try {
      response = await fetchImpl(`${root}${routePath}`, {
        method,
        // `manual`, because fetch's default follows a redirect to ANY origin and
        // keeps the custom `x-api-key` header on the way — so a redirecting proxy
        // or gateway would hand the key to another host, over http if it chose.
        // The API itself never redirects; a 3xx is refused below.
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          'x-api-key': apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (transportError) {
      throw new DomscoutError(`Could not reach the domscout API: ${transportError.message}`, { retriable: true });
    }

    if (response.status >= 300 && response.status < 400) {
      throw new DomscoutError(
        `The domscout API at ${root} answered ${response.status} with a redirect, which this client does not `
        + 'follow because following it would send DOMSCOUT_API_KEY to wherever it points. Check DOMSCOUT_BASE_URL.',
        { status: response.status, retriable: false },
      );
    }

    // Body reads can time out or reset after headers arrive; preserve the retry verdict.
    let text;
    try {
      text = await response.text();
    } catch (bodyError) {
      throw new DomscoutError(
        `Could not read the domscout API response: ${bodyError.message}`,
        { retriable: true, status: response.status, requestId: response.headers.get('x-request-id') ?? null },
      );
    }
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }

    // Budget facts ride along on every result, success or failure, so a tool
    // can tell the model what a call cost without a second round trip.
    const usage = {
      creditCost: headerNumber(response.headers, 'x-domscout-credits-cost'),
      creditsRemaining: headerNumber(response.headers, 'x-domscout-credits-remaining'),
      quotaRemaining: headerNumber(response.headers, 'x-domscout-quota-remaining'),
      requestId: response.headers.get('x-request-id') ?? null,
    };

    if (!response.ok) {
      throw new DomscoutError(payload?.error || `domscout returned ${response.status}`, {
        status: response.status,
        code: payload?.code || null,
        requestId: payload?.requestId || usage.requestId,
        suggestions: Array.isArray(payload?.suggestions) ? payload.suggestions : [],
        retriable: classify(response.status, response.headers, payload?.code || null),
      });
    }

    return { data: payload, usage, status: response.status };
  }

  return {
    baseUrl: root,
    capture: (body) => request('POST', '/screenshot', body),
    // The content endpoint. Same engine as /screenshot, but it answers with a
    // document instead of a base64 image — which is the difference between a
    // few KB of Markdown and several hundred KB of pixels crossing the MCP
    // transport into a model's context for a page it only wanted to read.
    scrape: (body) => request('POST', '/scrape', body),
    credits: () => request('GET', '/credits'),
    feedback: (body) => request('POST', '/feedback', body),
    job: (jobId) => request('GET', `/job/${encodeURIComponent(jobId)}`),
    cancelJob: (jobId) => request('DELETE', `/job/${encodeURIComponent(jobId)}`),
    crawl: (body) => request('POST', '/crawl', body),
    crawlStatus: (jobId) => request('GET', `/crawl/${encodeURIComponent(jobId)}`),
    batch: (body) => request('POST', '/batch', body),
    batchStatus: (jobId) => request('GET', `/batch/${encodeURIComponent(jobId)}`),
    request,
  };
}

// Outside loopback, API keys must travel over HTTPS.
function assertKeyStaysEncrypted(root) {
  let url;
  try {
    url = new URL(root);
  } catch {
    throw new Error(`DOMSCOUT_BASE_URL is not a valid URL: "${root}".`);
  }
  if (url.protocol === 'https:') return;
  const host = url.hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol === 'http:' && loopback) return;
  throw new Error(
    `DOMSCOUT_BASE_URL is "${root}", which would send DOMSCOUT_API_KEY over an unencrypted `
    + `connection to ${host || 'that host'}. Use https://, or a loopback address for local `
    + 'development. Refusing rather than leaking the key.',
  );
}

// Custom-domain stage suffixes can produce a gateway 403 before authentication.
// Warn without rewriting an intentionally configured deployment URL.
function warnIfStageSuffix(root) {
  let url;
  try { url = new URL(root); } catch { return; }
  if (url.hostname.endsWith('.amazonaws.com')) return;
  const match = url.pathname.match(/\/(prod|staging|dev)$/);
  if (!match) return;
  console.error(
    `[domscout] DOMSCOUT_BASE_URL is "${root}", which ends in the API Gateway stage segment `
    + `"/${match[1]}". ${url.hostname} is a custom domain whose base path is already mapped onto `
    + 'that stage, so every request will get a 403 from API Gateway before authentication. '
    + `Use "${url.origin}${url.pathname.slice(0, match.index)}" unless you have deliberately `
    + `mapped a base path named "${match[1]}".`,
  );
}

/**
 * One header as a number, or null when it was not sent.
 *
 * The null check is the whole point. `Number(null)` and `Number('')` are both
 * 0, so a header the API omitted — which it does whenever the value is not
 * finite, and which API Gateway does for every request that never reaches the
 * Lambda — would otherwise be indistinguishable from a real balance of zero.
 * The caller renders `?` for null and "0 credits remaining" for 0.
 */
function headerNumber(headers, name) {
  // `undefined` as well as `null`: the test doubles use a Map, whose `.get`
  // misses with undefined, while a real Headers object misses with null.
  const raw = headers.get(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
