// socket.io v2 client for the lspevak scrumblr fork.
//
// The fork preserves a legacy v0.9-style envelope: every event is sent through
// the default `message` channel as `{action, data}`. Both reads (snapshot
// bootstrap) and writes (createCard, deleteCard) use the same connect /
// joinRoom / roomAccept handshake; openClient centralises that setup.
//
// Bootstrap (read):
//   1. open socket
//   2. send {action:'joinRoom', data:<roomId>}
//   3. on {action:'roomAccept'}, send {action:'initializeMe'}
//   4. collect inbound init* messages until traffic goes quiet
//
// Write:
//   1. open socket
//   2. send {action:'joinRoom', data:<roomId>}
//   3. on {action:'roomAccept'}, send {action, data}, flush, disconnect
//
// The server broadcasts writes to roommates only, so the writer never sees
// its own action echoed back; we trust the send after a short flush window.

import io from "socket.io-client";

const QUIET_MS = 750;
const HARD_TIMEOUT_MS = 15000;
const WRITE_FLUSH_MS = 250;
const WRITE_HARD_TIMEOUT_MS = 10000;

/**
 * Build the socket.io path and the room id from a board cfg.
 *
 * @param {ClientConfig} cfg
 * @returns {{ socketPath: string, roomId: string }}
 */
function resolveTransport({ baseurl = "/", board }) {
  const socketPath = baseurl === "/" ? "/socket.io" : `${baseurl.replace(/\/$/, "")}/socket.io`;
  const roomId = board.startsWith("/") ? board : "/" + board;
  return { socketPath, roomId };
}

/**
 * Open a socket.io v2 connection to the scrumblr server with the options
 * both reads and writes need.
 *
 * @param {ClientConfig} cfg
 * @returns {{ socket: ReturnType<typeof io>, roomId: string }}
 */
function openClient(cfg) {
  const { socketPath, roomId } = resolveTransport(cfg);
  const socket = io(cfg.url, {
    path: socketPath,
    transports: ["websocket", "polling"],
    reconnection: false,
    forceNew: true,
    extraHeaders: cfg.cookie ? { Cookie: cfg.cookie } : undefined,
  });
  return { socket, roomId };
}

/**
 * Connect to the board and capture the bootstrap state replay.
 *
 * @param {ClientConfig} cfg
 * @returns {Promise<BoardSnapshot>}
 */
export async function fetchBoardSnapshot(cfg) {
  const { socket, roomId } = openClient(cfg);
  const snapshot = emptySnapshot(cfg.board);

  return new Promise((resolve, reject) => {
    let quietTimer;
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(quietTimer);
      try { socket.disconnect(); } catch {}
      err ? reject(err) : resolve(snapshot);
    };

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(null), QUIET_MS);
    };

    const hardTimer = setTimeout(
      () => finish(new Error(`scrumblr bootstrap timed out after ${HARD_TIMEOUT_MS}ms`)),
      HARD_TIMEOUT_MS,
    );

    socket.on("connect_error", (e) => finish(new Error(`connect_error: ${e?.message || e}`)));
    socket.on("error", (e) => finish(new Error(`socket error: ${e?.message || e}`)));
    socket.on("connect", () => socket.send({ action: "joinRoom", data: roomId }));
    socket.on("message", (msg) => {
      if (!msg || typeof msg !== "object") return;
      armQuiet();
      applyBootstrapMessage(socket, snapshot, msg);
    });
  });
}

/**
 * Send a single write action (createCard, deleteCard) and disconnect.
 *
 * @param {ClientConfig} cfg
 * @param {string} action  Server-side action name.
 * @param {object} data    Action payload.
 * @returns {Promise<void>}
 */
export async function sendCardWrite(cfg, action, data) {
  const { socket, roomId } = openClient(cfg);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { socket.disconnect(); } catch {}
      err ? reject(err) : resolve();
    };

    const hardTimer = setTimeout(
      () => finish(new Error(`scrumblr write timed out after ${WRITE_HARD_TIMEOUT_MS}ms`)),
      WRITE_HARD_TIMEOUT_MS,
    );

    socket.on("connect_error", (e) => finish(new Error(`connect_error: ${e?.message || e}`)));
    socket.on("error", (e) => finish(new Error(`socket error: ${e?.message || e}`)));
    socket.on("connect", () => socket.send({ action: "joinRoom", data: roomId }));
    socket.on("message", (msg) => {
      if (msg?.action !== "roomAccept") return;
      socket.send({ action, data });
      setTimeout(() => finish(null), WRITE_FLUSH_MS);
    });
  });
}

/** Generate a card id unlikely to collide with existing seeded ids. */
export function newCardId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySnapshot(board) {
  return {
    board,
    fetchedAt: new Date().toISOString(),
    cards: [],
    columns: [],
    rows: [],
    theme: null,
    boardSize: null,
    users: [],
  };
}

function applyBootstrapMessage(socket, snap, msg) {
  switch (msg.action) {
    case "roomAccept":   return socket.send({ action: "initializeMe" });
    case "initCards":    snap.cards   = arr(msg.data); return;
    case "initColumns":  snap.columns = arr(msg.data); return;
    case "initRows":     snap.rows    = arr(msg.data); return;
    case "initialUsers": snap.users   = arr(msg.data); return;
    case "changeTheme":  snap.theme   = msg.data ?? null; return;
    case "setBoardSize": snap.boardSize = msg.data ?? null; return;
    // moveEraser / moveMarker / join-announce: ignored for snapshot
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * @typedef {object} ClientConfig
 * @property {string} url      Origin of the scrumblr server.
 * @property {string} board    Room id; leading slash is added if missing.
 * @property {string} [baseurl='/']  Matches conf.baseurl on the server.
 * @property {string} [cookie] Optional Cookie header for auth.
 *
 * @typedef {object} Card
 * @property {string} id
 * @property {string} text
 * @property {string|number} x
 * @property {string|number} y
 * @property {string} colour
 * @property {string} [type]
 * @property {string|null} [sticker]
 *
 * @typedef {object} Row
 * @property {string} id
 * @property {string} text
 * @property {string|number} y
 *
 * @typedef {object} BoardSnapshot
 * @property {string} board
 * @property {string} fetchedAt
 * @property {Card[]} cards
 * @property {string[]} columns
 * @property {Row[]} rows
 * @property {string|null} theme
 * @property {{width:string, height:string}|null} boardSize
 * @property {Array<{sid:string, user_name:string}>} users
 */
