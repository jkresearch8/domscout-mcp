/** Exercise SDK imports, handshake and handlers through an assembled stdio server.
 * A loopback API verifies routing without contacting the production service.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'index.js');
/** The one place the expected handshake version comes from. See the assertion. */
const PACKAGE_VERSION = JSON.parse(
  readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'),
).version;

/** Every tool the server is expected to expose. A silent drop is a regression. */
const EXPECTED_TOOLS = [
  'domscout_check_credits',
  'domscout_extract_markdown',
  'domscout_capture_screenshot',
  'domscout_extract_data',
  'domscout_inspect_page',
  'domscout_automate_page',
  'domscout_crawl_site',
  'domscout_get_job',
  'domscout_cancel_job',
  'domscout_send_feedback',
];

/** A 1x1 PNG, so the screenshot path returns a real image block. */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A stub domscout API on 127.0.0.1.
 *
 * Loopback keeps protocol tests isolated from the production service.
 */
async function startStubApi(handler) {
  const server = http.createServer((req, res) => {
    // Drain the request before answering; several tools POST a body.
    //
    // BUFFERED, not discarded. "Which route did the tool call, and with what
    // body" is what several of these tests exist to assert, and a handler
    // cannot re-read a stream this function has already consumed — it would
    // register a 'data' listener after the last chunk had already been
    // delivered and then wait for an 'end' that has already fired, which is a
    // 45-second timeout rather than a failed assertion.
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => handler(req, res, body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** JSON plus the request id the client reads off every response. */
function respondJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-request-id': 'req_stub',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

/**
 * Spawn the server, complete the handshake, run `fn`, and always tear down.
 *
 * stderr is ignored rather than piped: the server writes a ready line there,
 * and an unread pipe that filled would block the child instead of failing a
 * test.
 */
async function withServer(apiHandler, fn) {
  const api = await startStubApi(apiHandler);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      DOMSCOUT_API_KEY: 'ds_stub_key_not_a_real_credential',
      DOMSCOUT_BASE_URL: api.url,
      DOMSCOUT_DOCS_BASE_URL: api.url,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'boot-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client, api);
  } finally {
    try { await client.close(); } catch { /* teardown must not mask a real failure */ }
    await api.close();
  }
}

/** The default stub: enough for any tool to return something shaped correctly. */
function defaultApi(req, res) {
  const budget = {
    'x-domscout-credits-cost': '1',
    'x-domscout-credits-remaining': '412',
    'x-domscout-quota-remaining': '900',
  };
  if (req.url.startsWith('/credits')) {
    return respondJson(res, 200, { credits: 412, plan: 'pro' }, { ...budget, 'x-domscout-credits-cost': '0' });
  }
  if (req.url === '/llms-full.txt' || req.url === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('STUB DOCS BODY');
  }
  return respondJson(res, 200, {
    markdown: '# Stub page',
    screenshotBase64: PNG_1PX,
    metadata: { url: 'https://example.com' },
  }, budget);
}

test('the server completes a real MCP initialize handshake', async () => {
  await withServer(defaultApi, async (client) => {
    // Derive the expected version so releases need no separate test edit.
    assert.deepEqual(client.getServerVersion(), { name: 'domscout', version: PACKAGE_VERSION });

    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities.tools, 'the server must advertise tools');
    assert.ok(capabilities.resources, 'the server must advertise resources');
  });
});

test('tools/list returns every tool, and each one survives protocol validation', async () => {
  await withServer(defaultApi, async (client) => {
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...EXPECTED_TOOLS].sort(),
      'a tool was added or dropped without this list being updated',
    );

    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} lost its title`);
      assert.ok(tool.description?.length > 40, `${tool.name} needs a description a model can act on`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} must take an object`);
      // The credit cost is stated in the description on purpose: a model
      // choosing between tools cannot see the price list unless it is there.
      assert.match(tool.description, /free|credit/i, `${tool.name} must say what it costs`);
    }
  });
});

test('resources are listed and can be read through the protocol', async () => {
  await withServer(defaultApi, async (client) => {
    const { resources } = await client.listResources();
    assert.deepEqual(
      resources.map((resource) => resource.uri).sort(),
      ['domscout://docs', 'domscout://openapi'],
    );

    const doc = await client.readResource({ uri: 'domscout://docs' });
    assert.equal(doc.contents[0].uri, 'domscout://docs');
    assert.equal(doc.contents[0].text, 'STUB DOCS BODY');
  });
});

