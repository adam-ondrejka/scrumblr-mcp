#!/usr/bin/env node
// MCP server exposing a single scrumblr board as read-only tools.
//
// Required env: SCRUMBLR_URL, SCRUMBLR_BOARD
// Optional env: SCRUMBLR_BASEURL (default '/')
//               SCRUMBLR_COOKIE
//               SCRUMBLR_CACHE_MS (default 30000)
//               SCRUMBLR_JIRA_PREFIX (default '[A-Z]+'; controls story-card detection)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchBoardSnapshot, newCardId, sendCardWrite } from "./scrumblr-client.js";
import { cardText, clusterFor, findStory, isStoryCard, num, rowLabelFor } from "./board-utils.js";

const cfg = {
  url: requireEnv("SCRUMBLR_URL"),
  board: requireEnv("SCRUMBLR_BOARD"),
  baseurl: process.env.SCRUMBLR_BASEURL || "/",
  cookie: process.env.SCRUMBLR_COOKIE || undefined,
  cacheMs: Number(process.env.SCRUMBLR_CACHE_MS ?? 30000),
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`scrumblr-mcp: missing required env var ${name}`); process.exit(1); }
  return v;
}

let cached = null;
async function getSnapshot({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < cfg.cacheMs) return cached.snap;
  const snap = await fetchBoardSnapshot(cfg);
  cached = { at: Date.now(), snap };
  return snap;
}

const tools = [
  {
    name: "get_board",
    description: "Full snapshot of the configured board: cards, rows, theme, users. Cached briefly; pass refresh=true to force.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean" } } },
  },
  {
    name: "search_cards",
    description: "Case-insensitive substring search across card text. Returns matching cards with their row label.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: { query: { type: "string" }, refresh: { type: "boolean" } },
    },
  },
  {
    name: "summarize_board",
    description: "Compact board view grouped by horizontal row band, with story cards highlighted.",
    inputSchema: { type: "object", properties: { refresh: { type: "boolean" } } },
  },
  {
    name: "get_story_cluster",
    description:
      "Given a Jira id (e.g. PROJ-123), return the story card and the open task cards spatially tied to it (x < story.x, same row band). Cards to the right of a story are done or unrelated and excluded.",
    inputSchema: {
      type: "object", required: ["jira"],
      properties: { jira: { type: "string" }, refresh: { type: "boolean" } },
    },
  },
  {
    name: "create_card",
    description:
      "Create a new card on the board. The server does not echo writes back to the writer, so call get_board (with refresh=true) afterwards to confirm. Returns the generated card id.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Card text. Markdown supported by scrumblr." },
        x: { type: "number", description: "X pixel position. Default 50." },
        y: { type: "number", description: "Y pixel position. Default 50." },
        colour: {
          type: "string",
          enum: ["white", "yellow", "blue", "green", "red", "orange", "purple"],
          description: "Card colour. Default 'yellow'.",
        },
        rot: { type: "number", description: "Rotation in degrees. Default 0." },
      },
    },
  },
  {
    name: "delete_card",
    description:
      "Delete a card by id. The server does not echo writes back to the writer, so call get_board (with refresh=true) afterwards to confirm.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
];

const server = new Server(
  { name: "scrumblr-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "create_card":        return ok(JSON.stringify(await createCard(args), null, 2));
      case "delete_card":        return ok(JSON.stringify(await deleteCard(args), null, 2));
      case "get_board":          return ok(JSON.stringify(await getSnapshot({ force: !!args.refresh }), null, 2));
      case "search_cards":       return ok(JSON.stringify(searchCards(await getSnapshot({ force: !!args.refresh }), String(args.query || "")), null, 2));
      case "summarize_board":    return ok(summarize(await getSnapshot({ force: !!args.refresh })));
      case "get_story_cluster":  return ok(JSON.stringify(storyCluster(await getSnapshot({ force: !!args.refresh }), String(args.jira || "")), null, 2));
      default:                   return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`scrumblr operation failed: ${e?.message || e}`);
  }
});

async function createCard(args) {
  const id = newCardId();
  const payload = {
    id,
    text: String(args.text ?? ""),
    x: Number.isFinite(args.x) ? args.x : 50,
    y: Number.isFinite(args.y) ? args.y : 50,
    rot: Number.isFinite(args.rot) ? args.rot : 0,
    colour: args.colour || "yellow",
    type: "",
  };
  await sendCardWrite(cfg, "createCard", payload);
  cached = null;
  return { ok: true, id, sent: payload };
}

async function deleteCard(args) {
  const id = String(args.id || "");
  if (!id) throw new Error("delete_card requires an id");
  await sendCardWrite(cfg, "deleteCard", { id });
  cached = null;
  return { ok: true, id };
}

const ok  = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

function searchCards(snap, query) {
  const q = query.toLowerCase();
  return snap.cards
    .filter((c) => cardText(c).toLowerCase().includes(q))
    .map((c) => ({
      id: c.id, text: c.text, colour: c.colour,
      x: num(c.x), y: num(c.y),
      row: rowLabelFor(c.y, snap.rows),
      isStory: isStoryCard(c),
    }));
}

function summarize(snap) {
  const groups = new Map();
  for (const r of snap.rows) groups.set(r.text, []);
  groups.set(null, []); // anything above the topmost separator

  for (const c of snap.cards) {
    const label = rowLabelFor(c.y, snap.rows);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(c);
  }

  const lines = [
    `Board: ${snap.board}    Fetched: ${snap.fetchedAt}`,
    `Cards: ${snap.cards.length}   Rows: ${snap.rows.length}   Users connected: ${snap.users.length}`,
    "",
  ];
  for (const [label, cards] of groups) {
    if (!cards.length) continue;
    cards.sort((a, b) => num(a.y) - num(b.y) || num(a.x) - num(b.x));
    lines.push(`## ${label ?? "(above first row)"} — ${cards.length} cards`);
    for (const c of cards) {
      const tag = isStoryCard(c) ? "STORY " : "      ";
      const t = cardText(c).replace(/\s+/g, " ").slice(0, 100);
      lines.push(`  ${tag}[${(c.colour || "?").padEnd(6)}] ${t}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function storyCluster(snap, jira) {
  const story = findStory(snap.cards, jira);
  if (!story) return { error: `no story card found for ${jira}` };
  const cluster = clusterFor(story, snap.cards);
  return {
    story: { id: story.id, jira, text: story.text, x: num(story.x), y: num(story.y),
             row: rowLabelFor(story.y, snap.rows) },
    openTasks: cluster.map((c) => ({
      id: c.id, text: c.text, colour: c.colour, x: num(c.x), y: num(c.y),
    })),
  };
}

await server.connect(new StdioServerTransport());
console.error("scrumblr-mcp ready");
