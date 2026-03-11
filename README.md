# Search Multi Engine Plugin for OpenClaw

Multi-provider search plugin with intelligent routing and result fusion.

## Features

- **4+ Search Engines**: SearxNG, Tavily, Grok (xAI), Exa
- **Intent Classification**: 7 types (factual/status/comparison/tutorial/exploratory/news/resource)
- **Smart Routing**: Auto-select best engines based on query intent
- **Parallel Search**: Execute multiple engines simultaneously
- **Result Fusion**: Deduplication + scoring + ranking
- **Optional Engines**: Brave and Firecrawl as optional enhancements

## Installation

The plugin is installed at: `~/.openclaw/plugins/search-multi-engine/`

## Configuration

### 1. Search Config

Edit `~/.openclaw/search-config.json`:

```json
{
  "strategy": "parallel",
  "engines": {
    "searxng": {
      "enabled": true,
      "priority": 1,
      "url": "http://192.168.1.100:17788",
      "timeout": 10
    },
    "tavily": {
      "enabled": true,
      "priority": 2
    },
    "grok": {
      "enabled": true,
      "priority": 3,
      "apiUrl": "https://api.x.ai/v1",
      "model": "grok-4.1-fast"
    },
    "exa": {
      "enabled": true,
      "priority": 4
    },
    "brave": {
      "enabled": false,
      "optional": true
    },
    "firecrawl": {
      "enabled": false,
      "optional": true
    }
  },
  "blockedDomains": []
}
```

**Strategy Options**:
- `parallel`: All engines run simultaneously, results merged
- `fallback`: Try engines in priority order (original behavior)
- `smart`: Auto-select engines based on query intent

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

Or use environment variables:
```bash
export TAVILY_API_KEY="your-key"
export GROK_API_KEY="your-key"
export EXA_API_KEY="your-key"
```

### 3. Enable Tool in OpenClaw

Add to agent allowlist:

```json5
{
  agents: {
    list: [
      {
        id: "noah",
        tools: {
          allow: ["search_pro"]
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

Once enabled, the agent can use the `search_pro` tool:

- **query**: Search query string (required)
- **count**: Number of results (1-20, default 5)

## License

MIT
