import { Transport, NetworkSettings, Response } from "./transport";
import { grantedModels } from "./catalog";
import { PandaError, record, responseError } from "./errors";
import { canonicalJSON, idempotencyKey } from "./messages";
import { streamParts, OutputPart } from "./stream";

export { IDLE_TIMEOUT_MS } from "./transport";
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export type FreshOperation = { originalKey: string; afterRun: string };

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
  private readonly transport: Transport;
  constructor(settings: () => NetworkSettings = () => ({})) { this.transport = new Transport(settings); }

  close() { return this.transport.close(); }

  private async exchange<T>(endpoint: string, path: string, key: string, wire: { body: string; key: string } | undefined, signal: AbortSignal,
    consume: (response: Response) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try {
      const headers = { authorization: "Bearer " + key, accept: wire ? "text/event-stream" : "application/json",
        ...(wire && { "content-type": "application/json", "idempotency-key": wire.key }) };
      return await this.transport.exchange(endpoint + path, key, headers, wire?.body, signal, async response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const payload = [400, 402, 409, 429].includes(response.statusCode) ? await boundedJSON(response.body) : undefined;
          const run = response.headers["x-panda-request-id"];
          throw responseError(response.statusCode, payload, key, typeof run === "string" ? run : undefined);
        }
        return await consume(response);
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PandaError) throw error;
      const timedOut = record(error) && typeof error.code === "string" && error.code.includes("TIMEOUT");
      const reason = timedOut ? "The Panda connection timed out." : "Could not complete the Panda connection.";
      throw new PandaError(reason + (wire ? " The request may have run and been charged." : " Check the endpoint and try again."));
    }
  }

  async list(endpoint: string, key: string, signal: AbortSignal) {
    return this.exchange(endpoint, "/models", key, undefined, signal, async response => {
      const catalog = await boundedJSON(response.body);
      if (!record(catalog)) throw new PandaError("Panda returned an invalid model catalog.");
      return grantedModels(catalog.data);
    });
  }

  async chat(endpoint: string, key: string, body: object | string, signal: AbortSignal, report: (part: OutputPart) => void,
    afterRun?: string) {
    const text = typeof body === "string" ? body : canonicalJSON(body);
    return this.exchange(endpoint, "/chat/completions", key, { body: text, key: idempotencyKey(endpoint, key, text, afterRun) }, signal, async response => {
      const type = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (type !== "text/event-stream") throw new PandaError("Panda returned an unexpected response format.");
      await streamParts(response.body, key, signal, report);
    });
  }
}
