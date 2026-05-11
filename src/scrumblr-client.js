// socket.io v2 client for the lspevak scrumblr fork.
//
// The fork preserves a legacy v0.9-style envelope: every event is sent through
// the default `message` channel as `{action, data}`. Bootstrap the same way
// the browser client does:
//
//   1. open socket
//   2. send {action:'joinRoom', data:<roomId>}
//   3. on {action:'roomAccept'} → send {action:'initializeMe'}
//   4. collect inbound init* messages until traffic goes quiet
//
// There is no terminating bootstrap event, so we settle on a quiet period
// after the last inbound frame.

import io from "socket.io-client";

const QUIET_MS = 750;
const HARD_TIMEOUT_MS = 15000;

/**
 * @param {object} opts
 * @param {string} opts.url     Origin of the scrumblr server.
 * @param {string} opts.board   Room id; leading slash is added if missing
 *                              (browser client derives it from `pathname` and keeps the slash).
 * @param {string} [opts.baseurl='/']  Matches conf.baseurl on the server.
 * @param {string} [opts.cookie]       Optional Cookie header for auth.
 * @returns {Promise<BoardSnapshot>}
 */
export async function fetchBoardSnapshot({ url, board, baseurl = "/", cookie }) {
  const socketPath = baseurl === "/" ? "/socket.io" : `${baseurl.replace(/\/$/, "")}/socket.io`;
  const roomId = board.startsWith("/") ? board : "/" + board;

  const socket = io(url, {
    path: socketPath,
    transports: ["websocket", "polling"],
    reconnection: false,
    forceNew: true,
    extraHeaders: cookie ? { Cookie: cookie } : undefined,
  });

  const snapshot = emptySnapshot(board);

  return new Promise((resolve, reject) => {
    let quietTimer, settled = false;

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
      applyMessage(socket, snapshot, msg);
    });
  });
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

function applyMessage(socket, snap, msg) {
  switch (msg.action) {
    case "roomAccept":  return socket.send({ action: "initializeMe" });
    case "initCards":   snap.cards   = arr(msg.data); return;
    case "initColumns": snap.columns = arr(msg.data); return;
    case "initRows":    snap.rows    = arr(msg.data); return;
    case "initialUsers":snap.users   = arr(msg.data); return;
    case "changeTheme": snap.theme   = msg.data ?? null; return;
    case "setBoardSize":snap.boardSize = msg.data ?? null; return;
    // moveEraser / moveMarker / join-announce: ignored for snapshot
  }
}

const arr = (v) => (Array.isArray(v) ? v : []);

/**
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
