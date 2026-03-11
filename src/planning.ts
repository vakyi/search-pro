type QueryType = "factual" | "comparative" | "exploratory" | "analytical";
type TimeSensitivity = "realtime" | "recent" | "historical" | "irrelevant";
type ComplexityLevel = 1 | 2 | 3;

interface IntentAnalysis {
  coreQuestion: string;
  queryType: QueryType;
  timeSensitivity: TimeSensitivity;
  domain?: string;
  premiseValid?: boolean;
  ambiguities?: string[];
  unverifiedTerms?: string[];
}

interface ComplexityAssessment {
  level: ComplexityLevel;
  estimatedSubQueries: number;
  estimatedToolCalls: number;
  justification: string;
}

interface SubQuery {
  id: string;
  goal: string;
  expectedOutput: string;
  toolHint?: string;
  boundary: string;
  dependsOn?: string[];
}

interface SearchTerm {
  term: string;
  purpose: string;
  round: number;
}

interface SearchStrategy {
  approach: "broad_first" | "narrow_first" | "targeted";
  searchTerms: SearchTerm[];
  fallbackPlan?: string;
}

interface ToolMapping {
  subQueryId: string;
  tool: "web_search" | "web_fetch" | "web_map";
  reason: string;
  params?: Record<string, any>;
}

interface ExecutionOrder {
  parallel: string[][];
  sequential: string[];
  estimatedRounds: number;
}

interface PhaseRecord {
  phase: string;
  thought: string;
  data: any;
  confidence: number;
}

const PHASE_NAMES = [
  "intent_analysis",
  "complexity_assessment",
  "query_decomposition",
  "search_strategy",
  "tool_selection",
  "execution_order",
] as const;

const REQUIRED_PHASES: Record<ComplexityLevel, Set<string>> = {
  1: new Set([
    "intent_analysis",
    "complexity_assessment",
    "query_decomposition",
  ]),
  2: new Set([
    "intent_analysis",
    "complexity_assessment",
    "query_decomposition",
    "search_strategy",
    "tool_selection",
  ]),
  3: new Set(PHASE_NAMES),
};

class PlanningSession {
  sessionId: string;
  phases: Map<string, PhaseRecord> = new Map();
  complexityLevel: ComplexityLevel | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  get completedPhases(): string[] {
    return PHASE_NAMES.filter((p) => this.phases.has(p));
  }

  requiredPhases(): Set<string> {
    return REQUIRED_PHASES[this.complexityLevel || 3];
  }

  isComplete(): boolean {
    if (this.complexityLevel === null) return false;
    const required = this.requiredPhases();
    return Array.from(required).every((p) => this.phases.has(p));
  }

  buildExecutablePlan(): Record<string, any> {
    const plan: Record<string, any> = {};
    this.phases.forEach((record, name) => {
      plan[name] = record.data;
    });
    return plan;
  }
}

export class PlanningEngine {
  private sessions: Map<string, PlanningSession> = new Map();

  getSession(sessionId: string): PlanningSession | null {
    return this.sessions.get(sessionId) || null;
  }

  processPhase(
    phase: string,
    thought: string,
    sessionId: string = "",
    isRevision: boolean = false,
    confidence: number = 1.0,
    phaseData: any = null,
  ): any {
    let session: PlanningSession;

    if (sessionId && this.sessions.has(sessionId)) {
      session = this.sessions.get(sessionId)!;
    } else {
      const sid = sessionId || this.generateSessionId();
      session = new PlanningSession(sid);
      this.sessions.set(sid, session);
    }

    if (!PHASE_NAMES.includes(phase as any)) {
      return {
        error: `Unknown phase: ${phase}. Valid: ${PHASE_NAMES.join(", ")}`,
      };
    }

    const accumulativePhases = new Set([
      "query_decomposition",
      "tool_selection",
    ]);
    const mergeStrategyPhase = "search_strategy";

    if (accumulativePhases.has(phase)) {
      if (isRevision) {
        session.phases.set(phase, {
          phase,
          thought,
          data: Array.isArray(phaseData) ? phaseData : [phaseData],
          confidence,
        });
      } else {
        const existing = session.phases.get(phase);
        if (existing && Array.isArray(existing.data)) {
          existing.data.push(phaseData);
          existing.thought = thought;
          existing.confidence = confidence;
        } else {
          session.phases.set(phase, {
            phase,
            thought,
            data: [phaseData],
            confidence,
          });
        }
      }
    } else if (phase === mergeStrategyPhase) {
      const existing = session.phases.get(phase);
      if (isRevision) {
        session.phases.set(phase, { phase, thought, data: phaseData, confidence });
      } else if (
        existing &&
        typeof existing.data === "object" &&
        typeof phaseData === "object"
      ) {
        if (!existing.data.searchTerms) existing.data.searchTerms = [];
        if (phaseData.searchTerms) {
          existing.data.searchTerms.push(...phaseData.searchTerms);
        }
        if (phaseData.approach) existing.data.approach = phaseData.approach;
        if (phaseData.fallbackPlan)
          existing.data.fallbackPlan = phaseData.fallbackPlan;
        existing.thought = thought;
        existing.confidence = confidence;
      } else {
        session.phases.set(phase, { phase, thought, data: phaseData, confidence });
      }
    } else {
      session.phases.set(phase, { phase, thought, data: phaseData, confidence });
    }

    if (
      phase === "complexity_assessment" &&
      phaseData &&
      typeof phaseData === "object"
    ) {
      const level = phaseData.level;
      if ([1, 2, 3].includes(level)) {
        session.complexityLevel = level as ComplexityLevel;
      }
    }

    const complete = session.isComplete();
    const result: any = {
      sessionId: session.sessionId,
      completedPhases: session.completedPhases,
      complexityLevel: session.complexityLevel,
      planComplete: complete,
    };

    const remaining = PHASE_NAMES.filter(
      (p) => session.requiredPhases().has(p) && !session.phases.has(p),
    );
    if (remaining.length > 0) {
      result.phasesRemaining = remaining;
    }

    if (complete) {
      result.executablePlan = session.buildExecutablePlan();
    }

    return result;
  }

  private generateSessionId(): string {
    return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

export const planningEngine = new PlanningEngine();

export function splitCsv(value: string): string[] {
  return value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s)
    : [];
}
