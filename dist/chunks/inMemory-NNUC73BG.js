#!/usr/bin/env node
import { createRequire as __shieldCreateRequire } from "node:module";
const require = __shieldCreateRequire(import.meta.url);
import "./chunk-CQRTQUVP.js";

// node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js
var InMemoryTransport = class _InMemoryTransport {
  constructor() {
    this._messageQueue = [];
  }
  /**
   * Creates a pair of linked in-memory transports that can communicate with each other. One should be passed to a Client and one to a Server.
   */
  static createLinkedPair() {
    const clientTransport = new _InMemoryTransport();
    const serverTransport = new _InMemoryTransport();
    clientTransport._otherTransport = serverTransport;
    serverTransport._otherTransport = clientTransport;
    return [clientTransport, serverTransport];
  }
  async start() {
    while (this._messageQueue.length > 0) {
      const queuedMessage = this._messageQueue.shift();
      this.onmessage?.(queuedMessage.message, queuedMessage.extra);
    }
  }
  async close() {
    const other = this._otherTransport;
    this._otherTransport = void 0;
    await other?.close();
    this.onclose?.();
  }
  /**
   * Sends a message with optional auth info.
   * This is useful for testing authentication scenarios.
   */
  async send(message, options) {
    if (!this._otherTransport) {
      throw new Error("Not connected");
    }
    if (this._otherTransport.onmessage) {
      this._otherTransport.onmessage(message, { authInfo: options?.authInfo });
    } else {
      this._otherTransport._messageQueue.push({ message, extra: { authInfo: options?.authInfo } });
    }
  }
};
export {
  InMemoryTransport
};
