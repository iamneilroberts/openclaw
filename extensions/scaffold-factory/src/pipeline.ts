import type { FactoryStore, Cycle } from "./store.js";

export const STAGES = [
  "scouting",
  "building",
  "testing",
  "judging",
  "guarding",
  "documenting",
  "publishing",
  "complete",
] as const;

export type Stage = (typeof STAGES)[number];

const STAGE_ORDER = Object.fromEntries(STAGES.map((s, i) => [s, i])) as Record<Stage, number>;

const CHECKPOINTS: Partial<Record<Stage, keyof Cycle["checkpoints"]>> = {
  scouting: "scout_approved",
  building: "build_approved",
  documenting: "publish_approved",
};

export class Pipeline {
  constructor(private store: FactoryStore) {}

  getNextStage(currentStage: string): Stage | null {
    const idx = STAGE_ORDER[currentStage as Stage];
    if (idx === undefined || idx >= STAGES.length - 1) return null;
    return STAGES[idx + 1];
  }

  canAdvance(cycle: Cycle): { allowed: boolean; reason?: string } {
    const checkpoint = CHECKPOINTS[cycle.status as Stage];
    if (checkpoint && !cycle.checkpoints[checkpoint]) {
      return {
        allowed: false,
        reason: `Checkpoint "${checkpoint}" not approved. Use the appropriate approve command.`,
      };
    }
    return { allowed: true };
  }

  advanceStage(cycleId: string): {
    advanced: boolean;
    from?: string;
    to?: string;
    reason?: string;
  } {
    const cycle = this.store.getCycle(cycleId);
    if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

    const check = this.canAdvance(cycle);
    if (!check.allowed) return { advanced: false, reason: check.reason };

    const next = this.getNextStage(cycle.status);
    if (!next) return { advanced: false, reason: "Already at final stage" };

    this.store.updateCycle(cycleId, { status: next });
    return { advanced: true, from: cycle.status, to: next };
  }

  approveCheckpoint(
    cycleId: string,
    checkpointName: keyof Cycle["checkpoints"],
  ): { approved: boolean; checkpoint?: string; reason?: string } {
    const cycle = this.store.getCycle(cycleId);
    if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

    if (!Object.prototype.hasOwnProperty.call(cycle.checkpoints, checkpointName)) {
      throw new Error(`Unknown checkpoint: ${checkpointName}`);
    }

    if (cycle.checkpoints[checkpointName]) {
      return { approved: false, reason: "Already approved" };
    }

    const checkpoints = { ...cycle.checkpoints, [checkpointName]: new Date().toISOString() };
    this.store.updateCycle(cycleId, { checkpoints });
    return { approved: true, checkpoint: checkpointName };
  }

  rejectWithFeedback(
    cycleId: string,
    targetStage: string,
    feedback: string,
  ): { rejected: boolean; rolledBackTo: string } {
    const cycle = this.store.getCycle(cycleId);
    if (!cycle) throw new Error(`Cycle ${cycleId} not found`);

    this.store.updateCycle(cycleId, {
      status: targetStage,
      rejectionFeedback: feedback,
      iterations: {
        ...cycle.iterations,
        build: (cycle.iterations.build || 0) + 1,
      },
    });

    return { rejected: true, rolledBackTo: targetStage };
  }

  getStatus(cycleId: string) {
    const cycle = this.store.getCycle(cycleId);
    if (!cycle) return null;

    const stageIdx = STAGE_ORDER[cycle.status as Stage] ?? 0;
    const totalStages = STAGES.length - 1;
    const progress = Math.round((stageIdx / totalStages) * 100);

    return {
      cycleId: cycle.cycleId,
      status: cycle.status,
      progress: `${progress}%`,
      idea: cycle.idea ? { title: cycle.idea.title, summary: cycle.idea.summary } : null,
      appName: cycle.appName || null,
      checkpoints: cycle.checkpoints,
      iterations: cycle.iterations,
      pendingCheckpoint: CHECKPOINTS[cycle.status as Stage] || null,
      createdAt: cycle.createdAt,
      updatedAt: cycle.updatedAt,
    };
  }

  failCycle(cycleId: string, reason: string): void {
    this.store.updateCycle(cycleId, { status: "failed", failureReason: reason });
  }
}
