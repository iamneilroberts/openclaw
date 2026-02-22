import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryStore, Cycle, PersonaTestResult } from "../store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.join(__dirname, "..", "personas");

function loadPersona(name: string): string | null {
  const filePath = path.join(PERSONAS_DIR, `${name}.md`);
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function getToolsFromBuild(appDir: string): string | null {
  const toolsFile = path.join(appDir, "src", "tools.ts");
  try {
    return fs.readFileSync(toolsFile, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Build test prompt messages for each persona. Returns an array of
 * { personaName, message } objects for the OpenClaw agent to execute.
 */
export function buildTestMessages(
  store: FactoryStore,
  cycleId: string,
): { personaName: string; message: string }[] {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  if (!cycle.appPath) throw new Error("No app path. Build first.");

  const toolsSource = getToolsFromBuild(cycle.appPath);
  if (!toolsSource) {
    throw new Error(`Could not read tools from ${cycle.appPath}/src/tools.ts`);
  }

  // MVP: 2 personas
  const personaNames = ["casual-user", "adversarial-tester"];
  const messages: { personaName: string; message: string }[] = [];

  for (const personaName of personaNames) {
    const personaPrompt = loadPersona(personaName);
    if (!personaPrompt) continue;

    messages.push({
      personaName,
      message: buildPersonaTestMessage(cycle, personaName, personaPrompt, toolsSource),
    });
  }

  return messages;
}

function buildPersonaTestMessage(
  cycle: Cycle,
  personaName: string,
  personaPrompt: string,
  toolsSource: string,
): string {
  const appName = cycle.appName;
  const appDir = cycle.appPath;

  return `You are a test persona for the Scaffold App Factory. You will test a newly built MCP tool app by simulating realistic usage.

## Your Persona

${personaPrompt}

## App Under Test

**Name:** ${appName}
**Idea:** ${cycle.idea!.title} - ${cycle.idea!.summary}
**App directory:** ${appDir}

## Available Tool Source Code

Here are the tools available in this app:

\`\`\`typescript
${toolsSource}
\`\`\`

## Testing Instructions

You need to test this app by actually using the tools via Bash commands. Since this is a scaffold app, we'll test the tool handlers directly.

1. First, read the test file at ${appDir}/src/__tests__/tools.test.ts to understand the testing setup
2. Run the existing tests: cd ${appDir} && npx vitest run
3. Then create additional test scenarios based on your persona by writing to a new test file: ${appDir}/src/__tests__/persona-${personaName}.test.ts
4. Run your persona tests: cd ${appDir} && npx vitest run src/__tests__/persona-${personaName}.test.ts

## Your Testing Goals (based on persona)

Make 5-10 tool calls covering:
- Basic functionality (create, read, update, delete operations)
- Edge cases relevant to your persona
- Error handling (invalid inputs, missing data)
- Data isolation (ensure userId prefix isolation works)

## Output Format

After testing, respond with EXACTLY this JSON:

\`\`\`json
{
  "persona": "${personaName}",
  "passed": true,
  "toolCalls": 8,
  "successes": 7,
  "failures": 1,
  "findings": [
    {
      "severity": "low|medium|high|critical",
      "description": "What you found",
      "tool": "tool:name",
      "input": {},
      "expected": "what should happen",
      "actual": "what actually happened"
    }
  ],
  "commentary": "Overall assessment from this persona's perspective",
  "testsWritten": 5,
  "testsPass": true
}
\`\`\``;
}

/**
 * Process test results from agent responses.
 */
export function processTestResponse(response: string, personaName: string): PersonaTestResult {
  const result = parseTestResponse(response, personaName);
  return (
    result || {
      persona: personaName,
      passed: false,
      reason: "Could not parse test results",
      rawResponse: response.slice(0, 500),
    }
  );
}

/**
 * Store test results in the cycle.
 */
export function storeTestResults(
  store: FactoryStore,
  cycleId: string,
  results: PersonaTestResult[],
): { success: boolean; results: PersonaTestResult[]; allPassed: boolean } {
  const cycle = store.getCycle(cycleId);
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

  store.updateCycle(cycleId, {
    testResults: results,
    iterations: {
      ...cycle.iterations,
      test: (cycle.iterations.test || 0) + 1,
    },
    buildLog: [
      ...(cycle.buildLog || []),
      `Testing complete: ${results.length} personas, ${results.filter((r) => r.passed).length} passed`,
    ],
  });

  const allPassed = results.every((r) => r.passed);
  return { success: true, results, allPassed };
}

function parseTestResponse(response: string, _personaName: string): PersonaTestResult | null {
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    return JSON.parse(jsonStr!.trim());
  } catch {
    const objMatch = response.match(/\{\s*"persona"\s*:[\s\S]*?\}/);
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

export function formatTestResults(results: PersonaTestResult[]): string {
  if (!results || results.length === 0) return "No test results.";

  return results
    .map((r) => {
      const status = r.passed ? "PASS" : "FAIL";
      const findings = r.findings?.length
        ? r.findings.map((f) => `  - [${f.severity}] ${f.description}`).join("\n")
        : "  No issues found";

      return [
        `${status} - ${r.persona}`,
        `  Tool calls: ${r.toolCalls || "?"}, Successes: ${r.successes || "?"}, Failures: ${r.failures || "?"}`,
        findings,
        r.commentary ? `  Commentary: ${r.commentary}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
