import { PandaError } from "./errors";

export const OUTPUT_LIMIT = 16_384;

const selectors = [
  ["auto", "Panda Auto", 224_000],
  ["auto:cost", "Panda Auto · Cost", 258_000],
  ["auto:quality", "Panda Auto · Quality", 187_000],
  ["panel:panda", "Panda Panel", 224_000],
  ["panel:panda-quality", "Panda Quality Panel", 224_000],
] as const;

export const models = selectors.map(([id, name, context]) => ({
  id, name, family: "panda", version: "1", maxInputTokens: context - OUTPUT_LIMIT,
  maxOutputTokens: OUTPUT_LIMIT, capabilities: { toolCalling: true, imageInput: false },
}));

export function grantedModels(data: unknown) {
  if (!Array.isArray(data) || data.some(row => !row || typeof row.id !== "string")) {
    throw new PandaError("Panda returned an invalid model catalog.");
  }
  const ids = new Set(data.map(row => row.id));
  return models.filter(model => ids.has(model.id));
}
