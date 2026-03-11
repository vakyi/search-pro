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

type SearchIntent = "factual" | "status" | "comparison" | "tutorial" | "exploratory" | "news" | "resource";
type SearchEngine = "searxng" | "tavily" | "grok" | "exa" | "brave" | "firecrawl";

interface EngineConfig {
  enabled: boolean;
  priority?: number;
  optional?: boolean;
}

interface SearchConfig {
  strategy: "parallel" | "fallback" | "smart";
  engines: {
    searxng: EngineConfig & { url: string; timeout: number };
    tavily: EngineConfig;
    grok?: EngineConfig & { apiUrl?: string; model?: string };
    exa?: EngineConfig & { apiUrl?: string };
    brave?: EngineConfig;
    firecrawl?: EngineConfig;
  };
  blockedDomains: string[];
}

const DEFAULT_CONFIG: SearchConfig = {
  strategy: "smart",
  engines: {
    searxng: { enabled: true, priority: 1, url: "http://192.168.1.100:17788", timeout: 10 },
    tavily: { enabled: true, priority: 2 },
    grok: { enabled: false, priority: 3, apiUrl: "https://api.x.ai/v1", model: "grok-4.1-fast" },
    exa: { enabled: false, priority: 4 },
    brave: { enabled: false, optional: true },
    firecrawl: { enabled: false, optional: true },
  },
  blockedDomains: [],
};

const INTENT_WEIGHTS: Record<SearchIntent, { keyword: number; freshness: number; authority: number }> = {
  factual: { keyword: 0.5, freshness: 0.2, authority: 0.3 },
  status: { keyword: 0.3, freshness: 0.5, authority: 0.2 },
  comparison: { keyword: 0.4, freshness: 0.2, authority: 0.4 },
  tutorial: { keyword: 0.5, freshness: 0.1, authority: 0.4 },
  exploratory: { keyword: 0.3, freshness: 0.2, authority: 0.5 },
  news: { keyword: 0.3, freshness: 0.6, authority: 0.1 },
  resource: { keyword: 0.4, freshness: 0.1, authority: 0.5 },
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

async function loadEngineKeys(engine: "tavily" | "grok" | "exa"): Promise<string[]> {
  const keysPath = join(homedir(), ".openclaw", "keys", `${engine}-keys.json`);
  try {
    const content = await readFile(keysPath, "utf-8");
    const config = JSON.parse(content);
    return config.keys || [];
  } catch {
    const envKey = process.env[`${engine.toUpperCase()}_API_KEY`];
    return envKey ? [envKey] : [];
  }
}

function classifyIntent(query: string): SearchIntent {
  const lowerQuery = query.toLowerCase();

  if (/(latest|recent|news|today|this week|最新|最近|今天|本周)/i.test(query)) return "news";
  if (/(status|current|now|state|当前|现在|状态)/i.test(query)) return "status";
  if (/(vs|versus|compare|difference|better|区别|对比|比较)/i.test(query)) return "comparison";
  if (/(how to|tutorial|guide|step|教程|如何|怎么)/i.test(query)) return "tutorial";
  if (/(why|explore|understand|analysis|为什么|探索|分析)/i.test(query)) return "exploratory";
  if (/(list|collection|resource|awesome|资源|列表|集合)/i.test(query)) return "resource";

  return "factual";
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = parsed.search.replace(/[?&](utm_|ref=|source=)[^&]*/g, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function calculateScore(
  result: SearchResult,
  query: string,
  intent: SearchIntent
): number {
  const weights = INTENT_WEIGHTS[intent];
  const queryTerms = query.toLowerCase().split(/\s+/);

  const keywordScore = queryTerms.reduce((score, term) => {
    const inTitle = result.title.toLowerCase().includes(term) ? 0.6 : 0;
    const inSnippet = result.snippet.toLowerCase().includes(term) ? 0.4 : 0;
    return score + inTitle + inSnippet;
  }, 0) / queryTerms.length;

  const authorityDomains = ["github.com", "stackoverflow.com", "docs.", "wikipedia.org"];
  const authorityScore = authorityDomains.some(d => result.url.includes(d)) ? 1 : 0.5;

  const freshnessScore = 0.5;

  return (
    weights.keyword * keywordScore +
    weights.authority * authorityScore +
    weights.freshness * freshnessScore
  );
}

async function searchGrok(
  query: string,
  count: number,
  config: SearchConfig
): Promise<SearchResponse> {
  if (!config.engines.grok?.enabled) {
    throw new Error("Grok engine not enabled");
  }

  const keys = await loadEngineKeys("grok");
  if (keys.length === 0) {
    throw new Error("No Grok API keys configured");
  }

  const apiUrl = config.engines.grok.apiUrl || "https://api.x.ai/v1";
  const model = config.engines.grok.model || "grok-4.1-fast";

  const timeKeywords = ["current", "now", "today", "latest", "recent", "当前", "现在", "今天", "最新", "最近"];
  const needsTime = timeKeywords.some(k => query.toLowerCase().includes(k));
  const timeCtx = needsTime ? `\n[Current time: ${new Date().toISOString()}]` : "";

  const systemPrompt = `You are a search engine. Return ONLY a valid JSON array of search results.${timeCtx}
Format: [{"title": "...", "url": "https://...", "snippet": "...", "published_date": "YYYY-MM-DD"}]
Rules: 1) Valid URLs only 2) No explanations 3) Max ${count} results`;

  for (const apiKey of keys) {
    try {
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `<query>${query}</query>` },
          ],
        }),
      });

      if (response.status === 429) continue;
      if (!response.ok) throw new Error(`Grok HTTP ${response.status}`);

      const data = await response.json();
      let content = data.choices?.[0]?.message?.content || "";

      content = content.replace(/<think>[\s\S]*?<\/think>/g, "");
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array in response");

      const results = JSON.parse(jsonMatch[0]);

      return {
        source: "grok",
        results: results.slice(0, count).map((r: any) => ({
          title: r.title || "No title",
          url: r.url,
          snippet: r.snippet || r.content || "No description",
          engine: "grok",
        })),
        query,
      };
    } catch (err: any) {
      console.error(`Grok key failed: ${err.message}`);
    }
  }

  throw new Error("All Grok API keys exhausted");
}

