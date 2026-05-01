// All Instantly-related custom tools live here. They extend the existing
// `instantly` Composio toolkit (so they inherit Instantly's managed auth) —
// they are NOT a new custom toolkit.
import { replyTool } from "./reply.js";

export const instantlyTools = [replyTool];
