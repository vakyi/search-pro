/**
 * Search Pro Plugin
 * Multi-provider search using SearxNG (local) with Tavily fallback
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSearchTool } from "./src/search.js";

export default function (api: OpenClawPluginApi) {
  // Register the search tool as optional (opt-in via allowlist)
  registerSearchTool(api);

  api.logger.info("Search Multi Engine plugin loaded");
}
