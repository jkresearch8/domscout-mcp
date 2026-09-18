/**
 * The tools domscout exposes to an agent.
 *
 * ── WHY TEN TOOLS AND NOT EIGHTY ────────────────────────────────────────────
 *
 * The domscout REST contract carries 80+ schemas, and `POST /screenshot` alone
 * accepts ~40 top-level fields. Exposing that surface one-to-one would put tens of
 * thousands of tokens of schema into the model's context before it has done
 * anything, and every one of those parameters is a way to get the call wrong.
 *
 * These are shaped by TASK instead: "get me the readable text of this page" is
 * a thing an agent wants; "POST /screenshot with extractMarkdown: true,
 * responseType: json, and format omitted" is how you do it. The mapping is this
 * file's job, not the model's.
 *
 * ── WHY EVERY DESCRIPTION STATES A PRICE ────────────────────────────────────
 *
 * Requests are weighted, and a model that cannot see the cost of a tool will
 * either avoid the useful ones or exhaust a balance on them. The cost is the
 * first thing in each description for the same reason it is the first thing on
 * a menu.
 *
 * SDK-free on purpose so it can be tested without one.
 */

import { DomscoutError } from './client.js';

/** Cost text, kept identical to the price list the API bills from. */
const COSTS = {
  base: 1,
  max: 10,
  free: 'Free — this call never consumes credits or quota.',
};

/**
 * The most base64 a single PDF may contribute to a conversation.
 *
 * 256KB of base64 is about 192KB of document and roughly 64k tokens: already
 * an expensive answer, and a generous ceiling for something the model cannot
 * read.
 */
const MAX_INLINE_PDF_BASE64 = 256 * 1024;

const URL_PROP = {
  type: 'string',
  // NO TOOL HERE ACCEPTS `headers`, and this description used to tell the model
  // to use it. A parameter named in a schema description is a parameter the
  // model will try to send, and `additionalProperties: false` now refuses it —
  // so the advice cost a call and produced an error naming a field that does not
  // exist. Authenticated capture is a REST-API feature, not an MCP-tool one.
  description: 'The page to load. Must be http(s) and publicly reachable. Credentials in the URL (https://user:pass@host) are rejected; these tools capture as an anonymous visitor, so use the REST API directly if the page needs authentication.',
};

const VIEWPORT_PROPS = {
  width: { type: 'integer', minimum: 100, maximum: 3840, default: 1280, description: 'Viewport width in CSS pixels.' },
  height: { type: 'integer', minimum: 100, maximum: 2160, default: 800, description: 'Viewport height in CSS pixels.' },
  devicePreset: {
    type: 'string',
    enum: ['desktop', 'iphone13', 'pixel7', 'ipad'],
    description: 'Preset viewport and device characteristics. Overrides width/height when set.',
  },
};

const WAIT_PROPS = {
  waitForSelector: { type: 'string', maxLength: 2000, description: 'Wait for this CSS selector to appear before capturing.' },
  delay: { type: 'integer', minimum: 0, maximum: 5000, default: 0, description: 'Extra milliseconds to wait after load.' },
};

/**
 * Tool definitions. `build` turns validated arguments into an API call and a
 * result; it never talks to the network itself, which is what makes this file
 * testable against a fake client.
 */
