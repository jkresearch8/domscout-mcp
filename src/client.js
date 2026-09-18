/**
 * A thin HTTP client for the domscout API.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────
 *
 * It has no browser, no database credential, and no payment credential. It
 * sends `x-api-key` to one host and reads JSON back. The MCP server runs on a
 * user's machine, inside whatever agent platform they chose, so the blast
 * radius of it being compromised must be exactly "someone can spend that user's
 * captures" — nothing more.
 *
 * Kept free of the MCP SDK so it can be tested without a transport.
 */

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

/**
 * Which failures are worth trying again.
 *
 * A 403 is never retriable here: it is a bad key, a plan gate, or the
 * browser-isolation hold, and none of those change between two calls a second
 * apart. Telling a model otherwise is how it spends its whole budget on a wall.
 *
 * A 429 is retriable ONLY when the budget headers say the refusal was the rate
 * limit rather than an exhausted balance. That distinction is the difference
 * between "wait one second" and "you cannot afford this at all", and it is the
 * single most useful thing this client does for the caller.
 *
 * ── ABSENT IS NOT ZERO ──────────────────────────────────────────────────────
 *
 * `headers.get()` returns null for a header that was never sent, and
 * `Number(null)` is 0, not NaN. Read naively, a 429 carrying NEITHER budget
 * header therefore looked like a balance of exactly zero and was reported as
 * terminal. That is precisely the shape of an API Gateway throttle: the Lambda
 * is never invoked, so no `x-domscout-*` header exists, and the one case where
 * waiting a second is exactly the right move was the one case we told the model
 * not to bother. Missing evidence now means retriable, not broke.
 */
function classify(status, headers) {
  if (status === 429) {
    const credits = headerNumber(headers, 'x-domscout-credits-remaining');
    const quota = headerNumber(headers, 'x-domscout-quota-remaining');
    if (credits === null || quota === null) return true;
    return !(credits <= 0 && quota <= 0);
  }
  return status >= 500 && status !== 501;
}

/**
 * Refuse a target URL the tools already promise to refuse.
 *
 * URL_PROP tells the model the page "must be http(s)" and that credentials in
 * the URL are rejected — and then nothing checked either. The schema carries
 * `type: string` and prose, and validate.js deliberately has no `pattern`
 * keyword (its own header explains why a promised-but-unenforced keyword is
 * worse than none). So `url: "example.com"` and `url: ""` were packed into a
 * request and sent, to be refused by the API as URL_INVALID after a round trip
 * and a rate-limit slot.
 *
 * ONLY the three things that can be decided here, deliberately. Whether a host
 * is publicly reachable — loopback, private ranges, metadata addresses, DNS
 * rebinding — is settled by guardedLookup at capture time against the address
 * actually dialled. Re-implementing any of that here would be a second, weaker
 * policy that drifts from the one that matters.
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

    // THE BODY IS AS MUCH THE TRANSPORT AS THE HEADERS ARE.
    //
    // This read sat outside the try above, so only time-to-headers was
    // classified. A peer can answer with a status line and then reset the
    // connection or trickle the body forever, and `AbortSignal.timeout` covers
    // body reading too — so a truncated or aborted body threw a bare
    // TypeError/DOMException rather than a DomscoutError.
    //
    // That is not a cosmetic difference. `toErrorContent` branches on
    // `instanceof DomscoutError` and falls to a generic "domscout tool failed"
    // line for anything else, with no retriability verdict attached. So the one
    // failure class that is almost always worth retrying was the one the model
    // was told nothing about — defeating the distinction this file exists to
    // draw.
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
        retriable: classify(response.status, response.headers),
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

/**
 * `DOMSCOUT_API_KEY` travels in a header on every request, so the scheme is not
 * cosmetic.
 *
 * Nothing checked it. The default is HTTPS, but `DOMSCOUT_BASE_URL` exists to
 * point this client somewhere else, and `http://` there put a live customer
 * credential on the wire in clear text on every tool call — recoverable by
 * anything between the operator's machine and that host, and with no symptom to
 * notice, because the requests all succeed.
 *
 * Loopback is exempt: `http://127.0.0.1:3000` is how the API is developed
 * against locally, and the key never leaves the machine. Everything else is
 * REFUSED rather than warned. A warning on stderr is the right weight for the
 * stage-suffix mistake below, which costs a confusing 403; it is the wrong
 * weight for handing out a credential, which cannot be taken back once sent.
 */
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

/**
 * A stage segment on a custom domain is always wrong, and fails late.
 *
 * The raw gateway host carries the stage in the path
 * (`…execute-api.us-east-1.amazonaws.com/prod`). `api.domscout.io` does not: it
 * is a base-path mapping ONTO the prod stage, so the segment is already spent
 * and `https://api.domscout.io/prod/screenshot` asks for a base path named
 * `prod` that is mapped to nothing. API Gateway answers 403 before the Lambda
 * is reached, which reads exactly like a bad API key and sends the operator
 * looking at the wrong thing.
 *
 * The obvious repair — strip the segment — is deliberately not taken.
 * `DOMSCOUT_BASE_URL` exists for an intentionally separate deployment, and
 * someone who really has mapped a base path called `prod` would find their URL
 * silently rewritten with no way to opt out. Saying so on stderr costs them
 * nothing and tells the operator who copied the old URL out of a stale document
 * precisely what to remove.
 *
 * stderr, not stdout: stdout IS the JSON-RPC transport, and a stray line there
 * corrupts the frame the host is parsing.
 */
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