test('a successful call returns content and tells the model what it spent', async () => {
  await withServer(defaultApi, async (client) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com' },
    });

    assert.ok(!result.isError, 'a 200 must not be reported as a tool error');
    const text = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /# Stub page/);
    assert.match(text, /\[domscout: cost 1 credit\(s\); 900 quota and 412 credits remaining\]/);
  });
});

test('a screenshot crosses the transport as an image block, not base64 text', async () => {
  await withServer(defaultApi, async (client) => {
    const result = await client.callTool({
      name: 'domscout_capture_screenshot',
      arguments: { url: 'https://example.com', format: 'png' },
    });

    const image = result.content.find((block) => block.type === 'image');
    assert.ok(image, 'the screenshot must arrive as an image content block');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.data, PNG_1PX);
  });
});

test('the API key travels in a header and never reaches the query string', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ url: req.url, key: req.headers['x-api-key'] });
    defaultApi(req, res);
  }, async (client) => {
    await client.callTool({ name: 'domscout_extract_markdown', arguments: { url: 'https://example.com' } });
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, 'ds_stub_key_not_a_real_credential');
  assert.doesNotMatch(seen[0].url, /ds_stub_key/, 'the key must never appear in a URL, which gets logged');
});

test('an API refusal reaches the model as a tool error carrying the retry verdict', async () => {
  // 403: not retriable, ever. A model told otherwise burns its whole budget
  // against a plan gate. This is the single most valuable thing the client
  // does, so it is asserted end-to-end and not only at the unit level.
  await withServer((req, res) => {
    respondJson(res, 403, {
      error: 'Browser isolation hold is active',
      code: 'PRODUCTION_HOLD',
      suggestions: ['Contact support'],
    });
  }, async (client) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com' },
    });

    assert.ok(result.isError, 'a refusal must be a tool error, not a thrown transport failure');
    const text = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /HTTP 403/);
    assert.match(text, /code: PRODUCTION_HOLD/);
    assert.match(text, /Not retriable/);
    assert.match(text, /Contact support/);
  });
});

test('a 429 with no budget headers is retriable rather than read as an empty balance', async () => {
  // Gateway throttles omit budget headers; absent values do not mean zero.
  await withServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Too Many Requests' }));
  }, async (client) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com' },
    });

    assert.ok(result.isError);
    const text = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /Retriable/);
    assert.doesNotMatch(text, /Out of quota and credits/);
  });
});

test('an unknown tool is an error result, not a dropped connection', async () => {
  await withServer(defaultApi, async (client) => {
    const result = await client.callTool({ name: 'domscout_no_such_tool', arguments: {} });
    assert.ok(result.isError);
    assert.match(result.content[0].text, /Unknown tool: domscout_no_such_tool/);
  });
});

test('an unknown resource is rejected as a protocol error', async () => {
  await withServer(defaultApi, async (client) => {
    await assert.rejects(
      () => client.readResource({ uri: 'domscout://not-a-resource' }),
      /Unknown resource/,
    );
  });
});

// The reading tool talks to POST /scrape.

/** Record the route and body independently of the response returned by the stub. */
function scrapeApi(seen) {
  return (req, res, body) => {
    const parsed = body ? JSON.parse(body) : null;
    seen.push({ url: req.url, method: req.method, body: parsed });
    respondJson(res, 200, {
      status: 'success',
      url: 'https://example.com/docs',
      title: 'Stub Document',
      markdown: '# Stub Document\n\nBody text.',
      links: [{ href: 'https://example.com/a', text: 'A' }],
      metadata: {
        statusCode: 200,
        renderJs: parsed?.renderJs !== false,
        estimatedTokens: 9,
      },
    }, {
      'x-domscout-credits-cost': '1',
      'x-domscout-credits-remaining': '412',
      'x-domscout-quota-remaining': '900',
    });
  };
}

test('the reading tool calls POST /scrape, not POST /screenshot', async () => {
  const seen = [];
  await withServer(scrapeApi(seen), async (client) => {
    await client.callTool({ name: 'domscout_extract_markdown', arguments: { url: 'https://example.com/docs' } });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/scrape');
  assert.equal(seen[0].method, 'POST');
  // The route supplies extractMarkdown and responseType itself; sending them
  // again from here would be a second place for those defaults to drift.
  assert.deepEqual(seen[0].body, { url: 'https://example.com/docs' });
});

test('fast:true reaches the API as renderJs:false', async () => {
  const seen = [];
  await withServer(scrapeApi(seen), async (client) => {
    await client.callTool({ name: 'domscout_extract_markdown', arguments: { url: 'https://example.com/docs', fast: true } });
  });
  assert.equal(seen[0].url, '/scrape');
  assert.equal(seen[0].body.renderJs, false);
  // `fast` is the MCP spelling; it must not also travel as a second field.
  assert.equal('fast' in seen[0].body, false);
});

test('the document crosses as text and the metadata as JSON', async () => {
  // A model reads the document and inspects the metadata only when the document
  // looks wrong. Burying the prose inside a JSON blob costs tokens and reads
  // worse in the common case.
  await withServer(scrapeApi([]), async (client) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com/docs' },
    });
    const [document, meta] = result.content;
    assert.equal(document.type, 'text');
    assert.equal(document.text, '# Stub Document\n\nBody text.');

    const parsed = JSON.parse(meta.text);
    assert.equal(parsed.title, 'Stub Document');
    assert.equal(parsed.url, 'https://example.com/docs');
    assert.equal(parsed.meta.renderJs, true);
    assert.equal(parsed.meta.statusCode, 200);
    assert.deepEqual(parsed.links, [{ href: 'https://example.com/a', text: 'A' }]);
  });
});

