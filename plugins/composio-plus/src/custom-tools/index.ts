// Aggregate all custom tools defined in this plugin and pass them through to
// the Composio session at build time. Tools are grouped by toolkit in
// subdirectories (e.g. ./instantly/, ./hubspot/).
//
// To add a new custom tool:
//   1. Create or pick a toolkit subdirectory under src/custom-tools/.
//   2. Add a new file with an `experimental_createTool(...)` definition.
//   3. Re-export it from that toolkit's index.ts.
//   4. Import the toolkit's array below and spread it into `customTools`.
//
// `customToolkits` is for tools that DON'T extend an existing Composio toolkit
// (i.e., a brand-new logical toolkit you're authoring). Tools using
// `extendsToolkit: "<composio-toolkit>"` go in `customTools` only.
import { instantlyTools } from "./instantly/index.js";

export const customTools = [...instantlyTools];

export const customToolkits: never[] = [];
