#!/usr/bin/env node
/** Local MCP server over stdio; configuration comes from the client environment. */

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

// Reject unsupported schema keywords before advertising tools to a client.
for (const tool of TOOLS) assertKnownKeywords(tool.inputSchema, `${tool.name}.inputSchema`);

// Documentation has its own host; the API gateway serves no contract resources.
const DOCS_BASE_URL = (process.env.DOMSCOUT_DOCS_BASE_URL || 'https://www.domscout.io').replace(/\/+$/, '');
const DOCS_URL = `${DOCS_BASE_URL}/llms-full.txt`;
/** The handshake must report the version of the installed package. */
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
  // Listing tools needs no credential; configuration errors belong on tool calls.
  let client = null;
  let clientError = null;
  try {
    client = createClient();
  } catch (error) {
    clientError = error;
    // stderr, never stdout: stdout is the JSON-RPC channel and any stray byte
    // on it corrupts the session for the client.
    process.stderr.write(`${error.message}\n`);
  }

  const server = new Server(
    { name: 'domscout', version: MCP_SERVER_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );


  // stdout carries JSON-RPC, so transport and process diagnostics go to stderr.
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
      // The startup failure, surfaced where it can be read and acted on.
      if (clientError) throw clientError;
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
    // Unknown resources are invalid parameters, so clients can correct the URI.
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
    // The fetch deadline also covers reading the response body.
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

  // The SDK does not detect stdin closure; hosts may disconnect without a signal.
  process.stdin.on('close', cleanup);
  process.stdin.on('end', cleanup);
}

main();
