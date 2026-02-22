# Session Handoff: OpenClaw Extensions Runtime Tested + Factory Pipeline Run

**Date:** 2026-02-22
**Session Focus:** Runtime-test ported extensions, fix issues, run full factory pipeline

## What Was Accomplished

1. Started OpenClaw gateway with both extensions (scaffold-factory + salesbot)
2. Fixed Telegram webhook conflict (deleted stale webhook via API)
3. Fixed `/approve` command conflict — renamed to `/sales-approve` in salesbot
4. Switched model provider: moonshot/kimi-k2.5 → openai-codex/gpt-5.3-codex
5. Approved Telegram pairing for user (sender 5355567040)
6. Fixed `optional: true` on tool registration — tools were silently excluded from agent runs
7. Added `before_prompt_build` hook to scaffold-factory for scouting and building stages
8. Ran full factory pipeline: scout → pick → build
9. Agent successfully browsed HN, found 5 MCP tool ideas, built an app

## Key Fixes Made

| File                                   | Change                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `extensions/salesbot/index.ts`         | Renamed `/approve` → `/sales-approve`, removed `optional: true` from tools                           |
| `extensions/salesbot/src/approval.ts`  | Updated notification to reference `/sales-approve`                                                   |
| `extensions/scaffold-factory/index.ts` | Added `before_prompt_build` hook for scouting + building stages, removed `optional: true` from tools |
| `~/.openclaw/openclaw.json`            | Changed primary model to `openai-codex/gpt-5.3-codex`                                                |

## Architecture Discovery: Command vs Agent Flow

- OpenClaw plugin commands (`registerCommand`) return `ReplyPayload` which does NOT support `agentMessage`
- Commands are handled directly — they never trigger agent runs
- The `before_prompt_build` hook is the correct way to inject prompts into agent runs
- Hook fires only on plain-text messages that go to the agent, NOT on `/commands`
- Tools registered with `optional: true` are excluded unless explicitly allowlisted in config — use default (non-optional) for tools that should always be available

## Factory Pipeline State

- **Cycle:** `cycle-2026-02-22-001`
- **Status:** `building` (build completed, not yet approved)
- **Idea:** Founder Idea Validation Log (score 15/20)
- **App path:** `/home/neil/.openclaw/workspace/scaffold/examples/founder-idea-validation-log`
- **5 tools:** create, list, update, delete, scorecard
- **Build result:** success=true, but testsPass=false, typecheckPass=false (exec gating prevented running npm/tsc/vitest)

## Generated App Files

```
founder-idea-validation-log/
├── package.json
├── wrangler.toml
├── tsconfig.json
└── src/
    ├── index.ts
    ├── tools.ts
    └── __tests__/
        └── tools.test.ts
```

## What the NEXT Session Should Do

### Inspect and Test the Generated App

1. **Read all generated files** in `/home/neil/.openclaw/workspace/scaffold/examples/founder-idea-validation-log/`
   - Start with `src/tools.ts` — this is the core logic (5 MCP tools)
   - Then `src/index.ts` — entry point / MCP server setup
   - Then `src/__tests__/tools.test.ts` — test suite
   - Then `package.json`, `wrangler.toml`, `tsconfig.json` — config files

2. **Review code quality:**
   - Do the tools follow the scaffold pattern? (name, description, inputSchema, handler)
   - Is storage keyed per-user with `${ctx.userId}/` prefix?
   - Are tool names formatted as `founder-idea-validation-log:<action>`?
   - Is input validation present with clear error messages?
   - Do handlers return `{ content: [{ type: 'text', text: '...' }] }`?

3. **Run the build chain locally:**

   ```bash
   cd /home/neil/.openclaw/workspace/scaffold/examples/founder-idea-validation-log
   npm install
   npx tsc --noEmit      # typecheck
   npx vitest run         # tests
   ```

4. **Fix any issues** found during review or test runs

5. **If tests pass**, approve the build via Telegram: `/build approve`
   - This advances the cycle to TESTING stage
   - Then `/test` runs persona tests

## Open Questions

- [ ] Should the factory hook also handle the `testing` stage? (currently only scouting + building)
- [ ] Reddit URLs are blocked by anti-bot — swap to RSS feeds or Reddit JSON API (`/r/sub/.json`)
- [ ] Exec approval gating in OpenClaw prevents the agent from running npm/tsc/vitest — can this be configured?

## Files Modified This Session (Not Yet Committed)

| File                                   | Status   |
| -------------------------------------- | -------- |
| `extensions/salesbot/index.ts`         | Modified |
| `extensions/salesbot/src/approval.ts`  | Modified |
| `extensions/scaffold-factory/index.ts` | Modified |

## What NOT to Re-Read

- The full OpenClaw source — only relevant bits are the plugin types at `src/plugins/types.ts` and `src/auto-reply/types.ts`
- Gateway logs — ephemeral, new session won't need them
