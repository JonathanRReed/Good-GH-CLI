const text = { type: "string" };
const outcome = {
  oneOf: [
    { required: ["outcome", "old", "new"], properties: { outcome: { const: "updated" }, old: text, new: text } },
    { required: ["outcome"], properties: { outcome: { const: "up-to-date" } } },
    { required: ["outcome", "reason"], properties: { outcome: { const: "skipped" }, reason: text } },
    { required: ["outcome", "message"], properties: { outcome: { enum: ["failed", "uncertain"] }, message: text } },
  ],
};
export const projectSyncResultSchema = {
  type: "object", required: ["schemaVersion", "status", "cancelled", "clones"],
  properties: {
    schemaVersion: { const: 1 }, status: { enum: ["succeeded", "partially_completed", "failed", "cancelled", "no_op"] }, cancelled: { type: "boolean" },
    clones: { type: "array", items: {
      type: "object", required: ["commonDir", "name", "outcome", "fetches", "checkouts", "forkUpstream"],
      properties: {
        commonDir: text, name: text, outcome: { enum: ["updated", "up-to-date", "skipped", "failed", "uncertain"] }, reason: text, message: text,
        fetches: { type: "array", items: { type: "object", required: ["remote", "outcome"], properties: { remote: text }, oneOf: [
          { properties: { outcome: { const: "updated" } } },
          { required: ["message"], properties: { outcome: { enum: ["failed", "uncertain"] }, message: text } },
        ] } },
        checkouts: { type: "array", items: { type: "object", required: ["path", "branch"], properties: { path: text, branch: { type: ["string", "null"] } }, ...outcome } },
        forkUpstream: { type: "object", oneOf: [
          { required: ["outcome", "reason"], properties: { outcome: { const: "skipped" }, reason: text } },
          { required: ["outcome", "target"], properties: { outcome: { const: "updated" }, target: text } },
          { required: ["outcome", "target", "message"], properties: { outcome: { const: "uncertain" }, target: text, message: text } },
        ] },
      },
      oneOf: [
        { properties: { outcome: { enum: ["updated", "up-to-date"] } } },
        { required: ["reason"], properties: { outcome: { const: "skipped" } } },
        { required: ["message"], properties: { outcome: { enum: ["failed", "uncertain"] } } },
      ],
    } },
  },
};
