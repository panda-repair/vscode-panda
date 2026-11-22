import { PandaError, PandaOutputLimit, record, streamError } from "./errors";

export type OutputPart = { text: string } | { id: string; name: string; input: object };
const MAX_EVENT = 4 * 1024 * 1024;
const uncertain = () => new PandaError("Panda's response ended before completion. The request may have run and been charged.");

async function* eventData(body: AsyncIterable<Uint8Array>, signal: AbortSignal) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", event = "", lines: string[] = [], size = 0;
  function* consume(eof: boolean) {
    let pos = 0;
    for (;;) {
      const match = /[\r\n]/g;
      match.lastIndex = pos;
      const end = match.exec(buffer);
      if (!end || (!eof && end[0] === "\r" && end.index + 1 === buffer.length)) break;
      const line = buffer.slice(pos, end.index);
      pos = end.index + (buffer.startsWith("\r\n", end.index) ? 2 : 1);
      if (!line) {
        if (lines.length) yield { data: lines.join("\n"), event };
        lines = [];
        event = "";
        size = 0;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line === "data" || line.startsWith("data:")) {
        const data = line.slice(5).replace(/^ /, "");
        size += data.length + 1;
        if (size > MAX_EVENT) throw new PandaError("A Panda stream event exceeded the size limit.");
        lines.push(data);
      }
    }
    buffer = buffer.slice(pos);
    if (buffer.length > MAX_EVENT) throw new PandaError("A Panda stream event exceeded the size limit.");
  }
  for await (const chunk of body) {
    signal.throwIfAborted();
    buffer += decoder.decode(chunk, { stream: true });
    yield* consume(false);
  }
  buffer += decoder.decode();
  yield* consume(true);
}

export async function streamParts(body: AsyncIterable<Uint8Array>, key: string, signal: AbortSignal,
  report: (part: OutputPart) => void): Promise<void> {
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let toolSize = 0;
  for await (const { data, event } of eventData(body, signal)) {
    signal.throwIfAborted();
    if (data === "[DONE]" && event !== "error") break;
    let chunk: unknown;
    try { chunk = JSON.parse(data); } catch { throw new PandaError("Panda returned an invalid stream event."); }
    if (!record(chunk)) throw new PandaError("Panda returned an invalid stream event.");
    const first = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    const choiceError = record(first) ? first.error ?? (record(first.delta) ? first.delta.error : undefined) : undefined;
    const error = chunk.error ?? choiceError ?? (event === "error" ? chunk : undefined);
    if (error != null) throw streamError(error, chunk.status, key);
    if (!Array.isArray(chunk.choices)) throw new PandaError("Panda returned an invalid stream choice.");
    const choice: unknown = chunk.choices[0];
    if (choice === undefined) continue; // Optional aggregate usage frame.
    if (!record(choice)) throw new PandaError("Panda returned an invalid stream choice.");
    const delta = choice.delta ?? {};
    if (!record(delta)) throw new PandaError("Panda returned an invalid stream delta.");
    if (typeof delta.content === "string" && delta.content.length) report({ text: delta.content });
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw new PandaError("Panda returned an invalid tool call.");
      for (const part of delta.tool_calls) {
        if (!record(part) || typeof part.index !== "number" || !Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 128) {
          throw new PandaError("Panda returned an invalid tool-call index.");
        }
        const call = calls.get(part.index) ?? { id: "", name: "", args: "" };
        const fn = part.function ?? {};
        if (!record(fn)) throw new PandaError("Panda returned an invalid tool call.");
        for (const [field, fragment] of [["id", part.id], ["name", fn.name], ["args", fn.arguments]] as const) {
          if (fragment === undefined || fragment === null) continue;
          if (typeof fragment !== "string") throw new PandaError("Panda returned an invalid tool-call fragment.");
          toolSize += fragment.length;
          if (toolSize > MAX_EVENT) throw new PandaError("Panda tool calls exceeded the size limit.");
          call[field] += fragment;
        }
        calls.set(part.index, call);
      }
    }
    if (choice.finish_reason == null) continue;
    if (choice.finish_reason === "content_filter") throw new PandaError("Panda declined this response.", "blocked");
    if (choice.finish_reason === "length") throw new PandaOutputLimit();
    if (!["stop", "tool_calls"].includes(String(choice.finish_reason))) throw uncertain();
    if (choice.finish_reason === "tool_calls" && !calls.size) throw new PandaError("Panda returned an incomplete tool call.");
    const ids = new Set<string>();
    const complete = [...calls].sort(([a], [b]) => a - b).map(([, call]) => {
      let input: unknown;
      try { input = JSON.parse(call.args); } catch { throw new PandaError("Panda returned incomplete tool arguments."); }
      if (!call.name || !call.id || ids.has(call.id) || !record(input)) throw new PandaError("Panda returned an invalid tool call.");
      ids.add(call.id);
      return { id: call.id, name: call.name, input };
    });
    for (const part of complete) { signal.throwIfAborted(); report(part); }
    return;
  }
  throw uncertain();
}
