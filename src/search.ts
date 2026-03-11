import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SessionCache, generateSessionId } from "./session.js";
import { webFetch, webMap } from "./fetch.js";
import { planningEngine, splitCsv } from "./planning.js";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
  publishedDate?: string;
  score?: number;
}

interface SearchResponse {
  source: string;
  results: SearchResult[];
  query: string;
  answer?: string;
  sessionId?: string;
  sourcesCount?: number;
}

type SearchIntent =
  | "factual"
  | "status"
  | "comparison"
  | "tutorial"
  | "exploratory"
  | "news"
  | "resource";
type SearchEngine =
  | "searxng"
  | "tavily"
  | "grok"
  | "exa"
  | "brave"
  | "firecrawl";

interface EngineConfig {
  enabled: boolean;
  priority?: number;
  optional?: boolean;
}

interface SearchConfig {
  strategy: "parallel" | "fallback" | "smart";
  engines: {
    searxng: EngineConfig & { url: string; timeout: number };
    tavily: EngineConfig & { apiUrl?: string };
    grok?: EngineConfig & { apiUrl?: string; model?: string };
    exa?: EngineConfig & { apiUrl?: string };
    brave?: EngineConfig;
    firecrawl?: EngineConfig & { apiUrl?: string };
  };
  blockedDomains: string[];
  authorityDomains?: string[];
  maxConcurrency?: number;
  retryAttempts?: number;
  enableAnswerSynthesis?: boolean;
  enableQueryExpansion?: boolean;
}

const DEFAULT_CONFIG: SearchConfig = {
  strategy: "smart",
  engines: {
    searxng: {
      enabled: true,
      priority: 1,
      url: "http://192.168.1.100:17788",
      timeout: 10,
    },
    tavily: { enabled: true, priority: 2, apiUrl: "https://api.tavily.com" },
    grok: {
      enabled: false,
      priority: 3,
      apiUrl: "https://api.x.ai/v1",
      model: "grok-4.1-fast",
    },
    exa: { enabled: false, priority: 4, apiUrl: "https://api.exa.ai" },
    brave: { enabled: false, optional: true },
    firecrawl: {
      enabled: false,
      optional: true,
      apiUrl: "https://api.firecrawl.dev/v1",
    },
  },
  blockedDomains: [],
  authorityDomains: [
    "github.com",
    "stackoverflow.com",
    "docs.",
    "wikipedia.org",
    "arxiv.org",
    "medium.com",
    "dev.to",
    "reddit.com",
  ],
  maxConcurrency: 3,
  retryAttempts: 2,
  enableAnswerSynthesis: true,
  enableQueryExpansion: false,
};

const INTENT_WEIGHTS: Record<
  SearchIntent,
  { keyword: number; freshness: number; authority: number }
> = {
  factual: { keyword: 0.5, freshness: 0.2, authority: 0.3 },
  status: { keyword: 0.3, freshness: 0.5, authority: 0.2 },
  comparison: { keyword: 0.4, freshness: 0.2, authority: 0.4 },
  tutorial: { keyword: 0.5, freshness: 0.1, authority: 0.4 },
  exploratory: { keyword: 0.3, freshness: 0.2, authority: 0.5 },
  news: { keyword: 0.3, freshness: 0.6, authority: 0.1 },
  resource: { keyword: 0.4, freshness: 0.1, authority: 0.5 },
};

const sessionCache = new SessionCache();

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

