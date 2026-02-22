import path from "node:path";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { ApprovalManager } from "./src/approval.js";
import { SalesbotDb } from "./src/db.js";
import { createSalesTools } from "./src/tools.js";

/**
 * Build the sales-specific system prompt context that gets injected
 * into the agent's system prompt via the before_prompt_build hook.
 */
function buildSalesContext(db: SalesbotDb, approval: ApprovalManager): string {
  let pipelineContext: string;
  try {
    pipelineContext = approval.getPipelineSummary();
  } catch {
    pipelineContext = "Pipeline empty - time to find some creators!";
  }

  return `## Voygent Sales Assistant Context

You have access to sales pipeline tools for managing influencer outreach for Voygent, an AI-powered travel planning platform.

### About Voygent
Voygent creates personalized, detailed trip itineraries with booking links, budget tracking, and collaborative planning.

### Pipeline Stages
1. researched - Creator identified
2. drafted - Outreach email draft created
3. pending_approval - Draft submitted for owner review
4. approved - Owner approved the draft
5. sent - Email sent to creator
6. responded - Creator replied
7. converted - Creator became an affiliate
8. rejected - Rejected at any point

### Critical Rules
- ALWAYS call sales_check_guardrails before creating drafts or sending emails
- NEVER send emails without owner approval (use sales_submit_for_approval)
- ALWAYS call sales_check_duplicate before adding a new prospect
- Keep emails under 150 words, genuine tone, NO corporate language
- Reference SPECIFIC content the creator has made
- Target: 1,000-500,000 subscribers (sweet spot for engagement)

### Email Guidelines
- Subject: Something about their content (NOT "Partnership Opportunity")
- Opening: 1-2 sentences referencing specific content
- Offer: Free Voygent Pro + referral code (60-day vs normal 30-day trial for their audience)
- CTA: "Would you be interested in trying Voygent free?"

### Current Pipeline Status
${pipelineContext}

### Available Sales Tools
- sales_add_prospect, sales_update_prospect, sales_query_prospects, sales_get_prospect
- sales_save_draft, sales_submit_for_approval, sales_get_pending_approvals, sales_record_send
- sales_generate_referral_code, sales_get_referral_stats
- sales_check_guardrails, sales_check_duplicate
- sales_get_metrics, sales_set_goal, sales_get_activity_log
`;
}

export default function register(api: OpenClawPluginApi) {
  const stateDir = path.join(api.runtime.state.resolveStateDir(), "plugins", "salesbot");
  const db = new SalesbotDb(stateDir);
  const approval = new ApprovalManager(db);

  // --- Register all 15 sales tools ---

  const tools = createSalesTools(db);
  api.registerTool((_ctx) => tools as unknown as AnyAgentTool[], {
    names: tools.map((t) => t.name),
  });

  // --- Commands ---

  api.registerCommand({
    name: "sales-approve",
    description: "Approve a sales outreach draft for sending",
    acceptsArgs: true,
    handler: async (ctx) => {
      const draftId = parseInt(ctx.args?.trim() || "", 10);
      if (isNaN(draftId)) {
        return { text: "Usage: /sales-approve <draft_id>" };
      }

      const result = approval.handleApprove(draftId);
      return { text: result.message };
    },
  });

  api.registerCommand({
    name: "reject",
    description: "Reject a sales outreach draft with optional feedback",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() || "";
      const parts = args.split(/\s+/);
      const draftId = parseInt(parts[0] || "", 10);
      if (isNaN(draftId)) {
        return { text: "Usage: /reject <draft_id> [feedback]" };
      }

      const feedback = parts.slice(1).join(" ");
      const result = approval.handleReject(draftId, feedback);
      return { text: result.message };
    },
  });

  api.registerCommand({
    name: "pipeline",
    description: "Show the sales pipeline status and metrics",
    acceptsArgs: false,
    handler: async () => {
      return { text: approval.getPipelineSummary() };
    },
  });

  api.registerCommand({
    name: "sales",
    description: "Show the sales pipeline status and metrics",
    acceptsArgs: false,
    handler: async () => {
      return { text: approval.getPipelineSummary() };
    },
  });

  // --- Inject sales context into agent system prompt ---

  api.on("before_prompt_build", async (_event, _ctx) => {
    const context = buildSalesContext(db, approval);
    return { prependContext: context };
  });

  // --- Cleanup on gateway stop ---

  api.registerService({
    id: "salesbot-db",
    start: async () => {
      api.logger.info("salesbot: database initialized");
    },
    stop: async () => {
      db.close();
      api.logger.info("salesbot: database closed");
    },
  });
}
