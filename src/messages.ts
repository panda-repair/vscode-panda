import type * as vscode from "vscode";
import { createHmac } from "node:crypto";
import { OUTPUT_LIMIT } from "./catalog";
import { PandaError } from "./errors";

type Host = Pick<typeof vscode, "LanguageModelTextPart" | "LanguageModelToolCallPart" | "LanguageModelToolResultPart" |
  "LanguageModelChatMessageRole" | "LanguageModelChatToolMode">;
type ChatMessage = vscode.LanguageModelChatRequestMessage;
type WireMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; name?: string;
  tool_call_id?: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] };

function textOf(part: unknown, host: Host): string {
  if (part instanceof host.LanguageModelTextPart) return part.value;
  throw new PandaError("Panda accepts text and function tools. This message contains an unsupported content type.");
}

export function mapMessages(messages: readonly ChatMessage[], host: Host): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const name = message.name ? { name: message.name } : {};
    // The stock agent supplies System instructions to stable providers. Its role
    // name is available on the incoming enum even when callers can only create User and Assistant.
    if (host.LanguageModelChatMessageRole[message.role] === "System") {
      wire.push({ role: "system", ...name, content: message.content.map(part => textOf(part, host)).join("") });
    } else if (message.role === host.LanguageModelChatMessageRole.Assistant) {
      const calls: NonNullable<WireMessage["tool_calls"]> = [];
      const text: string[] = [];
      for (const part of message.content) {
        if (part instanceof host.LanguageModelToolCallPart) {
          calls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: canonicalJSON(part.input) } });
        } else text.push(textOf(part, host));
      }
      wire.push({ role: "assistant", ...name, content: text.length ? text.join("") : calls.length ? null : "",
        ...(calls.length ? { tool_calls: calls } : {}) });
    } else if (message.role === host.LanguageModelChatMessageRole.User) {
      let text: string[] = [];
      for (const part of message.content) {
        if (part instanceof host.LanguageModelToolResultPart) {
          if (text.length) { wire.push({ role: "user", ...name, content: text.join("") }); text = []; }
          wire.push({ role: "tool", tool_call_id: part.callId, content: part.content.map(item => textOf(item, host)).join("") });
        } else text.push(textOf(part, host));
      }
      if (text.length || !message.content.length) wire.push({ role: "user", ...name, content: text.join("") });
    } else throw new PandaError("The conversation contains an unsupported chat role.");
  }
  return wire;
}

export function chatBody(id: string, messages: readonly ChatMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, host: Host) {
  const tools = options.tools?.map(tool => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: "object", properties: {} },
  } }));
  const required = options.toolMode === host.LanguageModelChatToolMode.Required;
  if (required && !tools?.length) throw new PandaError("A required tool call needs at least one tool.");
  let limit = OUTPUT_LIMIT;
  for (const name of ["max_tokens", "maxOutputTokens", "max_completion_tokens"]) {
    const value: unknown = options.modelOptions?.[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new PandaError("The output token limit must be a positive integer.");
    }
    limit = Math.min(limit, value);
  }
  return { model: id, stream: true, max_tokens: limit, messages: mapMessages(messages, host),
    ...(tools?.length ? { tools, tool_choice: required ? "required" : "auto" } : {}) };
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_name, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

// Identical wire requests share a key across host retries. No conversation content or token is sent in the key.
export function idempotencyKey(endpoint: string, token: string, body: string): string {
  return "panda-vscode-" + createHmac("sha256", token).update(endpoint).update("\0").update(body).digest("hex");
}

export function tokenEstimate(input: string | ChatMessage, host: Host): number {
  const content = typeof input === "string" ? input : mapMessages([input], host).map(message =>
    (message.name ?? "") + (message.content ?? "") + (message.tool_call_id ?? "") +
    (message.tool_calls ?? []).map(call => call.id + call.function.name + call.function.arguments).join("")).join("");
  let characters = 0;
  for (const _ of content) characters++;
  return Math.ceil(characters / 4);
}
