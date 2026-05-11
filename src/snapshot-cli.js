#!/usr/bin/env node
// One-shot CLI: prints a board snapshot to stdout. Useful for sanity-checking
// connectivity & auth before wiring the MCP server into an editor.
//
// Usage: SCRUMBLR_URL=... SCRUMBLR_BOARD=... npm run snapshot

import { fetchBoardSnapshot } from "./scrumblr-client.js";

const cfg = {
  url: process.env.SCRUMBLR_URL,
  board: process.env.SCRUMBLR_BOARD,
  baseurl: process.env.SCRUMBLR_BASEURL || "/",
  cookie: process.env.SCRUMBLR_COOKIE,
};

if (!cfg.url || !cfg.board) {
  console.error("set SCRUMBLR_URL and SCRUMBLR_BOARD");
  process.exit(1);
}

try {
  const snap = await fetchBoardSnapshot(cfg);
  console.log(JSON.stringify(snap, null, 2));
} catch (err) {
  console.error("FAILED:", err.message);
  process.exit(2);
}
