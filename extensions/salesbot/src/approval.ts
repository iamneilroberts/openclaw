import type { SalesbotDb, Prospect, Draft } from "./db.js";

/**
 * Approval manager for salesbot outreach.
 * Handles human-in-the-loop review of email drafts.
 *
 * In OpenClaw, notifications are sent via the channel's reply dispatcher
 * instead of directly accessing gateway adapters.
 */
export class ApprovalManager {
  constructor(private db: SalesbotDb) {}

  /**
   * Format an approval notification message.
   */
  formatApprovalNotification(args: {
    draftId: number;
    prospect: Prospect | null;
    subject: string;
    body: string;
    version: number;
  }): string {
    return [
      `OUTREACH APPROVAL REQUEST #${args.draftId}`,
      "",
      `Prospect: ${args.prospect?.name || "Unknown"}`,
      args.prospect?.channel_url ? `Channel: ${args.prospect.channel_url}` : "",
      args.prospect?.subscriber_count
        ? `Subscribers: ${args.prospect.subscriber_count.toLocaleString()}`
        : "",
      args.prospect?.niche ? `Niche: ${args.prospect.niche}` : "",
      "",
      `--- Draft v${args.version} ---`,
      `Subject: ${args.subject}`,
      "",
      args.body,
      "",
      "--- Actions ---",
      `/approve ${args.draftId}`,
      `/reject ${args.draftId} [optional feedback]`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /**
   * Handle /approve command.
   */
  handleApprove(draftId: number): {
    success: boolean;
    message: string;
    draft?: Draft | null;
    prospect?: Prospect | null;
  } {
    const draft = this.db.updateDraft(draftId, { status: "approved" });
    if (!draft) {
      return { success: false, message: `Draft #${draftId} not found` };
    }

    const prospect = this.db.getProspect(draft.prospect_id);
    this.db.advanceStage(draft.prospect_id, "approved");
    this.db.logActivity(draft.prospect_id, "draft_approved", `Draft #${draftId} approved by owner`);

    return {
      success: true,
      message: `Draft #${draftId} approved for ${prospect?.name || "unknown"}. The agent will send it via email.`,
      draft,
      prospect,
    };
  }

  /**
   * Handle /reject command.
   */
  handleReject(
    draftId: number,
    feedback: string = "",
  ): {
    success: boolean;
    message: string;
    draft?: Draft | null;
    prospect?: Prospect | null;
  } {
    const draft = this.db.updateDraft(draftId, {
      status: "rejected",
      owner_feedback: feedback || null,
    });
    if (!draft) {
      return { success: false, message: `Draft #${draftId} not found` };
    }

    const prospect = this.db.getProspect(draft.prospect_id);
    this.db.advanceStage(draft.prospect_id, "rejected");
    this.db.logActivity(
      draft.prospect_id,
      "draft_rejected",
      feedback ? `Rejected with feedback: ${feedback}` : "Rejected by owner",
    );

    return {
      success: true,
      message: `Draft #${draftId} rejected${feedback ? ". Feedback: " + feedback : ""}`,
      draft,
      prospect,
    };
  }

  /**
   * Get formatted pipeline summary.
   */
  getPipelineSummary(): string {
    const metrics = this.db.getMetrics();
    const pending = this.db.getPendingDrafts();
    const guardrails = this.db.checkGuardrails();

    const lines = [
      "SALES PIPELINE",
      "",
      "--- Stage Breakdown ---",
      ...Object.entries(metrics.pipeline).map(([stage, count]) => `  ${stage}: ${count}`),
      "",
      `Total prospects: ${metrics.totalProspects}`,
      `Emails sent: ${metrics.sentEmails} (${metrics.todaySent} today)`,
      `Pending approvals: ${metrics.pendingApprovals}`,
      `Referral codes: ${metrics.referralCodes.count}`,
      "",
      "--- Guardrails ---",
      `Send limit: ${guardrails.sentToday}/${guardrails.maxEmailsPerDay} today`,
      `Draft limit: ${guardrails.currentPendingDrafts}/${guardrails.maxDraftsPerBatch} pending`,
      `Cooldown: ${guardrails.cooldownDays} days`,
    ];

    if (pending.length > 0) {
      lines.push("", "--- Pending Approvals ---");
      for (const d of pending) {
        lines.push(`  #${d.id}: ${d.prospect_name} - "${d.subject}"`);
      }
    }

    return lines.join("\n");
  }
}
