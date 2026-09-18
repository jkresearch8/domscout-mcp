#!/usr/bin/env node
/**
 * domscout as an MCP server, over stdio.
 *
 * ── WHY STDIO AND NOT A HOSTED ENDPOINT ─────────────────────────────────────
 *
 * A hosted MCP endpoint needs OAuth, session handling, and a new always-on
 * service to secure and monitor. stdio needs a config block and an environment
 * variable, works today in every MCP client, and adds no attack surface we have
 * to operate — the process runs on the user's machine and holds only their own
 * API key. The tool layer here is transport-agnostic, so a remote variant later
 * is a second entry point rather than a rewrite.
 *
 *   {
 *     "mcpServers": {
 *       "domscout": {
 *         "command": "npx",
 *         "args": ["-y", "@domscout/mcp"],
 *         "env": { "DOMSCOUT_API_KEY": "ds_..." }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { readFileSync } from 'node:fs';
import { createClient, DEFAULT_BASE_URL } from './client.js';
import { TOOLS, toContent, toErrorContent } from './tools.js';
import { assertKnownKeywords, assertValidToolArguments } from './validate.js';

// At load, not per call: every declared schema must be one the validator can
// actually enforce. A schema keyword nothing implements is a promise made to
// the model in the tool listing and kept by nobody, which is the failure
// validate.js exists to end — so it is a startup crash rather than a silent
// gap. Runs before the transport is up, so the operator sees it on stderr.
for (const tool of TOOLS) assertKnownKeywords(tool.inputSchema, `${tool.name}.inputSchema`);

/**
 * The docs are served by the marketing site, not by the API gateway, so these
 * cannot be derived from DOMSCOUT_BASE_URL — that host has no /llms-full.txt.
 * They get their own override instead, so someone pointed at a staging
 * deployment reads that deployment's contract rather than production's.
 */
const DOCS_BASE_URL = (process.env.DOMSCOUT_DOCS_BASE_URL || 'https://www.domscout.io').replace(/\/+$/, '');
const DOCS_URL = `${DOCS_BASE_URL}/llms-full.txt`;
/**
 * Read from package.json rather than restated here.
 * This was the literal '1.0.0' while package.json said 1.0.2, so every MCP
 * client was told a version the package had not been for two releases — and a
 * handshake version is exactly what a client uses to reason about capability.
 */
const MCP_SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const SPEC_URL = `${DOCS_BASE_URL}/openapi.json`;

const RESOURCES = [
  {
    uri: 'domscout://docs',
    name: 'domscout API reference',
    description:
      'Every endpoint and parameter in one file, including the credit price list and the stable '
      + 'error codes. Read this when a tool is not enough and you need the raw HTTP contract.',
    mimeType: 'text/markdown',
    fetchFrom: DOCS_URL,
  },
  {
    uri: 'domscout://openapi',
    name: 'domscout OpenAPI 3.1 specification',
    description: 'The canonical machine-readable wire contract.',
    mimeType: 'application/json',
    fetchFrom: SPEC_URL,
  },
];

function main() {
  let client;
  try {
    client = createClient();
  } catch (error) {
    // Written to stderr, not stdout: stdout is the JSON-RPC channel and any
    // stray byte on it corrupts the session for the client.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: 'domscout', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );


  // ── FAILURES THAT ARRIVE OUTSIDE A REQUEST ────────────────────────────────
  //
  // Everything above is per-request and already returns `isError` rather than
  // throwing. These two cover what happens BESIDE a request:
  //
  //   `server.onerror` is the SDK's transport-level channel — a malformed frame,
  //   a protocol violation. Unset, the SDK's default writes nothing, so the one
  //   failure class a user cannot see in a tool result was also the one nothing
  //   recorded.
  //
  //   `unhandledRejection` is the process-level one, and it MATTERS HERE more
  //   than in most programs: Node terminates on an unhandled rejection, and
  //   terminating a stdio server does not surface an error to the client — the
  //   pipe simply closes, and the session ends looking like the user's editor
  //   disconnected it. A stray rejection anywhere in the SDK or in a tool's
  //   cleanup path could end a working session with no explanation.
  //
  // STDERR, never stdout. stdout is the JSON-RPC channel and one stray byte on
  // it corrupts the session, which is the same reason the startup failure above
  // writes to stderr.
  server.onerror = (error) => {
    process.stderr.write(`[domscout mcp] transport error: ${error?.stack || error?.message || error}\n`);
  };

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[domscout mcp] unhandled rejection: ${reason?.stack || reason}\n`);
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema }) => ({
      name, title, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
    }
    try {
      // Against the tool's OWN declared schema, before the call costs anything.
      // Inside the try: an argument the model got wrong is a result it should
      // see and can act on, exactly like an upstream 400, not a transport fault.
      assertValidToolArguments(tool.name, tool.inputSchema, request.params.arguments || {});
      const result = await tool.run(client, request.params.arguments || {});
      return { content: toContent(result) };
    } catch (error) {
      // isError rather than a thrown exception: the model should see what went
      // wrong and whether it is worth another try, not a transport failure.
      return { isError: true, content: toErrorContent(error) };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = RESOURCES.find((candidate) => candidate.uri === request.params.uri);
    // McpError with InvalidParams (-32602), not a bare Error.
    //
    // A bare throw reaches the client as -32603 Internal error, which tells a
    // caller the SERVER broke. It did not: the client asked for a URI that
    // does not exist, which is the textbook definition of an invalid
    // parameter. The distinction is the one a client uses to decide between
    // retrying and correcting, so reporting it wrong invites the retry.
    if (!resource) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
    }
    let response;
    try {
      response = await fetch(resource.fetchFrom, { signal: AbortSignal.timeout(15_000) });
    } catch (networkError) {
      throw new Error(`Could not fetch ${resource.fetchFrom}: ${networkError.message}`);
    }
    if (!response.ok) throw new Error(`Could not fetch ${resource.fetchFrom}: HTTP ${response.status}`);
    // Read inside a try for the same reason the API client does: the 15s
    // AbortSignal covers body reading, so a reset or trickled body throws here
    // and not from the fetch above. Uncaught, it surfaced as a bare
    // "terminated"/"aborted" with no indication of WHICH resource failed.
    let text;
    try {
      text = await response.text();
    } catch (bodyError) {
      throw new Error(`Could not fetch ${resource.fetchFrom}: ${bodyError.message}`);
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text }],
    };
  });

  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    process.stderr.write(`domscout MCP server ready (${process.env.DOMSCOUT_BASE_URL || DEFAULT_BASE_URL})\n`);
  }).catch((error) => {
    // Without this the only symptom of a transport that never came up is an
    // unhandled rejection: no diagnostic, and a client waiting forever for a
    // handshake that is never going to arrive.
    process.stderr.write(`domscout MCP server could not start: ${error.message}\n`);
    process.exit(1);
  });

  const cleanup = async () => {
    try { await server.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // STDIN CLOSING IS HOW AN MCP HOST DISCONNECTS, and it is not a signal.
  //
  // The SDK's StdioServerTransport subscribes to 'data' and 'error' on stdin
  // and to nothing else, so when the host goes away and the pipe closes, the
  // transport does not notice and this process keeps running. SIGINT/SIGTERM
  // above only cover a host that bothers to send one — on Windows a parent that
  // simply closes the pipe sends neither, which is one orphaned node process
  // per disconnect, holding its API key in memory.
  //
  // 'close' and 'end' both, because which one arrives depends on whether the
  // stream was ever read from.
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);
}

main();
