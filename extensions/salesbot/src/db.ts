import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// --- Types ---

export interface Prospect {
  id: number;
  name: string;
  email: string | null;
  platform: string;
  channel_url: string | null;
  subscriber_count: number | null;
  niche: string | null;
  notes: string | null;
  stage: string;
  referral_code: string | null;
  cooldown_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Draft {
  id: number;
  prospect_id: number;
  subject: string;
  body: string;
  version: number;
  status: string;
  owner_feedback: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftWithProspect extends Draft {
  prospect_name: string;
  channel_url: string | null;
  subscriber_count: number | null;
}

export interface ReferralCode {
  code: string;
  prospect_id: number | null;
  free_months_referrer: number;
  free_months_referee: number;
  tier: string;
  referral_count: number;
  created_at: string;
}

export interface ActivityEntry {
  id: number;
  prospect_id: number | null;
  action: string;
  details: string | null;
  created_at: string;
}

export interface Goal {
  id: number;
  metric: string;
  target_value: number;
  current_value: number;
  period: string;
  period_start: string;
}

export interface Guardrails {
  maxEmailsPerDay: number;
  sentToday: number;
  canSendMore: boolean;
  remainingToday: number;
  maxDraftsPerBatch: number;
  currentPendingDrafts: number;
  canDraftMore: boolean;
  cooldownDays: number;
}

export interface Metrics {
  pipeline: Record<string, number>;
  totalProspects: number;
  totalDrafts: number;
  pendingApprovals: number;
  sentEmails: number;
  todaySent: number;
  goals: Goal[];
  referralCodes: { count: number; totalReferrals: number };
}

// --- DB Class ---

export class SalesbotDb {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(stateDir: string) {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    this.dbPath = path.join(stateDir, "pipeline.db");
  }

  private getDb(): Database.Database {
    if (this.db) return this.db;

    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
    return this.db;
  }

  private initSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS prospects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT,
        platform TEXT DEFAULT 'youtube',
        channel_url TEXT,
        subscriber_count INTEGER,
        niche TEXT,
        notes TEXT,
        stage TEXT DEFAULT 'researched',
        referral_code TEXT,
        cooldown_until TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outreach_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        status TEXT DEFAULT 'draft',
        owner_feedback TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (prospect_id) REFERENCES prospects(id)
      );

      CREATE TABLE IF NOT EXISTS referral_codes (
        code TEXT PRIMARY KEY,
        prospect_id INTEGER,
        free_months_referrer INTEGER DEFAULT 1,
        free_months_referee INTEGER DEFAULT 1,
        tier TEXT DEFAULT 'standard',
        referral_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (prospect_id) REFERENCES prospects(id)
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prospect_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (prospect_id) REFERENCES prospects(id)
      );

      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric TEXT NOT NULL,
        target_value REAL NOT NULL,
        current_value REAL DEFAULT 0,
        period TEXT DEFAULT 'weekly',
        period_start TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS guardrails (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prospects_stage ON prospects(stage);
      CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email);
      CREATE INDEX IF NOT EXISTS idx_drafts_status ON outreach_drafts(status);
      CREATE INDEX IF NOT EXISTS idx_drafts_prospect ON outreach_drafts(prospect_id);
      CREATE INDEX IF NOT EXISTS idx_activity_prospect ON activity_log(prospect_id);
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
    `);

    // Seed default guardrails if empty
    const count = this.db!.prepare("SELECT COUNT(*) as c FROM guardrails").get() as { c: number };
    if (count.c === 0) {
      const insert = this.db!.prepare(
        "INSERT OR IGNORE INTO guardrails (key, value) VALUES (?, ?)",
      );
      insert.run("max_emails_per_day", "10");
      insert.run("cooldown_days", "14");
      insert.run("max_drafts_per_batch", "5");
    }
  }

  // --- Prospects ---

  addProspect(args: {
    name: string;
    email?: string;
    platform?: string;
    channel_url?: string;
    subscriber_count?: number;
    niche?: string;
    notes?: string;
  }): { id: number; name: string; stage: string } {
    const d = this.getDb();
    const stmt = d.prepare(`
      INSERT INTO prospects (name, email, platform, channel_url, subscriber_count, niche, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      args.name,
      args.email || null,
      args.platform || "youtube",
      args.channel_url || null,
      args.subscriber_count || null,
      args.niche || null,
      args.notes || null,
    );
    this.logActivity(result.lastInsertRowid as number, "added", `Prospect "${args.name}" added`);
    return { id: result.lastInsertRowid as number, name: args.name, stage: "researched" };
  }

