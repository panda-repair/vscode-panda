import { Agent, request } from "undici";
import type { Dispatcher } from "undici";
import { grantedModels } from "./catalog";
import { PandaError, record, responseError } from "./errors";
import { canonicalJSON, idempotencyKey } from "./messages";
import { streamParts, OutputPart } from "./stream";

export const IDLE_TIMEOUT_MS = 600_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

async function boundedJSON(body: AsyncIterable<Uint8Array>): Promise<unknown> {
  const pieces: Uint8Array[] = [];
  let bytes = 0;
  for await (const piece of body) {
    bytes += piece.length;
    if (bytes > MAX_JSON_BYTES) return;
    pieces.push(piece);
  }
  try { return JSON.parse(Buffer.concat(pieces).toString("utf8")); } catch { return; }
}

export class PandaClient {
  private readonly agent = new Agent({ headersTimeout: IDLE_TIMEOUT_MS, bodyTimeout: IDLE_TIMEOUT_MS,
    pipelining: 0, allowH2: false });

  async close() { await this.agent.destroy(); }

  private async exchange<T>(endpoint: string, path: string, key: string, body: string | undefined, signal: AbortSignal,
    consume: (response: Dispatcher.ResponseData) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try {
      const response = await request(endpoint + path, { dispatcher: this.agent, method: body === undefined ? "GET" : "POST",
        headersTimeout: IDLE_TIMEOUT_MS, bodyTimeout: IDLE_TIMEOUT_MS, signal, idempotent: false,
        headers: { authorization: "Bearer " + key, accept: body === undefined ? "application/json" : "text/event-stream",
          ...(body !== undefined && { "content-type": "application/json", "idempotency-key": idempotencyKey(endpoint, key, body) }) },
        body,
      });
      try {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const payload = [400, 402, 429].includes(response.statusCode) ? await boundedJSON(response.body) : undefined;
          throw responseError(response.statusCode, payload, key);
        }
        return await consume(response);
      } finally {
        // Discard redirects and other unread bodies. Undici signals that disposal
        // asynchronously, after the response error has already been returned.
        response.body.on("error", () => {});
        response.body.destroy();
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PandaError) throw error;
      const timedOut = record(error) && typeof error.code === "string" && error.code.includes("TIMEOUT");
      const reason = timedOut ? "The Panda connection timed out." : "Could not complete the Panda connection.";
      throw new PandaError(reason + (body === undefined ? " Check the endpoint and try again." : " The request may have run and been charged."));
    }
  }

  async list(endpoint: string, key: string, signal: AbortSignal) {
    return this.exchange(endpoint, "/models", key, undefined, signal, async response => {
      const catalog = await boundedJSON(response.body);
      if (!record(catalog)) throw new PandaError("Panda returned an invalid model catalog.");
      return grantedModels(catalog.data);
    });
  }

  async chat(endpoint: string, key: string, body: object, signal: AbortSignal, report: (part: OutputPart) => void) {
    return this.exchange(endpoint, "/chat/completions", key, canonicalJSON(body), signal, async response => {
      const type = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "text/event-stream") throw new PandaError("Panda returned an unexpected response format.");
      await streamParts(response.body, key, signal, report);
    });
  }
}
