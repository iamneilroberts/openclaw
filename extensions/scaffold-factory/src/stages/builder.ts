import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pipeline } from "../pipeline.js";
import type { FactoryStore, BuildResult } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_PROMPT_PATH = path.join(__dirname, "..", "prompts", "build.md");

function getBuildPrompt(): string {
  try {
    return fs.readFileSync(BUILD_PROMPT_PATH, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Build the builder stage prompt message. This is returned to the OpenClaw agent
 * which executes it using its own tools and model.
 */
export function buildBuilderMessage(
  store: FactoryStore,
  cycleId: string,
  outputBaseDir: string,
): string {
  const config = store.getConfig();
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  if (!cycle.idea) throw new Error("No idea selected. Run /scout pick first.");

  const maxIterations = config.maxBuildIterations || 3;
  const appName = cycle.appName;
  const appDir = path.join(outputBaseDir, appName);
  const buildPrompt = getBuildPrompt();
  const rejectionFeedback = cycle.rejectionFeedback || "";

  const toolSuggestions = cycle.idea.suggestedTools?.length
    ? `Suggested tools: ${cycle.idea.suggestedTools.join(", ")}`
    : "";

  const feedbackSection = rejectionFeedback
    ? `\n## Previous Feedback\nThe previous build was rejected with this feedback:\n${rejectionFeedback}\nAddress these issues in this build.\n`
    : "";

  return `You are the Builder stage of the Scaffold App Factory. Your job is to generate a complete, working MCP tool app.

## Idea to Build

**Title:** ${cycle.idea.title}
**Summary:** ${cycle.idea.summary}
${toolSuggestions}
${feedbackSection}

## Build Instructions

${buildPrompt}

## App Details

- **App name:** ${appName}
- **Output directory:** ${appDir}
- **App should be a Cloudflare Worker with Durable Objects for KV storage**

## What You Must Create

Create these files under ${appDir}/:

### 1. package.json
Standard Node.js package with:
- name: "@scaffold/${appName}"
- Scripts: dev, deploy, typecheck, test
- Dependencies: @scaffold/core (workspace:*), hono, zod
- DevDependencies: typescript, vitest, wrangler, @cloudflare/workers-types

### 2. wrangler.toml
Cloudflare Workers config with:
- name = "${appName}"
- A durable_objects binding named STORAGE
- A migration tag

### 3. tsconfig.json
Standard TypeScript config extending a base or standalone.

### 4. src/index.ts
Entry point that:
- Imports tools from ./tools
- Creates an MCP server using the scaffold pattern
- Exports the Durable Object class

### 5. src/tools.ts (MOST IMPORTANT)
The actual tool implementations. Each tool must:
- Export a ScaffoldTool-compatible object with: name, description, inputSchema (JSON Schema), handler(input, ctx)
- Use ctx.storage.get(key) / ctx.storage.put(key, value) / ctx.storage.list(prefix) / ctx.storage.delete(key) for persistence
- Prefix all storage keys with the userId: \`\${ctx.userId}/\` for data isolation
- Return { content: [{ type: 'text', text: '...' }] } from handler
- Include input validation with clear error messages
- Name tools as "${appName}:<action>" (e.g., "${appName}:create", "${appName}:list")

### 6. src/__tests__/tools.test.ts
Vitest tests that:
- Mock the storage context
- Test each tool's handler directly
- Cover happy path, edge cases, and error cases

## After Creating Files

1. Run: cd ${appDir} && npm install (if package.json was created)
2. Run: npx tsc --noEmit (typecheck)
3. Run: npx vitest run (tests)

If any step fails, fix the issues. You have ${maxIterations} attempts total.

## Output

After building, respond with EXACTLY this JSON:

\`\`\`json
{
  "success": true,
  "appName": "${appName}",
  "appPath": "${appDir}",
  "toolCount": 5,
  "tools": ["${appName}:create", "${appName}:list"],
  "testsPass": true,
  "typecheckPass": true,
  "iterations": 1,
  "notes": "Any relevant notes about the build"
}
\`\`\`

Or if it fails after all attempts:

\`\`\`json
{
  "success": false,
  "reason": "What went wrong",
  "iterations": 3
}
\`\`\``;
}

/**
 * Process builder response and store results.
 */
export function processBuilderResponse(
  store: FactoryStore,
  cycleId: string,
  response: string,
  defaultAppDir: string,
): BuildResult {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

  const result = parseBuildResponse(response);

  if (result?.success) {
    store.updateCycle(cycleId, {
      appPath: result.appPath || defaultAppDir,
      buildLog: [
        ...(cycle.buildLog || []),
        `Build succeeded: ${result.toolCount} tools, ${result.iterations} iteration(s)`,
      ],
      buildResult: result,
    });
  } else {
    store.updateCycle(cycleId, {
      buildLog: [...(cycle.buildLog || []), `Build failed: ${result?.reason || "Unknown error"}`],
      buildResult: result || undefined,
    });
  }

  return result || { success: false, reason: "Could not parse build response" };
}

function parseBuildResponse(response: string): BuildResult | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    return JSON.parse(jsonStr!.trim());
  } catch {
    const objMatch = response.match(/\{\s*"success"\s*:[\s\S]*?\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Approve the build and advance to testing.
 */
export function approveBuild(
  store: FactoryStore,
  pipeline: Pipeline,
  cycleId: string,
): { approved: boolean; nextStage?: string; reason?: string } {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  if (cycle.status !== "building")
    throw new Error(`Cycle is in ${cycle.status} stage, not building`);

  pipeline.approveCheckpoint(cycleId, "build_approved");
  pipeline.advanceStage(cycleId);

  return { approved: true, nextStage: "testing" };
}

/**
 * Reject the build with feedback.
 */
export function rejectBuild(
  store: FactoryStore,
  pipeline: Pipeline,
  cycleId: string,
  feedback: string,
): { rejected: boolean; failed?: boolean; feedback?: string; reason?: string } {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

  const maxRebuilds = store.getConfig().maxRebuildRounds || 2;
  if ((cycle.iterations.build || 0) >= maxRebuilds) {
    pipeline.failCycle(cycleId, `Build rejected ${maxRebuilds} times. Cycle failed.`);
    return { rejected: true, failed: true, reason: "Max rebuild rounds exceeded" };
  }

  pipeline.rejectWithFeedback(cycleId, "building", feedback);
  return { rejected: true, feedback };
}
