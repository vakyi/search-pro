interface SourceItem {
  url: string;
  title?: string;
  snippet?: string;
  provider: string;
}

interface SessionData {
  sources: SourceItem[];
  timestamp: number;
}

export class SessionCache {
  private cache: Map<string, SessionData> = new Map();
  private maxSize: number;
  private ttl: number;

  constructor(maxSize: number = 256, ttl: number = 3600000) {
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  set(sessionId: string, sources: SourceItem[]): void {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(sessionId, { sources, timestamp: Date.now() });
  }

  get(sessionId: string): SourceItem[] | null {
    const data = this.cache.get(sessionId);
    if (!data) return null;
    if (Date.now() - data.timestamp > this.ttl) {
      this.cache.delete(sessionId);
      return null;
    }
    return data.sources;
  }

  clear(): void {
    this.cache.clear();
  }
}

export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
