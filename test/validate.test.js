/** Verify that invalid tool arguments are refused through the MCP protocol
 * before any request reaches the API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { TOOLS } from '../src/tools.js';
import { assertKnownKeywords, assertValidToolArguments } from '../src/validate.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

/**
 * An API stub that FAILS the test if it is ever called.
 *
 * That is the assertion, not scaffolding: a refusal is only worth anything if
 * it happens before the request costs a credit.
 */
async function withRefusingApi(fn) {
  let reached = 0;
  const server = http.createServer((req, res) => {
    reached += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ markdown: 'stub' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      DOMSCOUT_API_KEY: 'ds_stub_key_not_a_real_credential',
      DOMSCOUT_BASE_URL: url,
      DOMSCOUT_DOCS_BASE_URL: url,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'validate-test', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client, () => reached);
  } finally {
    try { await client.close(); } catch { /* teardown must not mask a real failure */ }
    await new Promise((resolve) => server.close(resolve));
  }
}

test('an out-of-range argument is refused before it reaches the API', async () => {
  await withRefusingApi(async (client, apiCalls) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com', delay: -5000 },
    });

    assert.ok(result.isError, 'a bad argument must come back as a tool error the model can act on');
    const text = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /delay/, 'the message has to name the parameter, or the model cannot fix it');
    assert.match(text, /minimum of 0/, 'and the bound it broke');
    assert.equal(apiCalls(), 0, 'the whole point is refusing on the near side of the wire, for free');
  });
});

test('an invented enum member is refused, naming the members that exist', async () => {
  await withRefusingApi(async (client, apiCalls) => {
    const result = await client.callTool({
      name: 'domscout_capture_screenshot',
      arguments: { url: 'https://example.com', devicePreset: 'iphone99' },
    });

    assert.ok(result.isError);
    const text = result.content.map((block) => block.text ?? '').join('\n');
    assert.match(text, /desktop, iphone13, pixel7, ipad/);
    assert.equal(apiCalls(), 0);
  });
});

test('a missing required argument is refused rather than sent as undefined', async () => {
  await withRefusingApi(async (client, apiCalls) => {
    const result = await client.callTool({ name: 'domscout_extract_markdown', arguments: {} });

    assert.ok(result.isError);
    assert.match(result.content.map((block) => block.text ?? '').join('\n'), /url is required/);
    assert.equal(apiCalls(), 0);
  });
});

test('a valid call reaches the API', async () => {
  await withRefusingApi(async (client, apiCalls) => {
    const result = await client.callTool({
      name: 'domscout_extract_markdown',
      arguments: { url: 'https://example.com', delay: 500, lazyScroll: true },
    });

    assert.ok(!result.isError, 'a well-formed call must still go through');
    assert.equal(apiCalls(), 1);
  });
});

test('every declared schema is one the validator can actually enforce', () => {
  // Unsupported constraints must fail before tools are advertised.
  for (const tool of TOOLS) {
    assert.doesNotThrow(() => assertKnownKeywords(tool.inputSchema, `${tool.name}.inputSchema`));
  }
});

test('an unimplemented keyword is a loud failure, not a silent pass', () => {
  assert.throws(
    () => assertKnownKeywords({ type: 'string', pattern: '^x$' }),
    /pattern is not a keyword/,
  );
});

test('the field map is bounded by the same rules the API applies', () => {
  const extract = TOOLS.find((tool) => tool.name === 'domscout_extract_data');
  const fields = Object.fromEntries(
    Array.from({ length: 101 }, (_, i) => [`f${i}`, { selector: '.x', type: 'text' }]),
  );
  assert.throws(
    () => assertValidToolArguments(extract.name, extract.inputSchema, { url: 'https://example.com', fields }),
    /maximum is 100/,
    'a field map the server will reject should fail here, before it costs a capture',
  );
});

test('a prototype property name cannot smuggle an unknown argument past the schema', () => {
  // Inherited members must not bypass additionalProperties or value checks.
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: { url: { type: 'string' } },
  };

  for (const smuggled of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assert.throws(
      () => assertValidToolArguments('t', schema, { url: 'https://example.com', [smuggled]: 'anything' }),
      /is not a parameter of this tool/,
      `${smuggled} is not a declared property and must be refused like any other unknown key`,
    );
  }

  // The declared property still validates normally in both directions.
  assert.doesNotThrow(() => assertValidToolArguments('t', schema, { url: 'https://example.com' }));
  assert.throws(() => assertValidToolArguments('t', schema, { url: 42 }), /must be string/);
});

test('the API key is never sent over an unencrypted connection', async () => {
  // Remote API keys require HTTPS; local development may use loopback HTTP.
  const { createClient } = await import('../src/client.js');
  const opts = (baseUrl) => ({ apiKey: 'ds_test', baseUrl, fetchImpl: async () => new Response('{}') });

  for (const bad of ['http://api.example.com', 'http://10.0.0.5:8080', 'http://evil.test/x']) {
    assert.throws(() => createClient(opts(bad)), /unencrypted|Refusing/i, `${bad} must be refused`);
  }

  // Loopback is how the API is developed against locally; the key never leaves
  // the machine, so it stays allowed.
  for (const ok of ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://api.domscout.io']) {
    assert.doesNotThrow(() => createClient(opts(ok)), `${ok} must be allowed`);
  }

  assert.throws(() => createClient(opts('not a url')), /not a valid URL/);
});
