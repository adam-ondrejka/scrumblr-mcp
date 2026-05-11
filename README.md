# scrumblr-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for a [scrumblr](https://github.com/lspevak/scrumblr) board. Gives your editor's AI a way to query what's on the board: cards, rows, story clusters.

## Tools

| Tool | What it does | Input |
| --- | --- | --- |
| `get_board` | Full board snapshot as JSON (cards, rows, theme, users). | `refresh?: boolean` |
| `search_cards` | Case-insensitive substring search across card text. Returns matches with row label. | `query: string`, `refresh?: boolean` |
| `summarize_board` | Compact text view grouped by horizontal row band, story cards flagged. | `refresh?: boolean` |
| `get_story_cluster` | Given a Jira-style id, returns the story card plus the open task cards spatially tied to it (`x < story.x`, same row band). | `jira: string`, `refresh?: boolean` |

Snapshots are cached for `SCRUMBLR_CACHE_MS` (default 30s) so multiple tool calls in one prompt don't hammer the server.

## Install

The package ships a `scrumblr-mcp` bin and runs via `npx` straight from this repo, so you don't need to clone or `npm install`. Paste the snippet for your editor below into its MCP config.

### VS Code

Drop this into `.vscode/mcp.json` (workspace) or your user-level MCP config:

```jsonc
{
  "servers": {
    "scrumblr": {
      "command": "npx",
      "args": ["-y", "github:adam-ondrejka/scrumblr-mcp"],
      "env": {
        "SCRUMBLR_URL": "https://scrumblr.your-internal-host",
        "SCRUMBLR_BOARD": "team-retro-q2"
      }
    }
  }
}
```

### opencode

Add to `~/.config/opencode/opencode.json` (or a project-level `opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "scrumblr": {
      "type": "local",
      "command": ["npx", "-y", "github:adam-ondrejka/scrumblr-mcp"],
      "enabled": true,
      "environment": {
        "SCRUMBLR_URL": "https://scrumblr.your-internal-host",
        "SCRUMBLR_BOARD": "team-retro-q2"
      }
    }
  }
}
```

## Configuration

| Env var | Required | Default | Notes |
| --- | --- | --- | --- |
| `SCRUMBLR_URL` | yes | | Origin only, e.g. `https://scrumblr.example.com`. No trailing path. |
| `SCRUMBLR_BOARD` | yes | | Board id (the URL segment after the origin). |
| `SCRUMBLR_BASEURL` | no | `/` | Sub-path the server runs under, matches `conf.baseurl` on the server. |
| `SCRUMBLR_COOKIE` | no | | Cookie header for auth-gated servers. Capture from a logged-in browser session. |
| `SCRUMBLR_CACHE_MS` | no | `30000` | Snapshot cache TTL in milliseconds. |
| `SCRUMBLR_JIRA_PREFIX` | no | `[A-Z]+` | Project prefix used to detect story cards. Set to e.g. `PROJ` to narrow detection. |

See [`.env.example`](.env.example) for a copy-paste template.

## Requirements

- Node 20+
- Network access to the scrumblr host
- A scrumblr server based on the [lspevak fork](https://github.com/lspevak/scrumblr) (socket.io 2.x with the legacy v0.9 envelope)

## Troubleshooting

If a tool call (or the local snapshot script) hangs or returns no cards:

- check network connectivity to the scrumblr host
- confirm `SCRUMBLR_URL` is the **origin only**, not the full board URL
- confirm `SCRUMBLR_BOARD` matches the path segment
- if the server runs under a sub-path, set `SCRUMBLR_BASEURL`
- if the server is auth-gated, grab the `Cookie` header from a logged-in browser session and set `SCRUMBLR_COOKIE`

## Local development

```bash
git clone https://github.com/adam-ondrejka/scrumblr-mcp.git
cd scrumblr-mcp
npm install
cp .env.example .env
# edit .env
```

Smoke-test connectivity end-to-end:

```bash
set -a; source .env; set +a
npm run snapshot
```

You should see a JSON dump with `cards`, `columns`, etc. To wire a local checkout into an editor, swap `npx -y github:adam-ondrejka/scrumblr-mcp` for `node /path/to/scrumblr-mcp/src/index.js` in the MCP config above.

## Protocol notes

The lspevak fork is socket.io 2.4.x but kept the legacy v0.9-style envelope: every event is sent via `socket.send({action, data})` and received on the default `message` event with the same shape.

Bootstrap sequence the browser performs:

1. connect to `<origin><baseurl>/socket.io`
2. `send({action:'joinRoom', data: roomId})`
3. wait for `{action:'roomAccept'}`
4. `send({action:'initializeMe'})`
5. server replies with a burst of `init*` and snapshot messages, then goes quiet

There is no explicit "bootstrap done" message, so the client settles on a quiet-period heuristic (750ms after the last inbound frame).

Cards have absolute `x`/`y` pixel positions, not column references. `get_story_cluster` and `summarize_board` assume a board convention where story cards are spatial anchors and task cards sit to the left of the story within the same horizontal row band; see [`src/board-utils.js`](src/board-utils.js).

## Limits

- Read-only; no card create/edit.
- No live subscription. Every `get_board` call is a fresh socket round-trip, or a cache hit.
- Assumes socket.io 2.x server; will fail handshake against a 3.x or 4.x scrumblr fork.

## License

MIT. See [LICENSE](LICENSE).