async function loadEngineKeys(
  engine: "tavily" | "grok" | "exa",
): Promise<string[]> {
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

  if (/(latest|recent|news|today|this week|最新|最近|今天|本周)/i.test(query))
    return "news";
  if (/(status|current|now|state|当前|现在|状态)/i.test(query)) return "status";
  if (/(vs|versus|compare|difference|better|区别|对比|比较)/i.test(query))
    return "comparison";
  if (/(how to|tutorial|guide|step|教程|如何|怎么)/i.test(query))
    return "tutorial";
  if (/(why|explore|understand|analysis|为什么|探索|分析)/i.test(query))
    return "exploratory";
  if (/(list|collection|resource|awesome|资源|列表|集合)/i.test(query))
    return "resource";

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
  intent: SearchIntent,
  config: SearchConfig,
): number {
  const weights = INTENT_WEIGHTS[intent];
  const queryTerms = query.toLowerCase().split(/\s+/);

  const keywordScore =
    queryTerms.reduce((score, term) => {
      const inTitle = result.title.toLowerCase().includes(term) ? 0.6 : 0;
      const inSnippet = result.snippet.toLowerCase().includes(term) ? 0.4 : 0;
      return score + inTitle + inSnippet;
    }, 0) / queryTerms.length;

  const authorityDomains = config.authorityDomains || [
    "github.com",
    "stackoverflow.com",
    "docs.",
    "wikipedia.org",
  ];
  const authorityScore = authorityDomains.some((d) => result.url.includes(d))
    ? 1
    : 0.5;

  let freshnessScore = 0.5;
  if (result.publishedDate) {
    try {
      const publishedTime = new Date(result.publishedDate).getTime();
      const now = Date.now();
      const daysSincePublished = (now - publishedTime) / (1000 * 60 * 60 * 24);

      if (daysSincePublished < 1) freshnessScore = 1.0;
      else if (daysSincePublished < 7) freshnessScore = 0.9;
      else if (daysSincePublished < 30) freshnessScore = 0.7;
      else if (daysSincePublished < 90) freshnessScore = 0.5;
      else if (daysSincePublished < 365) freshnessScore = 0.3;
      else freshnessScore = 0.1;
    } catch {
      freshnessScore = 0.5;
    }
  }

  return (
    weights.keyword * keywordScore +
    weights.authority * authorityScore +
    weights.freshness * freshnessScore
  );
}

function expandQuery(query: string, intent: SearchIntent): string[] {
  const queries = [query];

  if (intent === "comparison") {
    const vsMatch = query.match(/(.+?)\s+vs\s+(.+)/i);
    if (vsMatch) {
      queries.push(`${vsMatch[1]} advantages`);
      queries.push(`${vsMatch[2]} advantages`);
      queries.push(`${vsMatch[1]} disadvantages`);
      queries.push(`${vsMatch[2]} disadvantages`);
    }
  } else if (intent === "tutorial") {
    queries.push(`${query} step by step`);
    queries.push(`${query} best practices`);
  } else if (intent === "status") {
    queries.push(`${query} latest`);
    queries.push(`${query} current state`);
  }

  return queries.slice(0, 3);
}

function synthesizeAnswers(responses: SearchResponse[]): string | undefined {
  const answers = responses
    .map((r) => r.answer)
    .filter((a): a is string => !!a);

  if (answers.length === 0) return undefined;
  if (answers.length === 1) return answers[0];

  const combined = answers.join("\n\n");
  if (combined.length > 500) {
    return answers[0];
  }

  return combined;
}

function mergeSources(
  responses: SearchResponse[],
): Array<{ url: string; title: string; snippet: string; provider: string }> {
  const sourceMap = new Map<
    string,
    { url: string; title: string; snippet: string; provider: string }
  >();

  responses.forEach((response) => {
    response.results.forEach((result) => {
      const normalized = normalizeUrl(result.url);
      if (!sourceMap.has(normalized)) {
        sourceMap.set(normalized, {
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          provider: result.engine || response.source,
        });
      }
    });
  });

  return Array.from(sourceMap.values());
}