export const TOOLS = [
  {
    name: 'domscout_check_credits',
    title: 'Check credit balance and pricing',
    description:
      `${COSTS.free} Returns the credit balance, this month's quota usage, the per-second rate limit, `
      + 'and the full price list for every capture option. Call this before a large run to budget it, '
      + 'and after a 429 to find out whether you were rate limited (retry in a second) or are out of '
      + 'credits (do not retry).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(client) {
      const { data } = await client.credits();
      return { json: data };
    },
  },

  {
    name: 'domscout_extract_markdown',
    title: 'Read a page as clean Markdown',
    description:
      `Costs ${COSTS.base} credit. Loads a page and returns its main content as clean Markdown, with `
      + 'the title, description, Open Graph fields, word count, an estimated token count, and a '
      + 'content-quality flag. This is the right tool for reading a page — it is the cheapest option '
      + 'and returns text rather than an image. Use domscout_capture_screenshot only when you actually '
      + 'need to SEE the page. '
      + 'Set fast:true for static pages (documentation, blogs, news, changelogs): same price, same '
      + 'result shape, roughly an order of magnitude faster, but it does not run JavaScript. Check '
      + 'meta.renderJs and meta.contentQuality in the result and retry without fast:true if the page '
      + 'came back thin.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: URL_PROP,
        ...WAIT_PROPS,
        fast: {
          type: 'boolean',
          default: false,
          description:
            'Skip the browser and read the served HTML directly. Much faster and the same price, but '
            + 'JavaScript does not run, so a client-rendered page may come back empty. Cannot be '
            + 'combined with waitForSelector or delay, which need a live page.',
        },
        lazyScroll: {
          type: 'boolean',
          default: false,
          description: 'Scroll the page first to trigger lazy-loaded content. Adds 1 credit. Needs a browser, so it cannot be combined with fast:true.',
        },
      },
    },
    async run(client, args) {
      // REFUSED HERE RATHER THAN AT THE API. These three need a live page, and
      // the server would answer with a document that silently ignored them —
      // costing a credit to learn that. Naming the conflict locally costs
      // nothing and tells the model exactly which half to drop.
      if (args.fast === true) {
        // `delay: 0` is not a delay, so it is not a conflict.
        //
        // The filter kept any value that was neither undefined nor false, and
        // 0 is neither. So `fast: true, delay: 0` — an explicit no-op, and the
        // shape a model produces when it fills every property of the schema —
        // was refused with a 400 claiming `delay` could not take effect. It was
        // never going to take effect: it asks for no wait at all, which is
        // exactly what fast:true already does. The refusal cost the caller a
        // round trip to be told to drop an option that changed nothing.
        const needsBrowser = ['waitForSelector', 'delay', 'lazyScroll']
          .filter((key) => args[key] !== undefined && args[key] !== false && args[key] !== 0);
        if (needsBrowser.length > 0) {
          throw new DomscoutError(
            `fast:true skips the browser, so ${needsBrowser.join(', ')} cannot take effect. `
            + 'Drop fast:true to run the browser, or drop those options.',
            { status: 400, code: 'VALIDATION_FAILED' },
          );
        }
      }

      const { data, usage } = await client.scrape({
        url: args.url,
        ...(args.fast === true ? { renderJs: false } : {}),
        ...pick(args, ['waitForSelector', 'delay', 'lazyScroll']),
      });
      if (data?.status === 'accepted') return { json: asyncNotice(data), usage };
      return {
        // The Markdown crosses as TEXT and the rest as JSON, deliberately. A
        // model reads the document; it inspects the metadata only when the
        // document looks wrong, and burying the prose inside a JSON blob makes
        // the common case cost more tokens and read worse.
        text: data?.markdown || '(no readable content was extracted)',
        json: {
          url: data?.url,
          title: data?.title,
          meta: data?.metadata,
          links: data?.links?.slice(0, 100),
        },
        usage,
      };
    },
  },

  {
    name: 'domscout_capture_screenshot',
    title: 'Screenshot a page',
    description:
      `Costs ${COSTS.base} credit for a viewport PNG/JPEG/WebP; +1 for fullPage, +1 for PDF. Returns `
      + 'the image itself. Use this when you need to see layout, styling, or a visual state — for '
      + 'reading text, domscout_extract_markdown is cheaper and more useful.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: URL_PROP,
        format: { type: 'string', enum: ['png', 'jpeg', 'webp', 'pdf'], default: 'png', description: 'PDF requires a Pro plan or above.' },
        fullPage: { type: 'boolean', default: false, description: 'Capture the whole scrollable page. Requires Pro or above. Adds 1 credit.' },
        selector: { type: 'string', maxLength: 2000, description: 'Capture only this element.' },
        hideSelectors: { type: 'array', maxItems: 50, items: { type: 'string' }, description: 'Elements to hide before capturing, e.g. cookie banners.' },
        quality: { type: 'integer', minimum: 1, maximum: 100, default: 80, description: 'JPEG/WebP quality.' },
        ...VIEWPORT_PROPS,
        ...WAIT_PROPS,
      },
    },
    async run(client, args) {
      const { data, usage } = await client.capture({
        url: args.url,
        responseType: 'json',
        ...pick(args, ['format', 'fullPage', 'selector', 'hideSelectors', 'quality', 'width', 'height', 'waitForSelector', 'delay']),
        ...(args.devicePreset ? { render: { devicePreset: args.devicePreset } } : {}),
      });
      if (data?.status === 'accepted') return { json: asyncNotice(data), usage };

      const base64 = data?.screenshotBase64 || data?.pdfBase64;
      if (!base64) return { json: data, usage };
      if (args.format === 'pdf') {
        const kilobytes = Math.round((base64.length * 3) / 4 / 1024);
        // BOUNDED, for the same reason stated below about images: a model handed
        // base64 as "text" cannot read it and pays for the tokens anyway. That
        // reasoning was applied to screenshots and not to PDFs, which are the
        // LARGER of the two — a full-page PDF runs to megabytes, and base64 adds
        // a third again on top. Inlining one could exhaust a context window on a
        // single call, and bill the caller for the privilege.
        //
        // Small documents still come through whole, because some clients do
        // decode and save a text block, and truncating those would remove a
        // working capability for no gain.
        if (base64.length > MAX_INLINE_PDF_BASE64) {
          return {
            text: `[PDF document captured (${kilobytes} KB), too large to inline. `
              + 'The bytes are not readable as text by a model in any case; retrieve this '
              + 'capture through the REST API with responseType binary, or narrow the page '
              + 'with a selector.]',
            json: { metadata: data?.metadata },
            usage,
          };
        }
        return {
          text: `[PDF document captured (${kilobytes} KB). Base64 data below]\n${base64}`,
          json: { metadata: data?.metadata },
          usage,
        };
      }
      // Returned as an image content block, not base64 in a text field. A model
      // handed 400KB of base64 as "text" cannot see the picture and pays for
      // the tokens anyway.
      return {
        image: { data: base64, mimeType: `image/${args.format || 'png'}` },
        json: { metadata: data?.metadata },
        usage,
      };
    },
  },

  {
    name: 'domscout_extract_data',
    title: 'Extract structured data from a page',
    description:
      `Costs ${COSTS.base + 1} credits. Pulls named fields off a page using CSS selectors and returns `
      + 'typed JSON. Each field reports found/missing/invalid_selector separately, so a partial result '
      + 'tells you which selector was wrong rather than failing the whole call. Requires Pro or above.',
    inputSchema: {
      type: 'object',
      required: ['url', 'fields'],
      additionalProperties: false,
      properties: {
        url: URL_PROP,
        fields: {
          type: 'object',
          description:
            'Field name → { selector, type, attribute?, all? }. type is one of text, number, boolean, '
            + 'attribute, html, url, list. Set all:true to collect every match instead of the first. '
            + 'At most 100 fields.',
          // Bounded and closed to mirror the API's own validator (100 fields,
          // 128-char names, 256-char attributes, no unknown keys). A field map
          // the server will reject should fail here, before it costs a capture.
          // An empty map is accepted and billed by the API but extracts nothing.
          minProperties: 1,
          maxProperties: 100,
          propertyNames: { maxLength: 128 },
          additionalProperties: {
            type: 'object',
            required: ['selector', 'type'],
            additionalProperties: false,
            properties: {
              selector: { type: 'string', maxLength: 2000 },
              type: { type: 'string', enum: ['text', 'number', 'boolean', 'attribute', 'html', 'url', 'list'] },
              attribute: { type: 'string', maxLength: 256, description: 'Required when type is "attribute".' },
              all: { type: 'boolean', default: false },
              required: { type: 'boolean', default: false },
            },
          },
        },
        ...WAIT_PROPS,
      },
    },
    async run(client, args) {
      const { data, usage } = await client.capture({
        url: args.url,
        responseType: 'json',
        extract: { fields: args.fields },
        ...pick(args, ['waitForSelector', 'delay']),
      });
      if (data?.status === 'accepted') return { json: asyncNotice(data), usage };
      return { json: data?.analysis?.extraction || data, usage };
    },
  },

  {
    name: 'domscout_inspect_page',
    title: 'Get the interactive structure of a page',
    description:
      `Costs ${COSTS.base + 1} credits. Returns a semantic snapshot: the accessibility tree, the `
      + 'interactive elements, and a selector for each. Use this before domscout_automate_page to find '
      + 'out what is on the page and what to target. Requires Pro or above.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: URL_PROP,
        detail: { type: 'string', enum: ['summary', 'full'], default: 'summary', description: '"full" is slower and always returns asynchronously.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
        ...WAIT_PROPS,
      },
    },
    async run(client, args) {
      const { data, usage } = await client.capture({
        url: args.url,
        responseType: 'json',
        semanticSnapshot: {
          enabled: true,
          detail: args.detail || 'summary',
          maxNodes: args.maxNodes || 1000,
          selectorBundles: true,
        },
        ...pick(args, ['waitForSelector', 'delay']),
      });
      if (data?.status === 'accepted') return { json: asyncNotice(data), usage };
      return { json: data?.analysis?.semanticSnapshot || data?.interactiveNodes || data, usage };
    },
  },

  {
    name: 'domscout_automate_page',
    title: 'Click, type, and navigate on a page, then capture the result',
    description:
      `Costs ${COSTS.base} credit, +1 if more than 10 steps. Runs a sequence of actions — click, type, `
      + 'select, scroll, wait, navigate, pressKey, assert — and returns the final page plus a per-step '
      + 'pass/fail report. Call domscout_inspect_page first to find selectors. Requires Pro or above. '
      + 'The whole sequence shares a 24-second budget.',
    inputSchema: {
      type: 'object',
      required: ['url', 'actions'],
      additionalProperties: false,
      properties: {
        url: URL_PROP,
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 25,
          description: 'Up to 25 steps, run in order.',
          items: {
            type: 'object',
            required: ['action'],
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['click', 'type', 'scroll', 'wait', 'navigate', 'back', 'forward', 'reload',
                  'select', 'check', 'uncheck', 'hover', 'focus', 'pressKey', 'scrollIntoView',
                  'waitForText', 'waitForUrl', 'waitForNetworkIdle', 'assert'],
              },
              selector: { type: 'string', maxLength: 2000, description: 'CSS selector to act on.' },
              text: { type: 'string', maxLength: 2000, description: 'Text to type, or to wait for.' },
              value: { type: 'string', description: 'Value for select.' },
              key: { type: 'string', description: 'Key name for pressKey, e.g. "Enter".' },
              url: { type: 'string', description: 'Destination for navigate.' },
              amount: { type: 'number', minimum: -5000, maximum: 5000, description: 'Pixels for scroll.' },
              time: { type: 'integer', minimum: 0, maximum: 5000, description: 'Milliseconds for wait.' },
              expected: { type: 'string', description: 'For assert: exists, visible, checked, enabled, text:VALUE, equals:VALUE.' },
              continueOnError: { type: 'boolean', default: false },
            },
          },
        },
        screenshot: { type: 'boolean', default: true, description: 'Return an image of the final state.' },
        extractMarkdown: { type: 'boolean', default: false, description: 'Return the final page as Markdown.' },
      },
    },
    async run(client, args) {
      const { data, usage } = await client.capture({
        url: args.url,
        actions: args.actions,
        responseType: 'json',
        ...(args.extractMarkdown ? { extractMarkdown: true } : {}),
      });
      if (data?.status === 'accepted') return { json: asyncNotice(data), usage };
      const result = {
        actionResults: data?.actionResults,
        metadata: data?.metadata,
        ...(data?.markdown ? { markdown: data.markdown } : {}),
      };
      if (args.screenshot !== false && data?.screenshotBase64) {
        return { image: { data: data.screenshotBase64, mimeType: 'image/png' }, json: result, usage };
      }
      return { json: result, usage };
    },
  },

  {
    name: 'domscout_crawl_site',
    title: 'Crawl a set of pages under an allowlist',
    description:
      `Costs ${COSTS.base} credit per page crawled — submitting the crawl itself is free. Returns a job ID `
      + 'immediately — poll it with domscout_get_job. Always respects robots.txt (this cannot be '
      + 'disabled), caps at 500 pages and depth 5, and requires an explicit HTTPS allowedOrigins list. '
      + 'Requires a Business plan or above.',
    inputSchema: {
      type: 'object',
      required: ['seedUrl', 'allowedOrigins'],
      additionalProperties: false,
      properties: {
        seedUrl: { type: 'string', description: 'Where to start. Must be https.' },
        allowedOrigins: {
          type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' },
          description: 'Bare https origins the crawl may visit, e.g. "https://example.com". Must include the seed origin.',
        },
        maxDepth: { type: 'integer', minimum: 0, maximum: 5, default: 3 },
        maxPages: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        includePatterns: { type: 'array', maxItems: 100, items: { type: 'string' } },
        excludePatterns: { type: 'array', maxItems: 100, items: { type: 'string' } },
        extractMarkdown: { type: 'boolean', default: true, description: 'Capture each page as Markdown.' },
      },
    },
    async run(client, args) {
      const { data, usage } = await client.crawl({
        seedUrl: args.seedUrl,
        allowedOrigins: args.allowedOrigins,
        ...pick(args, ['maxDepth', 'maxPages', 'includePatterns', 'excludePatterns']),
        capture: { extractMarkdown: args.extractMarkdown !== false },
      });
      return { json: data, usage };
    },
  },

  {
    name: 'domscout_get_job',
    title: 'Check a durable job, batch, or crawl',
    description:
      `${COSTS.free} Poll a job ID returned by a crawl, a batch, or an auto-promoted capture. `
      + 'Status is one of pending, processing, retrying, done, error, cancel_requested, cancelled. '
      + 'Polling is free, so poll as often as you like — but the per-second rate limit still applies.',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      additionalProperties: false,
      properties: {
        jobId: { type: 'string', minLength: 1, description: 'The job ID.' },
        kind: { type: 'string', enum: ['job', 'batch', 'crawl'], default: 'job', description: 'Which endpoint to poll. Use "crawl" for a crawl job.' },
      },
    },
    async run(client, args) {
      const fn = args.kind === 'crawl' ? client.crawlStatus : args.kind === 'batch' ? client.batchStatus : client.job;
      const { data, usage } = await fn(args.jobId);
      return { json: data, usage };
    },
  },

  {
    name: 'domscout_cancel_job',
    title: 'Cancel a running job',
    description: `${COSTS.free} Cooperatively cancels a durable job, batch, or crawl. Work already in flight may still complete.`,
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      additionalProperties: false,
      // minLength, because this one builds a DELETE path.
      //
      // `required: ['jobId']` is satisfied by the empty string, and the empty
      // string concatenated into `/jobs/${jobId}` addresses the collection, not
      // a member. A cancel that names no job must be refused here rather than
      // sent.
      properties: { jobId: { type: 'string', minLength: 1 } },
    },
    async run(client, args) {
      const { data, usage } = await client.cancelJob(args.jobId);
      return { json: data, usage };
    },
  },

  {
    name: 'domscout_send_feedback',
    title: 'Tell the domscout team about a problem or a gap',
    description:
      `${COSTS.free} — and it will never be charged, by design. Use this whenever something about this `
      + 'API got in your way: an error you could not act on, a parameter that did not behave as '
      + 'documented, a capability you needed and could not find, or a result that was wrong. Include '
      + 'the requestId from a failed call and the team sees exactly what happened on their side. '
      + 'A human reads these. Do not include API keys or other secrets.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      additionalProperties: false,
      properties: {
        message: { type: 'string', maxLength: 8000, description: 'What happened, or what would have helped.' },
        type: {
          type: 'string',
          enum: ['bug', 'error_report', 'docs_gap', 'feature_request', 'praise', 'other'],
          default: 'other',
        },
        severity: { type: 'string', enum: ['blocking', 'major', 'minor', 'info'], default: 'info' },
        requestId: { type: 'string', description: 'The requestId from the call this is about, if there was one.' },
        endpoint: { type: 'string', description: 'Which tool or endpoint, e.g. "domscout_extract_data".' },
        expected: { type: 'string', maxLength: 2000 },
        actual: { type: 'string', maxLength: 2000 },
      },
    },
    async run(client, args) {
      const body = pick(args, ['message', 'type', 'severity', 'requestId', 'endpoint', 'expected', 'actual']);
      // The three free-text fields only. `requestId` and `endpoint` are
      // identifiers the team needs intact, and the other two are enums.
      for (const field of ['message', 'expected', 'actual']) {
        if (body[field] !== undefined) body[field] = scrubCredentials(body[field]);
      }
      const { data, usage } = await client.feedback({
        ...body,
        agent: { framework: 'mcp', client: '@domscout/mcp' },
      });
      return { json: data, usage };
    },
  },
];

