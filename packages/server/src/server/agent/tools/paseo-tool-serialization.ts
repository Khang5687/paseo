import { z } from "zod";

import type { PaseoToolDefinition, PaseoToolResult } from "./types.js";

const EMPTY_OBJECT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
};

// The model reads this text on every later turn, so it is the structured payload alone: no
// count/id summary header (every id is already in the JSON) and no pretty-print indentation.

export function addModelVisibleStructuredContent(result: PaseoToolResult): PaseoToolResult {
  if (result.structuredContent === undefined || result.content.length > 0) {
    return result;
  }

  return {
    ...result,
    content: [
      {
        type: "text",
        text: JSON.stringify(result.structuredContent),
      },
    ],
  };
}

// Native host tools must advertise the schema the agent MCP endpoint serves.
// @modelcontextprotocol/server converts tool input schemas with zod's
// standard JSON Schema hook at the draft 2020-12 target, so do the same here.
export function serializePaseoToolInputParameters(
  tool: PaseoToolDefinition,
): Record<string, unknown> {
  if (tool.inputSchema === undefined) {
    return { ...EMPTY_OBJECT_JSON_SCHEMA };
  }
  const schema =
    tool.inputSchema instanceof z.ZodType ? tool.inputSchema : z.object(tool.inputSchema);
  return {
    type: "object",
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
  };
}
