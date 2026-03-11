import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

interface SearchResponse {
  source: string;
  results: SearchResult[];
  query: string;
  answer?: string;
}

interface SearchConfig {
  primary: "searxng" | "tavily";
  fallback: "searxng" | "tavily";
  searxng: {
    url: string;
    timeout: number;
  };
  blockedDomains: string[];
}

const DEFAULT_CONFIG: SearchConfig = {
  primary: "searxng",
  fallback: "tavily",
  searxng: {
    url: "http://192.168.1.100:17788",
    timeout: 10,
  },
  blockedDomains: [],
};

function getConfigPath(): string {
  return join(homedir(), ".openclaw", "search-config.json");
}

async function loadConfig(): Promise<SearchConfig> {
  try {
    const content = await readFile(getConfigPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function loadTavilyKeys(): Promise<string[]> {
  const keysPath = join(homedir(), ".openclaw", "keys", "tavily-keys.json");
  try {
    const content = await readFile(keysPath, "utf-8");
    const config = JSON.parse(content);
    return config.keys || [];
  } catch {
    if (process.env.TAVILY_API_KEY) {
      return [process.env.TAVILY_API_KEY];
    }
    return [];
  }
}

async function searchSearxNG(
  query: string,
  count: number,
  config: SearchConfig
): Promise<SearchResponse> {
  const url = new URL(`${config.searxng.url}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("categories", "general");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.searxng.timeout * 1000);

  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "OpenClaw-Search/1.0",
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`SearxNG HTTP ${response.status}`);
    }

    const data = await response.json();

    const blockedDomains = config.blockedDomains || [];
    const filteredResults = (data.results || []).filter((r: any) => {
      const url = r.url || r.pretty_url || "";
      return !blockedDomains.some((domain) => url.includes(domain));
    });

    return {
      source: "searxng",
      results: filteredResults.slice(0, count).map((r: any) => ({
        title: r.title || "No title",
        url: r.url || r.pretty_url,
        snippet: r.content || r.abstract || "No description",
        engine: r.engine,
      })),
      query,
    };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function searchTavily(
  query: string,
  count: number,
  keys: string[]
): Promise<SearchResponse> {
  if (keys.length === 0) {
    throw new Error("No Tavily API keys configured");
  }

  for (const apiKey of keys) {
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          include_answer: true,
          include_raw_content: false,
          max_results: Math.min(Math.max(parseInt(String(count)) || 5, 1), 20),
        }),
      });

      if (response.status === 429) {
        continue;
      }

      if (!response.ok) {
        throw new Error(`Tavily HTTP ${response.status}`);
      }

      const data = await response.json();

      return {
        source: "tavily",
        answer: data.answer,
        results: (data.results || []).map((r: any) => ({
          title: r.title,
          url: r.url,
          snippet: r.content || r.snippet,
          engine: "tavily",
        })),
        query,
      };
    } catch (err: any) {
      console.error(`Tavily key failed: ${err.message}`);
    }
  }

  throw new Error("All Tavily API keys exhausted");
}

export async function search(
  query: string,
  count: number = 5
): Promise<SearchResponse> {
  const config = await loadConfig();
  const tavilyKeys = await loadTavilyKeys();

  if (config.primary === "searxng") {
    try {
      return await searchSearxNG(query, count, config);
    } catch (err: any) {
      console.error(`SearxNG failed: ${err.message}`);
      if (config.fallback === "tavily" && tavilyKeys.length > 0) {
        console.error("Falling back to Tavily...");
        return await searchTavily(query, count, tavilyKeys);
      }
      throw err;
    }
  }

  return await searchTavily(query, count, tavilyKeys);
}

export function registerSearchTool(api: OpenClawPluginApi) {
  api.registerTool(
    {
      name: "search_pro",
      description:
        "Multi-provider search using SearxNG (local) with Tavily fallback. Returns search results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query string",
          },
          count: {
            type: "number",
            description: "Number of results to return (1-20, default 5)",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        const { query, count = 5 } = params as { query: string; count?: number };

        try {
          const result = await search(query, count);

          let text = `🔍 Search Results (${result.source}):\n\n`;

          if (result.answer) {
            text += `📋 Answer: ${result.answer}\n\n`;
          }

          result.results.forEach((r, i) => {
            text += `${i + 1}. ${r.title}\n`;
            text += `   URL: ${r.url}\n`;
            text += `   ${r.snippet?.substring(0, 200) || "No snippet"}...\n\n`;
          });

          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Search error: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    { optional: true }
  );
}
