import { Type, type TSchema } from "@sinclair/typebox";
import type { SalesbotDb } from "./db.js";

type ToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
  }>;
};

function jsonResult(data: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [
      { type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) },
    ],
    details: data,
  };
}

/**
 * Build the array of sales tools for OpenClaw's registerTool API.
 * Each tool uses TypeBox Type.Unsafe to wrap JSON schemas as parameters.
 */
export function createSalesTools(db: SalesbotDb): ToolDef[] {
  return [
    // --- Pipeline Tools ---

    {
      name: "sales_add_prospect",
      label: "Add Prospect",
      description:
        "Add a new prospect to the sales pipeline. Use after researching a travel influencer/creator.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          name: { type: "string", description: "Creator/influencer name" },
          email: { type: "string", description: "Contact email" },
          platform: {
            type: "string",
            enum: ["youtube", "blog", "instagram", "tiktok", "twitter", "podcast"],
            description: "Primary platform",
          },
          channel_url: { type: "string", description: "URL to their channel/profile" },
          subscriber_count: { type: "number", description: "Subscriber/follower count" },
          niche: {
            type: "string",
            description: "Content niche (e.g., budget travel, adventure travel)",
          },
          notes: { type: "string", description: "Research notes about this creator" },
        },
        required: ["name"],
      }),
      execute: async (_id, args) => {
        const duplicate = db.checkDuplicate(args.email as string);
        if (duplicate.isDuplicate) {
          return jsonResult({
            error: "Duplicate prospect",
            existing: duplicate.existing,
            message: `Prospect with email "${args.email}" already exists (ID: ${duplicate.existing!.id}, stage: ${duplicate.existing!.stage})`,
          });
        }
        return jsonResult(db.addProspect(args as Parameters<typeof db.addProspect>[0]));
      },
    },

    {
      name: "sales_update_prospect",
      label: "Update Prospect",
      description: "Update an existing prospect's information.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          id: { type: "number", description: "Prospect ID" },
          name: { type: "string" },
          email: { type: "string" },
          platform: { type: "string" },
          channel_url: { type: "string" },
          subscriber_count: { type: "number" },
          niche: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
      }),
      execute: async (_id, args) => {
        const { id, ...updates } = args;
        delete updates.stage;
        return jsonResult(
          db.updateProspect(id as number, updates) || {
            error: "Prospect not found or no valid updates",
          },
        );
      },
    },

    {
      name: "sales_query_prospects",
      label: "Query Prospects",
      description: "Query prospects in the pipeline with optional filters.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          stage: {
            type: "string",
            enum: [
              "researched",
              "drafted",
              "pending_approval",
              "approved",
              "sent",
              "responded",
              "converted",
              "rejected",
            ],
          },
          platform: { type: "string" },
          niche: { type: "string", description: "Partial match on niche" },
          limit: { type: "number", description: "Max results (default 50)" },
          offset: { type: "number" },
        },
      }),
      execute: async (_id, args) => {
        const results = db.queryProspects(args as Parameters<typeof db.queryProspects>[0]);
        return jsonResult({ count: results.length, prospects: results });
      },
    },

    {
      name: "sales_get_prospect",
      label: "Get Prospect",
      description: "Get full details for a specific prospect including their drafts.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          id: { type: "number", description: "Prospect ID" },
        },
        required: ["id"],
      }),
      execute: async (_id, args) => {
        const prospect = db.getProspect(args.id as number);
        if (!prospect) return jsonResult({ error: "Prospect not found" });
        const drafts = db.getDraftsForProspect(args.id as number);
        const activity = db.getActivityLog({ prospectId: args.id as number, limit: 10 });
        return jsonResult({ ...prospect, drafts, recentActivity: activity });
      },
    },

    // --- Outreach Tools ---

    {
      name: "sales_save_draft",
      label: "Save Draft",
      description:
        "Save an outreach email draft for a prospect. The draft will need approval before sending.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          prospect_id: { type: "number", description: "Prospect ID" },
          subject: { type: "string", description: "Email subject line" },
          body: {
            type: "string",
            description: "Email body text (keep under 150 words, genuine tone)",
          },
        },
        required: ["prospect_id", "subject", "body"],
      }),
      execute: async (_id, args) => {
        const guardrails = db.checkGuardrails();
        if (!guardrails.canDraftMore) {
          return jsonResult({
            error: "Draft limit reached",
            message: `Max ${guardrails.maxDraftsPerBatch} pending drafts allowed. Review or clear existing drafts first.`,
            currentPending: guardrails.currentPendingDrafts,
          });
        }
        const result = db.addDraft(args as { prospect_id: number; subject: string; body: string });
        db.advanceStage(args.prospect_id as number, "drafted");
        return jsonResult(result);
      },
    },

    {
      name: "sales_submit_for_approval",
      label: "Submit for Approval",
      description:
        "Submit a draft for owner approval. This sends a notification to the owner with the draft preview and approve/reject instructions. NEVER send emails without going through this approval flow.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          draft_id: { type: "number", description: "Draft ID to submit for approval" },
        },
        required: ["draft_id"],
      }),
      execute: async (_id, args) => {
        const d = db.updateDraft(args.draft_id as number, { status: "pending_approval" });
        if (!d) return jsonResult({ error: "Draft not found" });
        const prospect = db.getProspect(d.prospect_id);
        db.advanceStage(d.prospect_id, "pending_approval");
        return jsonResult({
          success: true,
          message: "Draft submitted for approval. Owner has been notified.",
          draft_id: args.draft_id,
          prospect_name: prospect?.name,
        });
      },
    },

    {
      name: "sales_get_pending_approvals",
      label: "Get Pending Approvals",
      description: "Get all drafts waiting for owner approval.",
      parameters: Type.Unsafe({ type: "object", properties: {} }),
      execute: async () => {
        const pending = db.getPendingDrafts();
        return jsonResult({ count: pending.length, drafts: pending });
      },
    },

    {
      name: "sales_record_send",
      label: "Record Send",
      description:
        "Record that an approved email was sent. Called after the email is actually sent.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          draft_id: { type: "number", description: "Draft ID that was sent" },
          sent_via: { type: "string", description: "How it was sent (e.g., composio_gmail)" },
        },
        required: ["draft_id"],
      }),
      execute: async (_id, args) => {
        const d = db.updateDraft(args.draft_id as number, { status: "sent" });
        if (!d) return jsonResult({ error: "Draft not found" });
        db.advanceStage(d.prospect_id, "sent");
        db.logActivity(
          d.prospect_id,
          "email_sent",
          `Draft #${args.draft_id} sent via ${args.sent_via || "email"}`,
        );
        return jsonResult({
          success: true,
          draft_id: args.draft_id,
          prospect_id: d.prospect_id,
          sent_via: args.sent_via || "email",
        });
      },
    },

    // --- Referral Tools ---

    {
      name: "sales_generate_referral_code",
      label: "Generate Referral Code",
      description: "Generate a unique referral code for a prospect/affiliate.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          prospect_id: { type: "number", description: "Prospect ID to generate code for" },
          tier: {
            type: "string",
            enum: ["standard", "silver", "gold", "platinum"],
            description: "Referral tier (default: standard)",
          },
        },
        required: ["prospect_id"],
      }),
      execute: async (_id, args) => {
        return jsonResult(
          db.generateReferralCode(args.prospect_id as number, (args.tier as string) || "standard"),
        );
      },
    },

    {
      name: "sales_get_referral_stats",
      label: "Get Referral Stats",
      description: "Get referral statistics for a specific code.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          code: { type: "string", description: "Referral code" },
        },
        required: ["code"],
      }),
      execute: async (_id, args) => {
        return jsonResult(db.getReferralStats(args.code as string) || { error: "Code not found" });
      },
    },

    // --- Guardrail Tools ---

    {
      name: "sales_check_guardrails",
      label: "Check Guardrails",
      description:
        "Check current guardrail status - daily send limits, cooldowns, and draft limits. ALWAYS check this before creating drafts or sending emails.",
      parameters: Type.Unsafe({ type: "object", properties: {} }),
      execute: async () => {
        return jsonResult(db.checkGuardrails());
      },
    },

    {
      name: "sales_check_duplicate",
      label: "Check Duplicate",
      description: "Check if a prospect with this email already exists in the pipeline.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          email: { type: "string", description: "Email to check for duplicates" },
        },
        required: ["email"],
      }),
      execute: async (_id, args) => {
        return jsonResult(db.checkDuplicate(args.email as string));
      },
    },

    // --- Metrics & Activity Tools ---

    {
      name: "sales_get_metrics",
      label: "Get Metrics",
      description:
        "Get comprehensive sales metrics: pipeline breakdown, email stats, goals progress, referral stats.",
      parameters: Type.Unsafe({ type: "object", properties: {} }),
      execute: async () => {
        return jsonResult(db.getMetrics());
      },
    },

    {
      name: "sales_set_goal",
      label: "Set Goal",
      description: "Set or update a sales goal.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          metric: {
            type: "string",
            enum: [
              "affiliates",
              "referrals",
              "page_visits",
              "free_trials",
              "subscriptions",
              "revenue",
            ],
            description: "Goal metric",
          },
          target_value: { type: "number", description: "Target value" },
          period: {
            type: "string",
            enum: ["daily", "weekly", "monthly"],
            description: "Time period (default: weekly)",
          },
        },
        required: ["metric", "target_value"],
      }),
      execute: async (_id, args) => {
        return jsonResult(
          db.setGoal(args as { metric: string; target_value: number; period?: string }),
        );
      },
    },

    {
      name: "sales_get_activity_log",
      label: "Get Activity Log",
      description: "Get recent activity log entries, optionally filtered by prospect.",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          prospect_id: { type: "number", description: "Filter by prospect ID" },
          limit: { type: "number", description: "Max entries (default 50)" },
        },
      }),
      execute: async (_id, args) => {
        const log = db.getActivityLog({
          prospectId: args.prospect_id as number,
          limit: args.limit as number,
        });
        return jsonResult({ count: log.length, entries: log });
      },
    },
  ];
}
