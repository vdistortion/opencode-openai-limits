import { Rpc } from "@opencode/plugin/rpc"

const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] }

export const CodexLimits = {
  id: "opencode-openai-limits",
  methods: {
    usage: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["ready", "hidden", "not_connected", "unsupported_auth", "upstream_error"],
          },
          message: { type: "string" },
          source: { type: "string", enum: ["opencode", "codex", "none"] },
          primaryPercent: nullableNumber,
          secondaryPercent: nullableNumber,
          primaryResetAt: nullableNumber,
          secondaryResetAt: nullableNumber,
        },
        required: ["status", "message", "source", "primaryPercent", "secondaryPercent", "primaryResetAt", "secondaryResetAt"],
        additionalProperties: false,
      },
    },
  },
  events: {},
} as const satisfies Rpc.PortableDefinition
