# Search Multi Engine Plugin for OpenClaw

Multi-provider search plugin with intelligent routing, content extraction, and advanced search planning.

## Features

- **4+ Search Engines**: SearxNG, Tavily, Grok (xAI), Exa
- **Intent Classification**: 7 types (factual/status/comparison/tutorial/exploratory/news/resource)
- **Smart Routing**: Auto-select best engines based on query intent
- **Parallel Search**: Execute multiple engines simultaneously
- **Result Fusion**: Deduplication + scoring + ranking
- **Answer Synthesis**: Combine answers from multiple engines
- **Session Management**: Cache sources for later retrieval
- **Content Extraction**: web_fetch tool for URL → Markdown conversion
- **Site Mapping**: web_map tool for website structure exploration
- **Search Planning**: 6-phase planning system for complex queries
- **Dynamic Scoring**: Time-aware freshness scoring and configurable authority domains
- **Optional Engines**: Brave and Firecrawl as optional enhancements

## Tools

### search_pro
Multi-provider search with intelligent routing. Returns deduplicated, scored results with session management.

**Parameters:**
- `query` (required): Search query string
- `count` (optional): Number of results (1-20, default 5)
- `strategy` (optional): Search strategy - 'smart' (default), 'parallel', or 'fallback'

**Returns:**
- Search results with titles, URLs, and snippets
- Session ID for retrieving cached sources
- Synthesized answer (if available)
- Total sources count

### web_fetch
Fetches and extracts complete content from a URL as Markdown.

**Parameters:**
- `url` (required): Valid HTTP/HTTPS web address

**Returns:**
- Structured Markdown content

### web_map
Maps a website's structure by graph traversal.

**Parameters:**
- `url` (required): Root URL to begin mapping
- `instructions` (optional): Natural language filtering instructions
- `maxDepth` (optional): Maximum depth (1-5, default 1)
- `maxBreadth` (optional): Links per page (1-500, default 20)
- `limit` (optional): Total links to process (1-500, default 50)
- `timeout` (optional): Operation timeout in seconds (10-150, default 150)

**Returns:**
- Site map with discovered pages and metadata

### get_sources
Retrieve cached sources from a previous search using session ID.

**Parameters:**
- `sessionId` (required): Session ID from search_pro

**Returns:**
- Full list of sources with titles, URLs, snippets, and providers

## Installation

The plugin is installed at: `~/.openclaw/plugins/search-multi-engine/`

## Configuration

### 1. Search Config

Edit `~/.openclaw/search-config.json`:

```json
{
  "strategy": "smart",
  "engines": {
    "searxng": {
      "enabled": true,
      "priority": 1,
      "url": "http://192.168.1.100:17788",
      "timeout": 10
    },
    "tavily": {
      "enabled": true,
      "priority": 2,
      "apiUrl": "https://api.tavily.com"
    },
    "grok": {
      "enabled": true,
      "priority": 3,
      "apiUrl": "https://api.x.ai/v1",
      "model": "grok-4.1-fast"
    },
    "exa": {
      "enabled": true,
      "priority": 4,
      "apiUrl": "https://api.exa.ai"
    },
    "brave": {
      "enabled": false,
      "optional": true
    },
    "firecrawl": {
      "enabled": false,
      "optional": true,
      "apiUrl": "https://api.firecrawl.dev/v1"
    }
  },
  "blockedDomains": [],
  "authorityDomains": [
    "github.com",
    "stackoverflow.com",
    "docs.",
    "wikipedia.org",
    "arxiv.org",
    "medium.com",
    "dev.to",
    "reddit.com"
  ],
  "maxConcurrency": 3,
  "retryAttempts": 2,
  "enableAnswerSynthesis": true,
  "enableQueryExpansion": false
}
```

