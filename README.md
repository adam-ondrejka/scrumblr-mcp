# scrumblr-mcp

Read-only MCP server for a single [scrumblr](https://github.com/lspevak/scrumblr) board.

## What it does

Connects to the board over socket.io v2, captures the bootstrap state replay (`initCards`, `initColumns`, `initRows`, `changeTheme`, `setBoardSize`, `initialUsers`), and exposes it through MCP tools:

- `get_board` — full snapshot as JSON
- `search_cards` — substring match across card text, returns row label
- `summarize_board` — compact text view grouped by horizontal row band
- `get_story_cluster` — given a Jira id, returns the story card plus the open task cards spatially tied to it (x < story.x, same row band)

Snapshots are cached for `SCRUMBLR_CACHE_MS` (default 30s) so multiple tool calls in one prompt don't hammer the server.

## Requirements

- Node 20+
- Network access to the scrumblr host
- The board id (the URL segment after the origin)

## Install

```bash
cd ~/scrumblr-mcp
npm install
cp .env.example .env
# edit .env
```

## Smoke test

```bash
set -a; source .env; set +a
npm run snapshot
```

You should see a JSON dump with `cards`, `columns`, etc. If it hangs or times out:

- check network connectivity to the scrumblr host
- confirm `SCRUMBLR_URL` is the **origin only**, not the full board URL
- confirm `SCRUMBLR_BOARD` matches the path segment
- if the server runs under a sub-path, set `SCRUMBLR_BASEURL` (matches `conf.baseurl` on the server)
- if there's auth, grab the Cookie header from a logged-in browser session and set `SCRUMBLR_COOKIE`

## Wire into your editor

The package exposes a `scrumblr-mcp` bin, so it can run via `npx` straight from this repo — no clone, no `npm install`, just an entry in your MCP config. Fill in `SCRUMBLR_URL` / `SCRUMBLR_BOARD` for your team's board.

### VS Code (Copilot Chat / MCP)

Drop this into `.vscode/mcp.json` in any workspace, or into the user-level equivalent:

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

### Already have it cloned?

If you've cloned the repo (e.g. for development), point at the local checkout instead — swap the command for `node /path/to/scrumblr-mcp/src/index.js` and drop the `-y github:adam-ondrejka/scrumblr-mcp` args.

## Protocol notes (for future hacking)

The lspevak fork is socket.io 2.4.x but kept the legacy v0.9-style envelope: every event is sent via `socket.send({action, data})` and received on the default `message` event with the same shape.

Bootstrap sequence the browser performs:

1. connect to `<origin><baseurl>/socket.io`
2. `send({action:'joinRoom', data: roomId})`
3. wait for `{action:'roomAccept'}`
4. `send({action:'initializeMe'})`
5. server replies with a burst of `init*` and snapshot messages, then goes quiet

There is no explicit "bootstrap done" message, so the client settles on a quiet-period heuristic (750ms after the last inbound frame).

Card placement: cards have absolute `x`/`y` pixel positions, not column references. The CPR team's NoLimits board encodes status spatially — story cards are anchors, and tasks sit to the left of the story within the same horizontal row band. `get_story_cluster` and `summarize_board` both use this convention; see `src/board-utils.js`.

## Limits / known gaps

- read-only; no card create/edit
- no live subscription — every `get_board` call is a fresh socket round-trip (or cache hit)
- assumes socket.io 2.x server; will fail handshake against a 3.x or 4.x scrumblr fork