test('a browser-only option combined with fast:true is refused before it costs a credit', async () => {
  // The API would answer with a document that silently ignored the option, and
  // the caller would pay a credit to discover that. Naming the conflict here
  // costs nothing.
  const seen = [];
  for (const conflicting of [{ waitForSelector: '#main' }, { delay: 500 }, { lazyScroll: true }]) {
    await withServer(scrapeApi(seen), async (client) => {
      const result = await client.callTool({
        name: 'domscout_extract_markdown',
        arguments: { url: 'https://example.com/docs', fast: true, ...conflicting },
      });
      assert.equal(result.isError, true, `${Object.keys(conflicting)[0]} must not be silently dropped`);
      assert.match(result.content[0].text, /fast:true skips the browser/);
      assert.match(result.content[0].text, new RegExp(Object.keys(conflicting)[0]));
    });
  }
  assert.equal(seen.length, 0, 'a refused call must never reach the API');
});

test('the browser path still accepts the options that need a live page', async () => {
  // The guard above must not have closed the door on the ordinary request.
  const seen = [];
  await withServer(scrapeApi(seen), async (client) => {
    await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com/docs', waitForSelector: '#main', delay: 250, lazyScroll: true },
    });
  });
  assert.equal(seen[0].url, '/scrape');
  assert.equal(seen[0].body.waitForSelector, '#main');
  assert.equal(seen[0].body.delay, 250);
  assert.equal(seen[0].body.lazyScroll, true);
  assert.equal('renderJs' in seen[0].body, false, 'the browser path must not send renderJs at all');
});

test('an empty document still returns a usable answer rather than an empty block', async () => {
  await withServer((req, res) => {
    respondJson(res, 200, {
      status: 'success',
      url: 'https://example.com/spa',
      title: '',
      markdown: '',
      links: [],
      metadata: { statusCode: 200, renderJs: false, contentQuality: 'empty', advice: 'Retry with renderJs:true.' },
    }, { 'x-domscout-credits-cost': '1' });
  }, async (client) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com/spa', fast: true },
    });
    assert.match(result.content[0].text, /no readable content/);
    // The advice is what turns a dead end into a next step, so it must survive.
    const parsed = JSON.parse(result.content[1].text);
    assert.equal(parsed.meta.contentQuality, 'empty');
    assert.match(parsed.meta.advice, /renderJs:true/);
  });
});

test('booting without an API key still serves tools/list, and fails on the call', async () => {
  // Clients can discover tools before an API key is configured.
  const env = { ...process.env };
  delete env.DOMSCOUT_API_KEY;

  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'domscout_check_credits', arguments: {} },
  });

  const replies = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; stdout so far: ${stdout}`)), 15_000);
    child.stdout.on('data', () => {
      const parsed = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      if (parsed.some((m) => m.id === 3)) {
        clearTimeout(timer);
        resolve(parsed);
      }
    });
  });
  child.kill();

  const listed = replies.find((m) => m.id === 2);
  assert.ok(listed.result.tools.length > 0, 'tools must be enumerable without a credential');

  const called = replies.find((m) => m.id === 3);
  assert.ok(called.result.isError, 'calling a tool without a key must be an error result');
  const text = called.result.content.map((c) => c.text).join(' ');
  assert.match(text, /DOMSCOUT_API_KEY is not set/);
  assert.match(text, /dashboard\/api-keys/, 'the message must say where to get a key');

  // stdout IS the JSON-RPC channel, so the diagnostic belongs on stderr and
  // every stdout line must parse as a message.
  assert.match(stderr, /DOMSCOUT_API_KEY is not set/);
  for (const line of stdout.split('\n').filter(Boolean)) JSON.parse(line);
});