async function searchExa(
  query: string,
  count: number,
  intent: SearchIntent,
  config: SearchConfig
): Promise<SearchResponse> {
  const keys = await loadEngineKeys("exa");
  if (keys.length === 0) {
    throw new Error("No Exa API keys configured");
  }

  const apiUrl = config.engines.exa?.apiUrl || "https://api.exa.ai";

  const typeMap: Record<SearchIntent, string> = {
    resource: "instant",
    status: "fast",
    news: "fast",
    exploratory: "deep",
    comparison: "deep",
    factual: "auto",
    tutorial: "auto",
  };

  for (const apiKey of keys) {
    try {
      const response = await fetch(`${apiUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          type: typeMap[intent],
          numResults: count,
          contents: {
            highlights: { maxCharacters: 1200 },
          },
        }),
      });

      if (response.status === 429) continue;
      if (!response.ok) throw new Error(`Exa HTTP ${response.status}`);

      const data = await response.json();

      return {
        source: "exa",
        results: (data.results || []).map((r: any) => ({
          title: r.title || "No title",
          url: r.url,
          snippet: r.highlights?.[0] || r.text || r.summary || r.snippet || "No description",
          engine: "exa",
        })),
        query,
      };
    } catch (err: any) {
      console.error(`Exa key failed: ${err.message}`);
    }
  }

  throw new Error("All Exa API keys exhausted");
}

async function searchSearxNG(
  query: string,
  count: number,
  config: SearchConfig
): Promise<SearchResponse> {
  if (!config.engines.searxng.enabled) {
    throw new Error("SearxNG engine not enabled");
  }

  const url = new URL(`${config.engines.searxng.url}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-CN");
  url.searchParams.set("safesearch", "0");
  url.searchParams.set("categories", "general");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.engines.searxng.timeout * 1000);

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
  count: number
): Promise<SearchResponse> {
  const keys = await loadEngineKeys("tavily");
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
  const intent = classifyIntent(query);

  const enabledEngines = Object.entries(config.engines)
    .filter(([_, cfg]) => cfg.enabled && !cfg.optional)
    .sort((a, b) => (a[1].priority || 99) - (b[1].priority || 99));

  if (enabledEngines.length === 0) {
    throw new Error("No search engines enabled");
  }

  if (config.strategy === "parallel") {
    const results = await Promise.allSettled(
      enabledEngines.map(([engine]) => {
        switch (engine) {
          case "searxng": return searchSearxNG(query, count, config);
          case "tavily": return searchTavily(query, count);
          case "grok": return searchGrok(query, count, config);
          case "exa": return searchExa(query, count, intent, config);
          default: return Promise.reject(new Error(`Unknown engine: ${engine}`));
        }
      })
    );

    const allResults: SearchResult[] = [];
    const sources: string[] = [];

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        allResults.push(...result.value.results);
        sources.push(result.value.source);
      }
    });

    if (allResults.length === 0) {
      throw new Error("All search engines failed");
    }

    const urlMap = new Map<string, SearchResult>();
    allResults.forEach((result) => {
      const normalized = normalizeUrl(result.url);
      if (!urlMap.has(normalized)) {
        urlMap.set(normalized, result);
      }
    });

    const dedupedResults = Array.from(urlMap.values());
    const scoredResults = dedupedResults
      .map((result) => ({
        result,
        score: calculateScore(result, query, intent),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((item) => item.result);

    return {
      source: sources.join("+"),
      results: scoredResults,
      query,
    };
  }

  for (const [engine] of enabledEngines) {
    try {
      switch (engine) {
        case "searxng": return await searchSearxNG(query, count, config);
        case "tavily": return await searchTavily(query, count);
        case "grok": return await searchGrok(query, count, config);
        case "exa": return await searchExa(query, count, intent, config);
      }
    } catch (err: any) {
      console.error(`${engine} failed: ${err.message}`);
    }
  }

  throw new Error("All search engines failed");
}

export function registerSearchTool(api: OpenClawPluginApi) {
  api.registerTool(
    {
      name: "search_pro",
      description:
        "Multi-provider search with intelligent routing. Supports SearxNG, Tavily, Grok (xAI), and Exa. Auto-classifies query intent and selects optimal engines. Returns deduplicated, scored results.",
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
            if (r.engine) {
              text += `   Source: ${r.engine}\n`;
            }
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
