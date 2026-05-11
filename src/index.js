#!/usr/bin/env node
// MCP server exposing a single scrumblr board.
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
import { searchCards, storyCluster, summarize } from "./board-views.js";

const SERVER_VERSION = "0.3.0";
const MAX_CARD_TEXT_LENGTH = 10000;
const VALID_COLOURS = ["white", "yellow", "blue", "green", "red", "orange", "purple"];

const cfg = buildConfig();

function buildConfig() {
  const url = requireEnv("SCRUMBLR_URL");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      die(`SCRUMBLR_URL must be http(s); got ${parsed.protocol}`);
    }
  } catch (e) {
    die(`SCRUMBLR_URL is not a valid URL: ${e.message}`);
  }
  return {
    url,
    board: requireEnv("SCRUMBLR_BOARD"),
    baseurl: process.env.SCRUMBLR_BASEURL || "/",
    cookie: process.env.SCRUMBLR_COOKIE || undefined,
    cacheMs: Number(process.env.SCRUMBLR_CACHE_MS ?? 30000),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) die(`missing required env var ${name}`);
  return value;
}

function die(msg) {
  console.error(`scrumblr-mcp: ${msg}`);
  process.exit(1);
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
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
    },
  },
  {
    name: "search_cards",
    description: "Case-insensitive substring search across card text. Returns matching cards with their row label.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        refresh: { type: "boolean" },
      },
    },
  },
  {
    name: "summarize_board",
    description: "Compact board view grouped by horizontal row band, with story cards highlighted.",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
    },
  },
  {
    name: "get_story_cluster",
    description:
      "Given a Jira id (e.g. PROJ-123), return the story card and the open task cards spatially tied to it (x < story.x, same row band). Cards to the right of a story are done or unrelated and excluded.",
    inputSchema: {
      type: "object",
      required: ["jira"],
      properties: {
        jira: { type: "string" },
        refresh: { type: "boolean" },
      },
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
          enum: VALID_COLOURS,
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
  { name: "scrumblr-mcp", version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "get_board":         return ok(json(await getSnapshot({ force: !!args.refresh })));
      case "search_cards":      return ok(json(searchCards(await getSnapshot({ force: !!args.refresh }), String(args.query || ""))));
      case "summarize_board":   return ok(summarize(await getSnapshot({ force: !!args.refresh })));
      case "get_story_cluster": return ok(json(storyCluster(await getSnapshot({ force: !!args.refresh }), String(args.jira || ""))));
      case "create_card":       return ok(json(await createCard(args)));
      case "delete_card":       return ok(json(await deleteCard(args)));
      default:                  return err(`unknown tool: ${name}`);
    }
  } catch (e) {
    return err(`scrumblr operation failed: ${e?.message || e}`);
  }
});

async function createCard(args) {
  const text = String(args.text ?? "");
  if (!text) throw new Error("create_card requires non-empty text");
  if (text.length > MAX_CARD_TEXT_LENGTH) {
    throw new Error(`text too long (${text.length} chars, max ${MAX_CARD_TEXT_LENGTH})`);
  }
  const colour = args.colour || "yellow";
  if (!VALID_COLOURS.includes(colour)) {
    throw new Error(`invalid colour: ${colour}`);
  }
  const id = newCardId();
  const payload = {
    id,
    text,
    x: Number.isFinite(args.x) ? args.x : 50,
    y: Number.isFinite(args.y) ? args.y : 50,
    rot: Number.isFinite(args.rot) ? args.rot : 0,
    colour,
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

const json = (v) => JSON.stringify(v, null, 2);
const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text }], isError: true });

await server.connect(new StdioServerTransport());
console.error(`scrumblr-mcp ${SERVER_VERSION} ready`);
