# Search Multi Engine Plugin for OpenClaw

Multi-provider search plugin using SearxNG (local) with Tavily fallback.

## Features

- **SearxNG** (Primary): Fast, free, local search via your NAS
- **Tavily** (Fallback): API-based search with AI-generated answers
- **Domain Filtering**: Block unwanted domains from results
- **Automatic Failover**: Seamless switch between providers

## Installation

The plugin is installed at: `~/.openclaw/plugins/search-multi-engine/`

## Configuration

### 1. Search Config

Edit `~/.openclaw/search-config.json`:

```json
{
  "primary": "searxng",
  "fallback": "tavily",
  "searxng": {
    "url": "http://192.168.1.100:17788",
    "timeout": 10
  },
  "blockedDomains": []
}
```

### 2. Tavily API Keys (Optional)

For Tavily fallback, create `~/.openclaw/keys/tavily-keys.json`:

```json
{
  "keys": ["your-tavily-api-key-1", "your-tavily-api-key-2"]
}
```

Or set environment variable: `TAVILY_API_KEY`

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

## Usage

Once enabled, the agent can use the `search_pro` tool:

- **query**: Search query string (required)
- **count**: Number of results (1-20, default 5)

## License

MIT