**Configuration Options:**
- `strategy`: Search strategy - 'parallel', 'fallback', or 'smart'
- `engines`: Engine-specific configuration with priority and optional settings
- `blockedDomains`: Domains to exclude from results
- `authorityDomains`: Domains to boost in scoring
- `maxConcurrency`: Maximum concurrent engine requests
- `retryAttempts`: Number of retry attempts for failed requests
- `enableAnswerSynthesis`: Combine answers from multiple engines
- `enableQueryExpansion`: Automatically expand queries based on intent

### 2. API Keys

Create key files in `~/.openclaw/keys/`:

**Tavily**: `tavily-keys.json`
```json
{
  "keys": ["your-tavily-api-key"]
}
```

**Grok**: `grok-keys.json`
```json
{
  "keys": ["your-grok-api-key"]
}
```

**Exa**: `exa-keys.json`
```json
{
  "keys": ["your-exa-api-key"]
}
```

**Firecrawl** (optional, for web_fetch): `firecrawl-keys.json`
```json
{
  "keys": ["your-firecrawl-api-key"]
}
```

**Multiple Keys** (for rate limit rotation):

All services support multiple keys with automatic rotation on rate limits (HTTP 429):

```json
{
  "keys": [
    "your-api-key-1",
    "your-api-key-2",
    "your-api-key-3"
  ]
}
```

Or use environment variables:
```bash
export TAVILY_API_KEY="your-key"
export GROK_API_KEY="your-key"
export EXA_API_KEY="your-key"
export FIRECRAWL_API_KEY="your-key"  # optional
```

### 3. Enable Tools in OpenClaw

Add to agent allowlist:

```json5
{
  agents: {
    list: [
      {
        id: "noah",
        tools: {
          allow: ["search_pro", "web_fetch", "web_map", "get_sources"]
        }
      }
    ]
  }
}
```

## Intent Classification

The plugin automatically classifies queries:

- **factual**: Direct facts (e.g., "What is X?")
- **status**: Current state (e.g., "Latest version of Y")
- **comparison**: Compare options (e.g., "X vs Y")
- **tutorial**: How-to guides (e.g., "How to do Z")
- **exploratory**: Deep research (e.g., "Why does X happen?")
- **news**: Recent events (e.g., "Latest news about X")
- **resource**: Collections (e.g., "List of X tools")

## Engine Characteristics

- **SearxNG**: Fast, free, local metasearch
- **Tavily**: AI-powered with answer generation
- **Grok**: Real-time knowledge, authority sources
- **Exa**: Semantic search, technical content
- **Brave** (optional): Privacy-focused web search
- **Firecrawl** (optional): Advanced content extraction

## Usage

The agent can use these tools:

### search_pro
```javascript
// Basic search
search_pro({ query: "React vs Vue", count: 5 })

// With strategy
search_pro({ query: "latest AI news", strategy: "parallel" })
```

### web_fetch
```javascript
// Extract content from URL
web_fetch({ url: "https://example.com/article" })
```

### web_map
```javascript
// Map website structure
web_map({
  url: "https://docs.example.com",
  maxDepth: 2,
  limit: 100
})
```

### get_sources
```javascript
// Retrieve cached sources from previous search
get_sources({ sessionId: "sess_1234567890_abc" })
```

## Advanced Features

### Answer Synthesis
When multiple engines return answers, the plugin automatically combines them into a coherent response.

### Session Management
Each search creates a session with cached sources. Use `get_sources` to retrieve the full list of sources later.

### Dynamic Freshness Scoring
Results are scored based on publication date:
- < 1 day: 1.0
- < 7 days: 0.9
- < 30 days: 0.7
- < 90 days: 0.5
- < 365 days: 0.3
- > 365 days: 0.1

### Configurable Authority Domains
Customize which domains receive higher authority scores in the configuration.

### Query Expansion (Optional)
When enabled, automatically expands queries based on intent:
- Comparison: Adds "advantages" and "disadvantages" queries
- Tutorial: Adds "step by step" and "best practices"
- Status: Adds "latest" and "current state"

## License

MIT