  updateProspect(id: number, updates: Record<string, unknown>): Prospect | null {
    const d = this.getDb();
    const allowed = [
      "name",
      "email",
      "platform",
      "channel_url",
      "subscriber_count",
      "niche",
      "notes",
      "stage",
      "referral_code",
      "cooldown_until",
    ];
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }

    if (fields.length === 0) return null;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    d.prepare(`UPDATE prospects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getProspect(id);
  }

  getProspect(id: number): Prospect | null {
    const d = this.getDb();
    return (d.prepare("SELECT * FROM prospects WHERE id = ?").get(id) as Prospect) || null;
  }

  queryProspects(
    args: {
      stage?: string;
      platform?: string;
      niche?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Prospect[] {
    const d = this.getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.stage) {
      conditions.push("stage = ?");
      params.push(args.stage);
    }
    if (args.platform) {
      conditions.push("platform = ?");
      params.push(args.platform);
    }
    if (args.niche) {
      conditions.push("niche LIKE ?");
      params.push(`%${args.niche}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM prospects ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(args.limit || 50, args.offset || 0);

    return d.prepare(sql).all(...params) as Prospect[];
  }

  // --- Outreach Drafts ---

  addDraft(args: { prospect_id: number; subject: string; body: string }): {
    id: number;
    prospect_id: number;
    version: number;
    status: string;
  } {
    const d = this.getDb();
    const latest = d
      .prepare("SELECT MAX(version) as v FROM outreach_drafts WHERE prospect_id = ?")
      .get(args.prospect_id) as { v: number | null };
    const version = (latest?.v || 0) + 1;

    const stmt = d.prepare(`
      INSERT INTO outreach_drafts (prospect_id, subject, body, version)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(args.prospect_id, args.subject, args.body, version);
    this.logActivity(args.prospect_id, "draft_created", `Draft v${version} created`);
    return {
      id: result.lastInsertRowid as number,
      prospect_id: args.prospect_id,
      version,
      status: "draft",
    };
  }

  updateDraft(id: number, updates: Record<string, unknown>): Draft | null {
    const d = this.getDb();
    const allowed = ["subject", "body", "status", "owner_feedback"];
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, val] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
    }

    if (fields.length === 0) return null;

    fields.push("updated_at = datetime('now')");
    values.push(id);

    d.prepare(`UPDATE outreach_drafts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return (d.prepare("SELECT * FROM outreach_drafts WHERE id = ?").get(id) as Draft) || null;
  }

  getPendingDrafts(): DraftWithProspect[] {
    const d = this.getDb();
    return d
      .prepare(`
      SELECT d.*, p.name as prospect_name, p.channel_url, p.subscriber_count
      FROM outreach_drafts d
      JOIN prospects p ON d.prospect_id = p.id
      WHERE d.status = 'pending_approval'
      ORDER BY d.created_at DESC
    `)
      .all() as DraftWithProspect[];
  }

  getDraftsForProspect(prospectId: number): Draft[] {
    const d = this.getDb();
    return d
      .prepare("SELECT * FROM outreach_drafts WHERE prospect_id = ? ORDER BY version DESC")
      .all(prospectId) as Draft[];
  }

  // --- Referral Codes ---

  generateReferralCode(
    prospectId: number,
    tier: string = "standard",
  ): { code: string; tier: string; free_months_referrer: number; free_months_referee: number } {
    const d = this.getDb();
    const code = "VYG-" + crypto.randomBytes(4).toString("hex").toUpperCase();

    const tierConfig: Record<string, { referrer: number; referee: number }> = {
      standard: { referrer: 1, referee: 1 },
      silver: { referrer: 2, referee: 1 },
      gold: { referrer: 3, referee: 2 },
      platinum: { referrer: 6, referee: 3 },
    };

    const months = tierConfig[tier] || tierConfig.standard!;

    d.prepare(`
      INSERT INTO referral_codes (code, prospect_id, free_months_referrer, free_months_referee, tier)
      VALUES (?, ?, ?, ?, ?)
    `).run(code, prospectId, months.referrer, months.referee, tier);

    if (prospectId) {
      d.prepare("UPDATE prospects SET referral_code = ? WHERE id = ?").run(code, prospectId);
    }

    this.logActivity(prospectId, "referral_code_generated", `Code: ${code} (${tier})`);
    return {
      code,
      tier,
      free_months_referrer: months.referrer,
      free_months_referee: months.referee,
    };
  }

  getReferralStats(code: string): ReferralCode | null {
    const d = this.getDb();
    return (
      (d.prepare("SELECT * FROM referral_codes WHERE code = ?").get(code) as ReferralCode) || null
    );
  }

  // --- Activity Log ---

  logActivity(prospectId: number | null, action: string, details?: string): void {
    const d = this.getDb();
    d.prepare("INSERT INTO activity_log (prospect_id, action, details) VALUES (?, ?, ?)").run(
      prospectId || null,
      action,
      details || null,
    );
  }

  getActivityLog(args: { prospectId?: number; limit?: number } = {}): ActivityEntry[] {
    const d = this.getDb();
    if (args.prospectId) {
      return d
        .prepare(
          "SELECT * FROM activity_log WHERE prospect_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(args.prospectId, args.limit || 50) as ActivityEntry[];
    }
    return d
      .prepare("SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?")
      .all(args.limit || 50) as ActivityEntry[];
  }

  // --- Goals ---

  setGoal(args: { metric: string; target_value: number; period?: string; period_start?: string }): {
    id: number;
    metric: string;
    target_value: number;
    updated?: boolean;
    created?: boolean;
  } {
    const d = this.getDb();
    const existing = d
      .prepare("SELECT id FROM goals WHERE metric = ? AND period = ?")
      .get(args.metric, args.period || "weekly") as { id: number } | undefined;

    if (existing) {
      d.prepare("UPDATE goals SET target_value = ?, period_start = ? WHERE id = ?").run(
        args.target_value,
        args.period_start || new Date().toISOString(),
        existing.id,
      );
      return {
        id: existing.id,
        metric: args.metric,
        target_value: args.target_value,
        updated: true,
      };
    }

    const result = d
      .prepare("INSERT INTO goals (metric, target_value, period, period_start) VALUES (?, ?, ?, ?)")
      .run(
        args.metric,
        args.target_value,
        args.period || "weekly",
        args.period_start || new Date().toISOString(),
      );
    return {
      id: result.lastInsertRowid as number,
      metric: args.metric,
      target_value: args.target_value,
      created: true,
    };
  }

  getMetrics(): Metrics {
    const d = this.getDb();

    const stageCount = d
      .prepare("SELECT stage, COUNT(*) as count FROM prospects GROUP BY stage")
      .all() as Array<{ stage: string; count: number }>;
    const totalProspects = (
      d.prepare("SELECT COUNT(*) as count FROM prospects").get() as { count: number }
    ).count;
    const totalDrafts = (
      d.prepare("SELECT COUNT(*) as count FROM outreach_drafts").get() as { count: number }
    ).count;
    const pendingApprovals = (
      d
        .prepare("SELECT COUNT(*) as count FROM outreach_drafts WHERE status = 'pending_approval'")
        .get() as { count: number }
    ).count;
    const sentEmails = (
      d.prepare("SELECT COUNT(*) as count FROM outreach_drafts WHERE status = 'sent'").get() as {
        count: number;
      }
    ).count;
    const todaySent = (
      d
        .prepare(
          "SELECT COUNT(*) as count FROM outreach_drafts WHERE status = 'sent' AND date(updated_at) = date('now')",
        )
        .get() as { count: number }
    ).count;
    const goals = d.prepare("SELECT * FROM goals").all() as Goal[];
    const referralCodes = d
      .prepare(
        "SELECT COUNT(*) as count, SUM(referral_count) as total_referrals FROM referral_codes",
      )
      .get() as { count: number; total_referrals: number | null };

    return {
      pipeline: Object.fromEntries(stageCount.map((r) => [r.stage, r.count])),
      totalProspects,
      totalDrafts,
      pendingApprovals,
      sentEmails,
      todaySent,
      goals,
      referralCodes: {
        count: referralCodes.count,
        totalReferrals: referralCodes.total_referrals || 0,
      },
    };
  }

  // --- Guardrails ---

  checkGuardrails(): Guardrails {
    const d = this.getDb();
    const guardrails: Record<string, string> = {};
    for (const row of d.prepare("SELECT * FROM guardrails").all() as Array<{
      key: string;
      value: string;
    }>) {
      guardrails[row.key] = row.value;
    }

    const maxPerDay = parseInt(guardrails.max_emails_per_day || "10", 10);
    const todaySent = (
      d
        .prepare(
          "SELECT COUNT(*) as count FROM outreach_drafts WHERE status = 'sent' AND date(updated_at) = date('now')",
        )
        .get() as { count: number }
    ).count;
    const pendingDrafts = (
      d
        .prepare(
          "SELECT COUNT(*) as count FROM outreach_drafts WHERE status IN ('draft', 'pending_approval')",
        )
        .get() as { count: number }
    ).count;
    const maxDrafts = parseInt(guardrails.max_drafts_per_batch || "5", 10);

    return {
      maxEmailsPerDay: maxPerDay,
      sentToday: todaySent,
      canSendMore: todaySent < maxPerDay,
      remainingToday: Math.max(0, maxPerDay - todaySent),
      maxDraftsPerBatch: maxDrafts,
      currentPendingDrafts: pendingDrafts,
      canDraftMore: pendingDrafts < maxDrafts,
      cooldownDays: parseInt(guardrails.cooldown_days || "14", 10),
    };
  }

  setGuardrail(key: string, value: string): { key: string; value: string } {
    const d = this.getDb();
    d.prepare("INSERT OR REPLACE INTO guardrails (key, value) VALUES (?, ?)").run(
      key,
      String(value),
    );
    return { key, value };
  }

  checkDuplicate(email: string): {
    isDuplicate: boolean;
    existing: { id: number; name: string; stage: string } | null;
  } {
    if (!email) return { isDuplicate: false, existing: null };
    const d = this.getDb();
    const existing = d
      .prepare("SELECT id, name, stage FROM prospects WHERE email = ?")
      .get(email) as { id: number; name: string; stage: string } | undefined;
    return {
      isDuplicate: !!existing,
      existing: existing || null,
    };
  }

  advanceStage(id: number, newStage: string): Prospect | { error: string } | null {
    const d = this.getDb();
    const prospect = d.prepare("SELECT * FROM prospects WHERE id = ?").get(id) as
      | Prospect
      | undefined;
    if (!prospect) return null;

    const validTransitions: Record<string, string[]> = {
      researched: ["drafted"],
      drafted: ["pending_approval"],
      pending_approval: ["approved", "rejected"],
      approved: ["sent"],
      sent: ["responded", "converted"],
      responded: ["converted", "rejected"],
      rejected: ["researched"],
    };

    const allowed = validTransitions[prospect.stage] || [];
    if (!allowed.includes(newStage)) {
      return {
        error: `Cannot transition from "${prospect.stage}" to "${newStage}". Allowed: ${allowed.join(", ")}`,
      };
    }

    d.prepare("UPDATE prospects SET stage = ?, updated_at = datetime('now') WHERE id = ?").run(
      newStage,
      id,
    );
    this.logActivity(id, "stage_changed", `${prospect.stage} → ${newStage}`);
    return this.getProspect(id);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
