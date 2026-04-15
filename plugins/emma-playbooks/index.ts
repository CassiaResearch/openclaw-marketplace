import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default {
  id: "emma-playbooks",
  name: "Emma's Playbooks",
  description:
    "Plugin library of skills/playbooks for Emma to use and refer to to do her work as an SDR.",

  register(_api: OpenClawPluginApi) {
    // Skill-only plugin. Skills are declared in openclaw.plugin.json's
    // `skills` array and discovered by the loader from there. No runtime
    // hooks, tools, or channels to register.
  },
};
