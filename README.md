# @domscout/mcp

> Last reviewed: September 18, 2026.

Use domscout as MCP tools to read pages as Markdown, capture screenshots,
extract structured data, inspect interactive structure, automate browser flows,
and crawl allowlisted sites.

## Setup

1. Create an API key in <https://www.domscout.io/dashboard/api-keys>.
2. Configure your MCP client:

```json
{
  "mcpServers": {
    "domscout": {
      "command": "npx",
      "args": ["-y", "@domscout/mcp"],
      "env": {
        "DOMSCOUT_API_KEY": "ds_your_key_here"
      }
    }
  }
}
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `DOMSCOUT_API_KEY` | Yes | Your API key. |
| `DOMSCOUT_BASE_URL` | No | Overrides the current production gateway for an intentionally separate deployment. |
| `DOMSCOUT_DOCS_BASE_URL` | No | Where the contract resources (`/llms-full.txt`, `/openapi.json`) are fetched from. Separate from `DOMSCOUT_BASE_URL` because the docs are served by the marketing site, not the API gateway — that host has no `/llms-full.txt`. Defaults to `https://www.domscout.io`. |

The default targets `https://api.domscout.io`. API requests do not follow
redirects, so the key is never re-sent to another URL: a `DOMSCOUT_BASE_URL`
that answers with a redirect fails with an error naming the status. Point it at
the final URL instead.
Verify the key in the dashboard before connecting a client; never commit or
paste the key into prompts.

## Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `domscout_check_credits` | free | Balance, quota, rate limit, and price list |
| `domscout_extract_markdown` | 1 | Read a page as clean Markdown (`fast:true` skips the browser) |
| `domscout_capture_screenshot` | 1–3 | Capture PNG/JPEG/WebP/PDF |
| `domscout_extract_data` | 2 | Extract named fields as typed JSON |
| `domscout_inspect_page` | 2 | Read the accessibility tree and interactive elements |
| `domscout_automate_page` | 1–2 | Run allowed actions and capture the result |
| `domscout_crawl_site` | 1/page | Run a bounded, allowlisted, robots-respecting crawl |
| `domscout_get_job` | free | Poll a durable job, batch, or crawl |
| `domscout_cancel_job` | free | Cancel one durable job |
| `domscout_send_feedback` | free | Send product feedback |

A request never costs more than 10 credits. Tool results include the request
cost and remaining balance.

## Resources

| URI | Contents |
| --- | --- |
| `domscout://docs` | API reference |
| `domscout://openapi` | OpenAPI 3.1 contract |

## Security

The MCP server sends an `x-api-key` to the configured API host and reads the
response. It has no browser, database, or billing credential. Keep the key in
the MCP client environment block; do not commit it or paste it into prompts.


## Requirements

Node.js 20 or newer. `npx -y @domscout/mcp` downloads and runs it; there is
nothing to install or build.

## Links

- [Documentation](https://www.domscout.io/docs/mcp)
- [API reference](https://www.domscout.io/docs)
- [Issues](https://github.com/jkresearch8/domscout-mcp/issues)

This repository mirrors the published package. Releases are cut from a
separate development repository, so please open an issue rather than a pull
request.

## License

MIT. See [LICENSE](LICENSE).
