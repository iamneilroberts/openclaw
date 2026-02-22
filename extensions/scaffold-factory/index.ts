import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { Pipeline } from "./src/pipeline.js";
import {
  buildBuilderMessage,
  processBuilderResponse,
  approveBuild,
  rejectBuild,
} from "./src/stages/builder.js";
import {
  buildScoutMessage,
  processScoutResponse,
  pickIdea,
  formatIdeas,
} from "./src/stages/scout.js";
import {
  buildTestMessages,
  processTestResponse,
  storeTestResults,
  formatTestResults,
} from "./src/stages/tester.js";
import { FactoryStore } from "./src/store.js";

export default function register(api: OpenClawPluginApi) {
  const stateDir = path.join(api.runtime.state.resolveStateDir(), "plugins", "scaffold-factory");
  const store = new FactoryStore(stateDir);
  const pipeline = new Pipeline(store);

  // --- Commands ---

  api.registerCommand({
    name: "scout",
    description: "Find app ideas by scraping Reddit/HN for MCP tool opportunities",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";

      // /scout pick N
      if (args.startsWith("pick ")) {
        const n = parseInt(args.split(" ")[1]!, 10);
        const cycle = store.getActiveCycle();
        if (!cycle) return { text: "No active cycle. Run /scout first." };

        try {
          const result = pickIdea(store, pipeline, cycle.cycleId, n);
          return {
            text: [
              `Picked idea #${n}: ${result.picked.title}`,
              `App name: ${result.appName}`,
              "",
              "Cycle advanced to BUILD stage.",
              "Run /build to start building the app.",
            ].join("\n"),
          };
        } catch (err) {
          return { text: `Error: ${(err as Error).message}` };
        }
      }

      // /scout — start scouting
      let cycle = store.getActiveCycle();
      if (!cycle) {
        cycle = store.createCycle();
      } else if (cycle.status !== "scouting") {
        return {
          text: `Active cycle ${cycle.cycleId} is in ${cycle.status} stage. Use /factory to see status.`,
        };
      }

      // Return the scout prompt as an agent message for LLM execution
      const message = buildScoutMessage(store, cycle.cycleId);
      return {
        text: `Scouting for ideas... (cycle: ${cycle.cycleId})\n\nThe agent will now browse sources and find ideas.`,
        agentMessage: message,
      };
    },
  });

  api.registerCommand({
    name: "build",
    description: "Build a scaffold app from the selected idea",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const cycle = store.getActiveCycle();
      if (!cycle) return { text: "No active cycle. Run /scout first." };

      // /build approve
      if (args === "approve") {
        try {
          approveBuild(store, pipeline, cycle.cycleId);
          return {
            text: [
              "Build approved!",
              "Cycle advanced to TESTING stage.",
              "Run /test to start persona testing.",
            ].join("\n"),
          };
        } catch (err) {
          return { text: `Error: ${(err as Error).message}` };
        }
      }

      // /build reject <feedback>
      if (args.startsWith("reject ")) {
        const feedback = args.slice(7).trim();
        if (!feedback) return { text: "Provide feedback: /build reject <what to fix>" };

        try {
          const result = rejectBuild(store, pipeline, cycle.cycleId, feedback);
          if (result.failed) {
            return { text: `Build rejected too many times. Cycle failed: ${result.reason}` };
          }
          return { text: "Build rejected with feedback. Run /build to rebuild." };
        } catch (err) {
          return { text: `Error: ${(err as Error).message}` };
        }
      }

      // /build — start building
      if (cycle.status !== "building") {
        if (cycle.status === "scouting" && cycle.checkpoints.scout_approved) {
          pipeline.advanceStage(cycle.cycleId);
        } else if (cycle.status !== "building") {
          return {
            text: `Cycle is in ${cycle.status} stage. ${cycle.status === "scouting" ? "Pick an idea first: /scout pick <N>" : ""}`,
          };
        }
      }

      // Resolve output directory relative to workspace
      const agentsConfig = (api.config as Record<string, unknown>).agents as
        | Record<string, unknown>
        | undefined;
      const workspace = (agentsConfig?.defaults as Record<string, unknown> | undefined)
        ?.workspace as string | undefined;
      const outputBaseDir = workspace
        ? path.join(workspace, "scaffold", "examples")
        : path.join(stateDir, "builds");

      const message = buildBuilderMessage(store, cycle.cycleId, outputBaseDir);
      return {
        text: `Building ${cycle.appName}... This may take a few minutes.`,
        agentMessage: message,
      };
    },
  });

  api.registerCommand({
    name: "test",
    description: "Run persona tests on the built app",
    acceptsArgs: true,
    handler: async (ctx) => {
      const cycle = store.getActiveCycle();
      if (!cycle) return { text: "No active cycle." };

      if (cycle.status === "testing" && cycle.testResults?.length > 0 && !ctx.args?.trim()) {
        return {
          text: ["Test Results:", "", formatTestResults(cycle.testResults)].join("\n"),
        };
      }

      if (cycle.status !== "testing") {
        return {
          text: `Cycle is in ${cycle.status} stage. Approve the build first: /build approve`,
        };
      }

      try {
        const testMessages = buildTestMessages(store, cycle.cycleId);
        // Return the first persona test message for the agent to execute
        // The agent will need to run each persona sequentially
        if (testMessages.length === 0) {
          return { text: "No persona files found." };
        }

        return {
          text: `Running persona tests on ${cycle.appName}... (${testMessages.length} personas)`,
          agentMessage: testMessages[0]!.message,
        };
      } catch (err) {
        return { text: `Error: ${(err as Error).message}` };
      }
    },
  });

  api.registerCommand({
    name: "factory",
    description: "View factory status, history, and configuration",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";

      if (args === "history") {
        const cycles = store.listCycles({ limit: 10, includeComplete: true });
        if (cycles.length === 0) return { text: "No factory cycles yet. Start with /scout." };

        const lines = cycles.map((c) => {
          const idea = c.idea ? c.idea.title : "No idea selected";
          return `  ${c.cycleId} | ${c.status} | ${idea}`;
        });

        return { text: ["Factory History:", "", ...lines].join("\n") };
      }

      if (args === "config") {
        const config = store.getConfig();
        return {
          text: [
            "Factory Config:",
            "",
            `  Reddit subs: ${config.scoutSources.reddit.join(", ")}`,
            `  Hacker News: ${config.scoutSources.hackerNews ? "enabled" : "disabled"}`,
            `  Product Hunt: ${config.scoutSources.productHunt ? "enabled" : "disabled"}`,
            `  Persona count: ${config.personaCount}`,
            `  Max build iterations: ${config.maxBuildIterations}`,
            `  Min scout score: ${config.thresholds.scoutMinScore}`,
            `  Existing apps: ${config.existingApps.join(", ")}`,
          ].join("\n"),
        };
      }

      if (args === "pause") {
        store.updateConfig({ pauseCron: true });
        return { text: "Factory paused. Resume with /factory resume." };
      }

      if (args === "resume") {
        store.updateConfig({ pauseCron: false });
        return { text: "Factory resumed." };
      }

      // Default: show current status
      const cycle = store.getActiveCycle();
      if (!cycle) {
        return {
          text: [
            "App Factory",
            "",
            "No active cycle. Start with /scout to find ideas.",
            "",
            "Commands:",
            "  /scout -- find app ideas",
            "  /scout pick <N> -- select an idea",
            "  /build -- build the selected idea",
            "  /build approve -- approve build",
            "  /build reject <feedback> -- reject with feedback",
            "  /test -- run persona tests",
            "  /factory -- this status view",
            "  /factory history -- past cycles",
            "  /factory config -- view configuration",
          ].join("\n"),
        };
      }

      const status = pipeline.getStatus(cycle.cycleId);
      if (!status) return { text: "Error loading cycle status." };

      const lines = [
        `App Factory -- ${status.cycleId}`,
        "",
        `  Stage: ${status.status} (${status.progress})`,
        status.idea ? `  Idea: ${status.idea.title}` : "  Idea: Not selected",
        status.appName ? `  App: ${status.appName}` : "",
        "",
        "  Checkpoints:",
        `    Scout: ${status.checkpoints.scout_approved ? "approved" : "pending"}`,
        `    Build: ${status.checkpoints.build_approved ? "approved" : "pending"}`,
        `    Publish: ${status.checkpoints.publish_approved ? "approved" : "pending"}`,
        "",
        `  Build iterations: ${status.iterations.build}`,
        `  Test iterations: ${status.iterations.test}`,
        status.pendingCheckpoint
          ? `\n  Next: Approve checkpoint "${status.pendingCheckpoint}"`
          : "",
      ].filter(Boolean);

      return { text: lines.join("\n") };
    },
  });

  // --- Agent Tools ---
  // These tools allow the LLM agent to interact with the factory pipeline programmatically.

  function jsonResult(data: unknown) {
    return {
      content: [
        { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) },
      ],
      details: data,
    };
  }

  const factoryTools = [
    {
      name: "factory_scout_process",
      label: "Process Scout Results",
      description:
        "Process the results of a scouting run. Call this after browsing Reddit/HN and finding app ideas. Pass the JSON response with scored ideas.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          cycle_id: { type: "string", description: "Cycle ID" },
          response: { type: "string", description: "JSON response with scored ideas" },
        },
        required: ["cycle_id", "response"],
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const result = processScoutResponse(
            store,
            params.cycle_id as string,
            params.response as string,
          );
          if (result.success && result.ideas) {
            return jsonResult({
              success: true,
              ideas: formatIdeas(result.ideas),
              count: result.ideas.length,
            });
          }
          return jsonResult({ success: false, reason: result.reason });
        } catch (err) {
          return jsonResult({ error: (err as Error).message });
        }
      },
    },
    {
      name: "factory_build_process",
      label: "Process Build Results",
      description:
        "Process the results of a build run. Call this after generating the scaffold app files. Pass the JSON response with build results.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          cycle_id: { type: "string", description: "Cycle ID" },
          response: { type: "string", description: "JSON response with build results" },
          app_dir: { type: "string", description: "Directory where the app was built" },
        },
        required: ["cycle_id", "response", "app_dir"],
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const result = processBuilderResponse(
            store,
            params.cycle_id as string,
            params.response as string,
            params.app_dir as string,
          );
          return jsonResult(result);
        } catch (err) {
          return jsonResult({ error: (err as Error).message });
        }
      },
    },
    {
      name: "factory_test_process",
      label: "Process Test Results",
      description:
        "Process the results of a persona test run. Call this after running tests as a specific persona. Pass the JSON response with test findings.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          cycle_id: { type: "string", description: "Cycle ID" },
          persona_name: { type: "string", description: "Persona name (e.g., casual-user)" },
          response: { type: "string", description: "JSON response with test results" },
        },
        required: ["cycle_id", "persona_name", "response"],
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const result = processTestResponse(
            params.response as string,
            params.persona_name as string,
          );
          return jsonResult(result);
        } catch (err) {
          return jsonResult({ error: (err as Error).message });
        }
      },
    },
    {
      name: "factory_test_store",
      label: "Store Test Results",
      description:
        "Store all persona test results for a cycle after all personas have been tested.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          cycle_id: { type: "string", description: "Cycle ID" },
          results: {
            type: "array",
            description: "Array of persona test results",
            items: { type: "object" },
          },
        },
        required: ["cycle_id", "results"],
      }),
      execute: async (_id: string, params: Record<string, unknown>) => {
        try {
          const result = storeTestResults(
            store,
            params.cycle_id as string,
            params.results as unknown as ReturnType<typeof processTestResponse>[],
          );
          return jsonResult({
            success: result.success,
            allPassed: result.allPassed,
            summary: formatTestResults(result.results),
          });
        } catch (err) {
          return jsonResult({ error: (err as Error).message });
        }
      },
    },
    {
      name: "factory_status",
      label: "Factory Status",
      description:
        "Get the current factory pipeline status including active cycle, stage, and progress.",
      parameters: Type.Unsafe({ type: "object", properties: {} }),
      execute: async () => {
        const cycle = store.getActiveCycle();
        if (!cycle) return jsonResult({ active: false, message: "No active cycle" });
        const status = pipeline.getStatus(cycle.cycleId);
        return jsonResult(status);
      },
    },
  ];

  api.registerTool((_ctx) => factoryTools as unknown as AnyAgentTool[], {
    names: factoryTools.map((t) => t.name),
  });

  // --- Inject factory context into agent prompt when a cycle is active ---

  api.on("before_prompt_build", async (_event, _ctx) => {
    const cycle = store.getActiveCycle();
    if (!cycle) return;

    // If scouting with no ideas yet, inject the full scout prompt
    if (cycle.status === "scouting" && (!cycle.ideas || cycle.ideas.length === 0)) {
      const scoutPrompt = buildScoutMessage(store, cycle.cycleId);
      return {
        prependContext: [
          "## Scaffold App Factory — ACTIVE SCOUTING MISSION",
          "",
          "There is an active scouting cycle. You MUST execute the instructions below.",
          "",
          "CRITICAL: When you have finished finding ideas, you MUST call the `factory_scout_process` tool.",
          "DO NOT just reply with text. You MUST use the tool to store results.",
          "Tool call parameters:",
          `  - cycle_id: "${cycle.cycleId}"`,
          '  - response: your JSON string containing {"ideas": [...]} with scored ideas',
          "",
          "If you skip the tool call, the ideas will be lost.",
          "",
          `Cycle ID: ${cycle.cycleId}`,
          "",
          scoutPrompt,
        ].join("\n"),
      };
    }

    // If building with no build result yet, inject the full builder prompt
    if (cycle.status === "building" && !cycle.buildResult) {
      const agentsConfig = (api.config as Record<string, unknown>).agents as
        | Record<string, unknown>
        | undefined;
      const workspace = (agentsConfig?.defaults as Record<string, unknown> | undefined)
        ?.workspace as string | undefined;
      const outputBaseDir = workspace
        ? path.join(workspace, "scaffold", "examples")
        : path.join(stateDir, "builds");

      const builderPrompt = buildBuilderMessage(store, cycle.cycleId, outputBaseDir);
      return {
        prependContext: [
          "## Scaffold App Factory — ACTIVE BUILD MISSION",
          "",
          "There is an active build cycle. You MUST execute the build instructions below.",
          "",
          "CRITICAL: When you have finished building, you MUST call the `factory_build_process` tool.",
          "DO NOT just reply with text. You MUST use the tool to store results.",
          "Tool call parameters:",
          `  - cycle_id: "${cycle.cycleId}"`,
          "  - response: your JSON string with build results (see Output section below)",
          `  - app_dir: the directory where you built the app`,
          "",
          "If you skip the tool call, the build results will be lost.",
          "",
          builderPrompt,
        ].join("\n"),
      };
    }

    // For other active states, inject a brief status context
    const status = pipeline.getStatus(cycle.cycleId);
    if (status) {
      return {
        prependContext: [
          "## Scaffold App Factory — Active Cycle",
          `Cycle: ${status.cycleId} | Stage: ${status.status}`,
          status.idea ? `Idea: ${status.idea.title}` : "",
          status.appName ? `App: ${status.appName}` : "",
          "Use factory_* tools to interact with the pipeline.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
  });
}
