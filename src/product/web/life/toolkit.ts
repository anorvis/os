import type { ToolkitTool } from "../../../platform/toolkit/schema";

const EmptyParameters = { type: "object", properties: {}, required: [], additionalProperties: false };

export const lifeToolkitTools = [
  {
    id: "life_snapshot.read",
    name: "anorvis_read_life_snapshot",
    label: "Read Life Snapshot",
    description: "Read the current Life dashboard snapshot from Anorvis OS.",
    domain: "life",
    operation: "read",
    resource: "life_snapshot",
    mutates: false,
    method: "GET",
    path: "/v1/life/snapshot",
    parameters: EmptyParameters,
  },
] satisfies ToolkitTool[];
