import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pipeline } from "../pipeline.js";
import type { FactoryStore, Idea } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOUT_PROMPT_PATH = path.join(__dirname, "..", "prompts", "scout.md");

function getScoutPrompt(): string {
  try {
    return fs.readFileSync(SCOUT_PROMPT_PATH, "utf-8");
  } catch {
    return DEFAULT_SCOUT_PROMPT;
  }
}

const DEFAULT_SCOUT_PROMPT = `You are scouting for MCP tool app ideas. Evaluate each idea on:
- feasibility (1-5): Can this be built as a single-domain MCP tool with KV storage?
- mcp_fit (1-5): Does it enhance a chat client naturally?
- demand_signal (1-5): Are people expressing frustration or "I wish I had..."?
- uniqueness (1-5): Is it different from existing scaffold apps?

Return JSON array of ideas with scores.`;

function buildRedditUrls(subreddits: string[]): string[] {
  return subreddits.map((sub) => `https://old.reddit.com/r/${sub}/top/?t=week`);
}

function buildHackerNewsUrls(): string[] {
  return ["https://news.ycombinator.com/show", "https://news.ycombinator.com/ask"];
}

/**
 * Build the scouting prompt message. This is returned to the OpenClaw agent
 * which executes it using its own browser tools and model.
 */
export function buildScoutMessage(store: FactoryStore, cycleId: string): string {
  const config = store.getConfig();
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

  const urls: string[] = [];

  if (config.scoutSources.reddit?.length) {
    urls.push(...buildRedditUrls(config.scoutSources.reddit));
  }
  if (config.scoutSources.hackerNews) {
    urls.push(...buildHackerNewsUrls());
  }

  const existingApps = config.existingApps.join(", ");
  const scoutPrompt = getScoutPrompt();
  const urlList = urls.map((u, i) => `${i + 1}. ${u}`).join("\n");

  return `You are the Scout stage of the Scaffold App Factory. Your job is to find ideas for new MCP tool apps.

## Instructions

${scoutPrompt}

## URLs to Scrape

Visit each of these URLs using browser tools (browser_navigate + browser_snapshot). Extract posts/discussions that suggest MCP tool app ideas:

${urlList}

## Existing Apps (avoid duplicating these)
${existingApps}

## Process

1. Navigate to each URL and take a snapshot
2. Look for posts where people express needs, frustrations, or "I wish..." sentiments that could be solved by an MCP tool
3. Extract the top ideas you find
4. Score each idea on: feasibility (1-5), mcp_fit (1-5), demand_signal (1-5), uniqueness (1-5)
5. Rank by total score (sum of all 4 criteria, max 20)

## Output Format

After scraping all sources, respond with EXACTLY this JSON structure (no other text):

\`\`\`json
{
  "ideas": [
    {
      "title": "Short descriptive title",
      "summary": "2-3 sentence description of the app idea",
      "sourceUrl": "URL where you found this idea",
      "sourceQuote": "The key quote or post that inspired this idea",
      "scores": {
        "feasibility": 4,
        "mcp_fit": 5,
        "demand_signal": 3,
        "uniqueness": 4
      },
      "totalScore": 16,
      "suggestedTools": ["tool1:action", "tool2:action"]
    }
  ]
}
\`\`\`

Return exactly 5 ideas ranked by total score (highest first). Only include ideas scoring 12 or higher.`;
}

/**
 * Process scout response and store results.
 */
export function processScoutResponse(
  store: FactoryStore,
  cycleId: string,
  response: string,
): { success: boolean; ideas?: Idea[]; reason?: string } {
  const config = store.getConfig();
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

  const ideas = parseScoutResponse(response);

  if (!ideas || ideas.length === 0) {
    store.updateCycle(cycleId, {
      ideas: [],
      buildLog: [...(cycle.buildLog || []), "Scout found no ideas"],
    });
    return { success: false, reason: "No viable ideas found" };
  }

  const minScore = config.thresholds?.scoutMinScore || 12;
  const filteredIdeas = ideas.filter((i) => (i.totalScore || sumScores(i.scores)) >= minScore);

  store.updateCycle(cycleId, {
    ideas: filteredIdeas.slice(0, 5),
    buildLog: [...(cycle.buildLog || []), `Scout found ${filteredIdeas.length} ideas`],
  });

  return { success: true, ideas: filteredIdeas.slice(0, 5) };
}

function sumScores(scores: Idea["scores"] | undefined): number {
  if (!scores) return 0;
  return (
    (scores.feasibility || 0) +
    (scores.mcp_fit || 0) +
    (scores.demand_signal || 0) +
    (scores.uniqueness || 0)
  );
}

function parseScoutResponse(response: string): Idea[] | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr!.trim());
    return parsed.ideas || parsed;
  } catch {
    const arrayMatch = response.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        return null;
      }
    }
    const objMatch = response.match(/\{\s*"ideas"\s*:\s*\[[\s\S]*\]\s*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]).ideas;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Pick an idea from scouting results.
 */
export function pickIdea(
  store: FactoryStore,
  pipeline: Pipeline,
  cycleId: string,
  ideaIndex: number,
): { picked: Idea; appName: string } {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  if (!cycle.ideas || cycle.ideas.length === 0)
    throw new Error("No ideas to pick from. Run /scout first.");
  if (ideaIndex < 1 || ideaIndex > cycle.ideas.length) {
    throw new Error(`Pick a number between 1 and ${cycle.ideas.length}`);
  }

  const idea = cycle.ideas[ideaIndex - 1]!;

  const appName = idea.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 30);

  store.updateCycle(cycleId, { idea, appName });
  pipeline.approveCheckpoint(cycleId, "scout_approved");
  pipeline.advanceStage(cycleId);

  return { picked: idea, appName };
}

export function formatIdeas(ideas: Idea[]): string {
  if (!ideas || ideas.length === 0) return "No ideas found.";

  return ideas
    .map((idea, i) => {
      const scores = idea.scores || ({} as Idea["scores"]);
      const total = idea.totalScore || sumScores(scores);
      return [
        `${i + 1}. ${idea.title} (Score: ${total}/20)`,
        `   ${idea.summary}`,
        `   Feasibility: ${scores.feasibility || "?"} | MCP-fit: ${scores.mcp_fit || "?"} | Demand: ${scores.demand_signal || "?"} | Unique: ${scores.uniqueness || "?"}`,
        `   Source: ${idea.sourceUrl || "N/A"}`,
        idea.suggestedTools ? `   Tools: ${idea.suggestedTools.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
