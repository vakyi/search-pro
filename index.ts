/**
 * Search Pro Plugin
 * Multi-provider search with content extraction and planning (SearxNG + Tavily + Grok + Exa)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSearchTool } from "./src/search.js";

export default function (api: OpenClawPluginApi) {
  registerSearchTool(api);
  api.logger.info("Search Multi Engine plugin loaded (v2.1.0)");
}
