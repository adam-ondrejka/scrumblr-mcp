// Tests for the write path: spins up an in-process socket.io 2.x server,
// asserts that sendCardWrite emits the wire envelope our MCP tools rely on.
//
// Run with: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import socketIO from "socket.io";
import { newCardId, sendCardWrite } from "../src/scrumblr-client.js";

/**
 * Start a fake scrumblr server that captures inbound `message` envelopes
 * and answers `joinRoom` with a `roomAccept`, matching the lspevak handshake.
 */
async function startFakeServer() {
  const http = createServer();
  const io = socketIO(http);
  const received = [];

  io.on("connection", (socket) => {
    socket.on("message", (msg) => {
      received.push(msg);
      if (msg?.action === "joinRoom") {
        socket.send({ action: "roomAccept" });
      }
    });
  });

  await new Promise((resolve) => http.listen(0, resolve));
  const { port } = http.address();

  return {
    url: `http://localhost:${port}`,
    received,
    async close() {
      io.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

test("sendCardWrite handshakes, then emits createCard with our payload", async () => {
  const server = await startFakeServer();
  try {
    const id = newCardId();
    const payload = { id, text: "hello from test", x: 10, y: 20, colour: "yellow", rot: 0, type: "" };

    await sendCardWrite({ url: server.url, board: "test-board" }, "createCard", payload);

    const [join, create] = server.received;
    assert.equal(join.action, "joinRoom");
    assert.equal(join.data, "/test-board", "roomId should have a leading slash");
    assert.equal(create.action, "createCard");
    assert.deepEqual(create.data, payload);
  } finally {
    await server.close();
  }
});

test("sendCardWrite emits deleteCard with the given id", async () => {
  const server = await startFakeServer();
  try {
    await sendCardWrite(
      { url: server.url, board: "test-board" },
      "deleteCard",
      { id: "card-to-go" },
    );

    const [, del] = server.received;
    assert.equal(del.action, "deleteCard");
    assert.deepEqual(del.data, { id: "card-to-go" });
  } finally {
    await server.close();
  }
});

test("newCardId produces unique, prefixed ids", () => {
  const a = newCardId();
  const b = newCardId();
  assert.match(a, /^mcp-/);
  assert.notEqual(a, b);
});
