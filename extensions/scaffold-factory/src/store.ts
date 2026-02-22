import fs from "node:fs";
import path from "node:path";

// --- Types ---

export interface ScoutScores {
  feasibility: number;
  mcp_fit: number;
  demand_signal: number;
  uniqueness: number;
}

export interface Idea {
  title: string;
  summary: string;
  sourceUrl?: string;
  sourceQuote?: string;
  scores: ScoutScores;
  totalScore: number;
  suggestedTools?: string[];
}

export interface Checkpoints {
  scout_approved: string | null;
  build_approved: string | null;
  publish_approved: string | null;
}

export interface BuildResult {
  success: boolean;
  appName?: string;
  appPath?: string;
  toolCount?: number;
  tools?: string[];
  testsPass?: boolean;
  typecheckPass?: boolean;
  iterations?: number;
  notes?: string;
  reason?: string;
}

export interface TestFinding {
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  tool?: string;
  input?: Record<string, unknown>;
  expected?: string;
  actual?: string;
}

export interface PersonaTestResult {
  persona: string;
  passed: boolean;
  toolCalls?: number;
  successes?: number;
  failures?: number;
  findings?: TestFinding[];
  commentary?: string;
  testsWritten?: number;
  testsPass?: boolean;
  reason?: string;
  rawResponse?: string;
}

export interface Cycle {
  cycleId: string;
  status: string;
  ideas: Idea[];
  idea: Idea | null;
  checkpoints: Checkpoints;
  appPath: string;
  appName: string;
  buildLog: string[];
  testResults: PersonaTestResult[];
  judgeVerdict: Record<string, unknown> | null;
  guardianReport: Record<string, unknown> | null;
  docs: Record<string, unknown> | null;
  iterations: { build: number; test: number };
  rejectionFeedback?: string;
  failureReason?: string;
  buildResult?: BuildResult;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryConfig {
  scoutSources: {
    reddit: string[];
    hackerNews: boolean;
    productHunt: boolean;
    twitter: boolean;
  };
  personaCount: number;
  maxBuildIterations: number;
  maxRebuildRounds: number;
  thresholds: {
    scoutMinScore: number;
    judgingPassScore: number;
  };
  existingApps: string[];
  pauseCron: boolean;
}

export interface CatalogEntry {
  name: string;
  [key: string]: unknown;
}

export interface Catalog {
  apps: CatalogEntry[];
  updatedAt: string | null;
}

// --- Helpers ---

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    }
  } catch (err) {
    console.error(`[Factory Store] Failed to read ${filePath}:`, (err as Error).message);
  }
  return fallback;
}