async function searchGrok(
  query: string,
  count: number,
  config: SearchConfig,
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

  const timeKeywords = [
    "current",
    "now",
    "today",
    "latest",
    "recent",
    "当前",
    "现在",
    "今天",
    "最新",
    "最近",
  ];
  const needsTime = timeKeywords.some((k) => query.toLowerCase().includes(k));
  const timeCtx = needsTime
    ? `\n[Current time: ${new Date().toISOString()}]`
    : "";

  const systemPrompt = `You are a search engine. Return ONLY a valid JSON array of search results.${timeCtx}
Format: [{"title": "...", "url": "https://...", "snippet": "...", "published_date": "YYYY-MM-DD"}]
Rules: 1) Valid URLs only 2) No explanations 3) Max ${count} results`;

  for (const apiKey of keys) {
    try {
      const response = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: query },
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
  config: SearchConfig,
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
          useAutoprompt: true,
          type: typeMap[intent],
          numResults: count,
          contents: {
            text: { maxCharacters: 1000 },
            highlights: {
              highlightsPerUrl: 3,
              numSentences: 2,
              maxCharacters: 1200,
            },
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
          snippet:
            (r.highlights && r.highlights.length > 0
              ? r.highlights.join(" ... ")
              : null) ||
            r.text?.substring(0, 500) ||
            r.summary ||
            r.snippet ||
            "No description",
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
  config: SearchConfig,
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
  const timeout = setTimeout(
    () => controller.abort(),
    config.engines.searxng.timeout * 1000,
  );

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
  count: number = 5,
  strategy?: "parallel" | "fallback" | "smart",
): Promise<SearchResponse> {
  const config = await loadConfig();
  const intent = classifyIntent(query);
  const effectiveStrategy = strategy || config.strategy;

  const enabledEngines = Object.entries(config.engines)
    .filter(([_, cfg]) => cfg.enabled && !cfg.optional)
    .sort((a, b) => (a[1].priority || 99) - (b[1].priority || 99));

  if (enabledEngines.length === 0) {
    throw new Error("No search engines enabled");
  }

  if (effectiveStrategy === "parallel") {
    const results = await Promise.allSettled(
      enabledEngines.map(([engine]) => {
        switch (engine) {
          case "searxng":
            return searchSearxNG(query, count, config);
          case "tavily":
            return searchTavily(query, count);
          case "grok":
            return searchGrok(query, count, config);
          case "exa":
            return searchExa(query, count, intent, config);
          default:
            return Promise.reject(new Error(`Unknown engine: ${engine}`));
        }
      }),
    );

    const allResults: SearchResult[] = [];
    const sources: string[] = [];
    const responses: SearchResponse[] = [];

    results.forEach((result) => {
      if (result.status === "fulfilled") {
        allResults.push(...result.value.results);
        sources.push(result.value.source);
        responses.push(result.value);
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
        score: calculateScore(result, query, intent, config),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((item) => item.result);

    const sessionId = generateSessionId();
    const sourcesForCache = mergeSources(responses);
    sessionCache.set(sessionId, sourcesForCache);

    const answer =
      config.enableAnswerSynthesis !== false
        ? synthesizeAnswers(responses)
        : undefined;

    return {
      source: sources.join("+"),
      results: scoredResults,
      query,
      answer,
      sessionId,
      sourcesCount: sourcesForCache.length,
    };
  }

  if (effectiveStrategy === "smart") {
    const engineSelection: Record<SearchIntent, SearchEngine[]> = {
      status: ["grok", "searxng"],
      news: ["grok", "tavily"],
      tutorial: ["exa", "tavily"],
      resource: ["exa", "searxng"],
      comparison: ["exa", "tavily", "searxng"],
      exploratory: ["exa", "grok"],
      factual: ["searxng", "tavily"],
    };

    const selectedEngines = engineSelection[intent]
      .map(
        (e) => [e, config.engines[e as keyof typeof config.engines]] as const,
      )
      .filter(([_, cfg]) => cfg?.enabled && !cfg?.optional);

    if (selectedEngines.length > 0) {
      const results = await Promise.allSettled(
        selectedEngines.map(([engine]) => {
          switch (engine) {
            case "searxng":
              return searchSearxNG(query, count, config);
            case "tavily":
              return searchTavily(query, count);
            case "grok":
              return searchGrok(query, count, config);
            case "exa":
              return searchExa(query, count, intent, config);
            default:
              return Promise.reject(new Error(`Unknown engine: ${engine}`));
          }
        }),
      );

      const allResults: SearchResult[] = [];
      const sources: string[] = [];
      const responses: SearchResponse[] = [];

      results.forEach((result) => {
        if (result.status === "fulfilled") {
          allResults.push(...result.value.results);
          sources.push(result.value.source);
          responses.push(result.value);
        }
      });

      if (allResults.length > 0) {
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
            score: calculateScore(result, query, intent, config),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, count)
          .map((item) => item.result);

        const sessionId = generateSessionId();
        const sourcesForCache = mergeSources(responses);
        sessionCache.set(sessionId, sourcesForCache);

        const answer =
          config.enableAnswerSynthesis !== false
            ? synthesizeAnswers(responses)
            : undefined;

        return {
          source: sources.join("+"),
          results: scoredResults,
          query,
          answer,
          sessionId,
          sourcesCount: sourcesForCache.length,
        };
      }
    }
  }

  for (const [engine] of enabledEngines) {
    try {
      switch (engine) {
        case "searxng":
          return await searchSearxNG(query, count, config);
        case "tavily":
          return await searchTavily(query, count);
        case "grok":
          return await searchGrok(query, count, config);
        case "exa":
          return await searchExa(query, count, intent, config);
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
        "Multi-provider search with intelligent routing. Supports SearxNG, Tavily, Grok (xAI), and Exa. Auto-classifies query intent and selects optimal engines. Returns deduplicated, scored results. Strategy options: 'smart' (default, intent-based), 'parallel' (all engines), 'fallback' (priority order).",
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
          strategy: {
            type: "string",
            enum: ["smart", "parallel", "fallback"],
            description:
              "Search strategy: 'smart' (intent-based engine selection), 'parallel' (all engines simultaneously), 'fallback' (try engines in priority order). Defaults to config or 'smart'.",
          },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        const {
          query,
          count = 5,
          strategy,
        } = params as {
          query: string;
          count?: number;
          strategy?: "parallel" | "fallback" | "smart";
        };

        try {
          const result = await search(query, count, strategy);

          let text = `🔍 Search Results (${result.source}):\n\n`;

          if (result.sessionId) {
            text += `📦 Session ID: ${result.sessionId}\n`;
            text += `📚 Total Sources: ${result.sourcesCount || 0}\n`;
            text += `💡 Use get_sources tool with this session ID to retrieve all cached sources\n\n`;
          }

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
    { optional: true },
  );

  api.registerTool(
    {
      name: "web_fetch",
      description:
        "Fetches and extracts complete content from a URL, returning it as structured Markdown. Supports Tavily and Firecrawl extraction services. Maintains 100% content fidelity without summarization.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Valid HTTP/HTTPS web address. Must be complete and accessible.",
          },
        },
        required: ["url"],
      },
      async execute(_id, params) {
        const { url } = params as { url: string };

        try {
          const content = await webFetch(url);
          return {
            content: [
              {
                type: "text",
                text: content,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Fetch error: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "web_map",
      description:
        "Maps a website's structure by traversing it like a graph, discovering URLs and generating a comprehensive site map. Supports depth and breadth control with natural language filtering.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Root URL to begin mapping (e.g., 'https://docs.example.com')",
          },
          instructions: {
            type: "string",
            description:
              "Natural language instructions to filter or focus on specific content",
          },
          maxDepth: {
            type: "number",
            description: "Maximum depth of mapping from base URL (1-5, default 1)",
            minimum: 1,
            maximum: 5,
          },
          maxBreadth: {
            type: "number",
            description:
              "Maximum number of links to follow per page (1-500, default 20)",
            minimum: 1,
            maximum: 500,
          },
          limit: {
            type: "number",
            description:
              "Total number of links to process before stopping (1-500, default 50)",
            minimum: 1,
            maximum: 500,
          },
          timeout: {
            type: "number",
            description:
              "Maximum time in seconds for the operation (10-150, default 150)",
            minimum: 10,
            maximum: 150,
          },
        },
        required: ["url"],
      },
      async execute(_id, params) {
        const {
          url,
          instructions,
          maxDepth,
          maxBreadth,
          limit,
          timeout,
        } = params as {
          url: string;
          instructions?: string;
          maxDepth?: number;
          maxBreadth?: number;
          limit?: number;
          timeout?: number;
        };

        try {
          const result = await webMap(url, {
            instructions,
            maxDepth,
            maxBreadth,
            limit,
            timeout,
          });

          let text = `🗺️ Site Map for ${result.baseUrl}\n\n`;
          text += `Found ${result.results.length} pages\n`;
          text += `Response time: ${result.responseTime}ms\n\n`;

          result.results.forEach((page: any, i: number) => {
            text += `${i + 1}. ${page.title || "Untitled"}\n`;
            text += `   URL: ${page.url}\n`;
            if (page.description) {
              text += `   ${page.description.substring(0, 150)}...\n`;
            }
            text += `\n`;
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
                text: `❌ Map error: ${err.message}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "get_sources",
      description:
        "Retrieve cached sources from a previous search_pro call using the session ID. Returns the full list of sources with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID from previous search_pro call",
          },
        },
        required: ["sessionId"],
      },
      async execute(_id, params) {
        const { sessionId } = params as { sessionId: string };

        const sources = sessionCache.get(sessionId);
        if (!sources) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Session not found or expired: ${sessionId}`,
              },
            ],
            isError: true,
          };
        }

        let text = `📚 Sources for session ${sessionId}:\n\n`;
        text += `Found ${sources.length} sources\n\n`;

        sources.forEach((source, i) => {
          text += `${i + 1}. ${source.title || "Untitled"}\n`;
          text += `   URL: ${source.url}\n`;
          text += `   Provider: ${source.provider}\n`;
          if (source.snippet) {
            text += `   ${source.snippet.substring(0, 150)}...\n`;
          }
          text += `\n`;
        });

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      },
    },
    { optional: true },
  );
}
