import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface FetchConfig {
  tavily?: {
    apiKey: string;
    apiUrl: string;
  };
  firecrawl?: {
    apiKey: string;
    apiUrl: string;
  };
}

function getOpenClawDir(): string {
  return (
    process.env.OPENCLAW_SHARED_DIR ||
    process.env.OPENCLAW_HOME ||
    join(homedir(), ".openclaw")
  );
}

async function loadFetchConfig(): Promise<FetchConfig> {
  const configPath = join(getOpenClawDir(), "search-config.json");
  try {
    const content = await readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    return {
      tavily: config.tavily,
      firecrawl: config.firecrawl,
    };
  } catch {
    return {};
  }
}

async function loadTavilyKeys(): Promise<string[]> {
  const keysPath = join(getOpenClawDir(), "keys", "tavily-keys.json");
  try {
    const content = await readFile(keysPath, "utf-8");
    const config = JSON.parse(content);
    return config.keys || [];
  } catch {
    const envKey = process.env.TAVILY_API_KEY;
    return envKey ? [envKey] : [];
  }
}

async function loadFirecrawlKeys(): Promise<string[]> {
  const keysPath = join(getOpenClawDir(), "keys", "firecrawl-keys.json");
  try {
    const content = await readFile(keysPath, "utf-8");
    const config = JSON.parse(content);
    return config.keys || [];
  } catch {
    const envKey = process.env.FIRECRAWL_API_KEY;
    return envKey ? [envKey] : [];
  }
}

async function tavilyExtract(url: string): Promise<string | null> {
  const keys = await loadTavilyKeys();
  if (keys.length === 0) return null;

  const config = await loadFetchConfig();
  const apiUrl = config.tavily?.apiUrl || "https://api.tavily.com";

  for (const apiKey of keys) {
    try {
      const response = await fetch(`${apiUrl}/extract`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          urls: [url],
        }),
      });

      if (response.status === 429) continue;
      if (!response.ok) return null;

      const data = await response.json();
      const results = data.results || [];
      if (results.length > 0) {
        return results[0].raw_content || null;
      }
      return null;
    } catch {
      continue;
    }
  }
  return null;
}

async function firecrawlScrape(url: string): Promise<string | null> {
  const keys = await loadFirecrawlKeys();
  if (keys.length === 0) return null;

  const config = await loadFetchConfig();
  const apiUrl = config.firecrawl?.apiUrl || "https://api.firecrawl.dev/v1";

  for (const apiKey of keys) {
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(`${apiUrl}/scrape`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url,
            formats: ["markdown"],
            timeout: 60000,
            waitFor: (attempt + 1) * 1500,
          }),
        });

        if (response.status === 429) break;
        if (!response.ok) return null;

        const data = await response.json();
        const markdown = data.data?.markdown;
        if (markdown && markdown.trim()) {
          return markdown;
        }
      } catch {
        if (attempt === maxRetries - 1) break;
      }
    }
  }
  return null;
}

export async function webFetch(url: string): Promise<string> {
  let result = await tavilyExtract(url);
  if (result) return result;

  result = await firecrawlScrape(url);
  if (result) return result;

  const tavilyKeys = await loadTavilyKeys();
  const firecrawlKeys = await loadFirecrawlKeys();

  if (tavilyKeys.length === 0 && firecrawlKeys.length === 0) {
    throw new Error(
      "No content extraction service configured. Please set TAVILY_API_KEY or FIRECRAWL_API_KEY",
    );
  }

  throw new Error("Failed to extract content from URL");
}

async function tavilyMap(
  url: string,
  options: {
    instructions?: string;
    maxDepth?: number;
    maxBreadth?: number;
    limit?: number;
    timeout?: number;
  } = {},
): Promise<any> {
  const keys = await loadTavilyKeys();
  if (keys.length === 0) {
    throw new Error("Tavily API key not configured");
  }

  const config = await loadFetchConfig();
  const apiUrl = config.tavily?.apiUrl || "https://api.tavily.com";

  const {
    instructions,
    maxDepth = 1,
    maxBreadth = 20,
    limit = 50,
    timeout = 150,
  } = options;

  for (const apiKey of keys) {
    const body: any = {
      api_key: apiKey,
      url,
      max_depth: maxDepth,
      max_breadth: maxBreadth,
      limit,
      timeout,
    };

    if (instructions) {
      body.instructions = instructions;
    }

    try {
      const response = await fetch(`${apiUrl}/map`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429) continue;

      if (!response.ok) {
        throw new Error(`Tavily map HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        baseUrl: data.base_url,
        results: data.results || [],
        responseTime: data.response_time,
      };
    } catch (err: any) {
      if (keys.indexOf(apiKey) === keys.length - 1) {
        throw new Error(`Tavily map failed: ${err.message}`);
      }
      continue;
    }
  }
  throw new Error("All Tavily API keys exhausted");
}

export async function webMap(
  url: string,
  options: {
    instructions?: string;
    maxDepth?: number;
    maxBreadth?: number;
    limit?: number;
    timeout?: number;
  } = {},
): Promise<any> {
  return tavilyMap(url, options);
}