function writeJSON(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- Store ---

const DEFAULT_CONFIG: FactoryConfig = {
  scoutSources: {
    reddit: ["ClaudeAI", "ChatGPT", "sideproject", "buildinpublic", "SaaS"],
    hackerNews: true,
    productHunt: false,
    twitter: false,
  },
  personaCount: 2,
  maxBuildIterations: 3,
  maxRebuildRounds: 2,
  thresholds: {
    scoutMinScore: 12,
    judgingPassScore: 70,
  },
  existingApps: ["notes-app", "travel", "bbq", "local-guide", "watch-recommender"],
  pauseCron: false,
};

export class FactoryStore {
  private cyclesDir: string;
  private configFile: string;
  private catalogFile: string;
  private learningsDir: string;

  constructor(stateDir: string) {
    this.cyclesDir = path.join(stateDir, "cycles");
    this.configFile = path.join(stateDir, "config.json");
    this.catalogFile = path.join(stateDir, "catalog.json");
    this.learningsDir = path.join(stateDir, "learnings");
  }

  createCycle(): Cycle {
    ensureDir(this.cyclesDir);

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const existing = fs.existsSync(this.cyclesDir) ? fs.readdirSync(this.cyclesDir) : [];
    const todayCount = existing.filter((d) => d.startsWith(`cycle-${dateStr}`)).length;
    const cycleId = `cycle-${dateStr}-${String(todayCount + 1).padStart(3, "0")}`;

    const cycle: Cycle = {
      cycleId,
      status: "scouting",
      ideas: [],
      idea: null,
      checkpoints: {
        scout_approved: null,
        build_approved: null,
        publish_approved: null,
      },
      appPath: "",
      appName: "",
      buildLog: [],
      testResults: [],
      judgeVerdict: null,
      guardianReport: null,
      docs: null,
      iterations: { build: 0, test: 0 },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    const cycleDir = path.join(this.cyclesDir, cycleId);
    ensureDir(cycleDir);
    writeJSON(path.join(cycleDir, "state.json"), cycle);

    return cycle;
  }

  getCycle(cycleId: string): Cycle | null {
    const stateFile = path.join(this.cyclesDir, cycleId, "state.json");
    return readJSON<Cycle | null>(stateFile, null);
  }

  getActiveCycle(): Cycle | null {
    if (!fs.existsSync(this.cyclesDir)) return null;

    const dirs = fs
      .readdirSync(this.cyclesDir)
      .filter((d) => d.startsWith("cycle-"))
      .sort()
      .reverse();

    for (const dir of dirs) {
      const cycle = this.getCycle(dir);
      if (cycle && cycle.status !== "complete" && cycle.status !== "failed") {
        return cycle;
      }
    }
    return null;
  }

  updateCycle(cycleId: string, updates: Partial<Cycle>): Cycle {
    const cycle = this.getCycle(cycleId);
    if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

    const updated = { ...cycle, ...updates, updatedAt: new Date().toISOString() };
    writeJSON(path.join(this.cyclesDir, cycleId, "state.json"), updated);
    return updated;
  }

  listCycles(opts: { limit?: number; includeComplete?: boolean } = {}): Cycle[] {
    const { limit = 10, includeComplete = false } = opts;
    if (!fs.existsSync(this.cyclesDir)) return [];

    const dirs = fs
      .readdirSync(this.cyclesDir)
      .filter((d) => d.startsWith("cycle-"))
      .sort()
      .reverse();

    const cycles: Cycle[] = [];
    for (const dir of dirs) {
      if (cycles.length >= limit) break;
      const cycle = this.getCycle(dir);
      if (cycle) {
        if (!includeComplete && (cycle.status === "complete" || cycle.status === "failed"))
          continue;
        cycles.push(cycle);
      }
    }
    return cycles;
  }

  getConfig(): FactoryConfig {
    const config = readJSON<FactoryConfig | null>(this.configFile, null);
    if (!config) {
      writeJSON(this.configFile, DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...config };
  }

  updateConfig(updates: Partial<FactoryConfig>): FactoryConfig {
    const config = this.getConfig();
    const updated = { ...config, ...updates };
    writeJSON(this.configFile, updated);
    return updated;
  }

  getCatalog(): Catalog {
    return readJSON<Catalog>(this.catalogFile, { apps: [], updatedAt: null });
  }

  addToCatalog(app: CatalogEntry): Catalog {
    const catalog = this.getCatalog();
    const existing = catalog.apps.findIndex((a) => a.name === app.name);
    if (existing >= 0) {
      catalog.apps[existing] = app;
    } else {
      catalog.apps.push(app);
    }
    catalog.updatedAt = new Date().toISOString();
    writeJSON(this.catalogFile, catalog);
    return catalog;
  }

  saveLearning(type: string, data: Record<string, unknown>): void {
    ensureDir(this.learningsDir);
    const filename = `${type}-${new Date().toISOString().split("T")[0]}.json`;
    const filePath = path.join(this.learningsDir, filename);
    const existing = readJSON<Array<Record<string, unknown>>>(filePath, []);
    existing.push({ ...data, timestamp: new Date().toISOString() });
    writeJSON(filePath, existing);
  }
}