/**
 * Every prefix a live domscout key may carry.
 *
 * `ws_` is still live and must stay: keys issued under the previous product
 * name were never reissued. The list is duplicated from the service's own
 * declaration rather than imported, because this package is ESM and
 * deliberately dependency-free; a contract test compares the two, so a third
 * prefix cannot be added on one side and forgotten here.
 */
const KEY_PREFIXES = ['ds', 'ws'];

/**
 * Strip credentials out of text a human is going to read.
 *
 * `domscout_send_feedback` forwards `message`, `expected` and `actual`
 * verbatim to a queue the team reads by hand, and its own description ends
 * "Do not include API keys or other secrets" — an instruction aimed at a model,
 * with nothing behind it. The single most likely thing to be reported through
 * this tool is an authentication failure, and the most natural way for a model
 * to describe one is to quote the request it sent.
 *
 * Redacted HERE rather than server-side, because the goal is that the secret
 * never leaves the machine holding it. A scrubber at the other end has already
 * received it.
 *
 * Deliberately narrow: key-shaped literals, Bearer values, and the header names
 * this API authenticates with. Anything broader starts eating the URLs and
 * selectors that make a bug report worth reading.
 */
const CREDENTIAL_PATTERNS = [
  new RegExp(String.raw`\b(?:${KEY_PREFIXES.join('|')})_[A-Za-z0-9_-]{20,}`, 'g'),
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(x-api-key|x-domscout-actor|authorization)\s*[:=]\s*\S+/gi,
];

export function scrubCredentials(value) {
  if (typeof value !== 'string') return value;
  return CREDENTIAL_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, (match) => {
      // The header NAME survives and only its value is replaced, so the report
      // still says which header was wrong, which is the useful half.
      const named = /^([\w-]+)\s*([:=])/.exec(match);
      return named ? `${named[1]}${named[2]} [redacted]` : '[redacted]';
    }),
    value,
  );
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * A 202 means the work outgrew the synchronous budget and became a job. Say so
 * in a sentence the model can act on rather than returning a bare payload whose
 * `jobId` field it has to infer the meaning of.
 */
function asyncNotice(data) {
  return {
    status: 'accepted',
    jobId: data.jobId,
    note: 'This request was too large to answer synchronously and became a durable job. '
      + 'Poll it with domscout_get_job (free) until status is "done".',
    ...(data.estimatedMs ? { estimatedMs: data.estimatedMs } : {}),
  };
}

/**
 * Turn a tool result into MCP content blocks.
 *
 * The usage footer is appended to every successful call. A model that cannot
 * see what it just spent cannot pace itself across a long run.
 */
export function toContent(result) {
  const blocks = [];
  if (result.text) blocks.push({ type: 'text', text: result.text });
  if (result.image) blocks.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
  if (result.json !== undefined && result.json !== null) {
    blocks.push({ type: 'text', text: JSON.stringify(result.json, null, 2) });
  }
  if (result.usage && Number.isFinite(result.usage.creditCost)) {
    const { creditCost, creditsRemaining, quotaRemaining } = result.usage;
    blocks.push({
      type: 'text',
      text: `[domscout: cost ${creditCost} credit(s); ${quotaRemaining ?? '?'} quota and ${creditsRemaining ?? '?'} credits remaining]`,
    });
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '(no content)' }];
}

/**
 * Turn a failure into something a model can act on.
 *
 * The stable `code` and the API's own `suggestions` are surfaced verbatim, and
 * the retriable flag is stated in words. The alternative — a bare "Error: 403"
 * — reliably produces a model that retries a plan gate until its budget is
 * gone, which is a worse outcome than the original failure.
 */
export function toErrorContent(error) {
  if (!(error instanceof DomscoutError)) {
    return [{ type: 'text', text: `domscout tool failed: ${error.message}` }];
  }
  const lines = [`domscout error${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`];
  if (error.code) lines.push(`code: ${error.code}`);
  if (error.requestId) lines.push(`requestId: ${error.requestId}`);

  if (error.code === 'BROWSER_ISOLATION_REQUIRED') {
    lines.push(
      'This is a deliberate production safety hold on browser execution. No API key, plan, or retry '
      + 'clears it. Do not retry. Non-browser tools (check_credits, get_job, send_feedback) still work.',
    );
  } else if (error.status === 403) {
    lines.push('Not retriable. This is an authentication, plan, or entitlement refusal — the same call will fail again.');
  } else if (error.status === 429 && !error.retriable) {
    lines.push('Out of quota and credits. Retrying will not help; the account needs credits or a higher plan.');
  } else if (error.retriable) {
    lines.push('Retriable. Wait a moment and try once more.');
  } else {
    lines.push('Not retriable without changing the request.');
  }

  if (error.suggestions.length > 0) {
    lines.push('Suggestions from the API:', ...error.suggestions.map((s) => `  - ${s}`));
  }
  return [{ type: 'text', text: lines.join('\n') }];
}
