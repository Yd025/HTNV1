import type { SwarmState } from "./types";

type Timing = NonNullable<SwarmState["diagnostics"]>;
type Sample = { at: number; timing: Timing };
export type TickSummary = {
  runId: string | null; count: number; spanSeconds: number; p50: number | null; p95: number | null;
  max: number | null; overBudget: number; minBudget: number | null; maxBudget: number | null;
  worst: Timing | null;
  stages: { op: string; p95: number; max: number; share: number; errors: number }[];
};
const valid = (n: number) => Number.isFinite(n) && n >= 0;
function percentile(sorted: number[], fraction: number): number | null {
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
}

/** Browser-observed ticks only. Monotonic receipt time avoids backend clock skew. */
export class TickWindow {
  private samples: Sample[] = [];
  private seen = new Set<string>();
  private sequence = -1;
  private runId: string | null = null;
  constructor(private windowMs = 60000, private capacity = 1200) {}

  add(state: SwarmState, now: number, fresh: boolean): boolean {
    const runId = state.run?.run_id ?? null;
    if (runId !== this.runId) {
      this.runId = runId; this.samples = []; this.seen.clear(); this.sequence = -1;
    }
    this.prune(now);
    const d = state.diagnostics;
    const sequence = state.run?.sequence;
    if (!fresh || !d || !d.trace_id || this.seen.has(d.trace_id) || !valid(d.duration_ms) || !valid(d.budget_ms) || d.budget_ms === 0) return false;
    if (sequence != null && (!Number.isSafeInteger(sequence) || sequence <= this.sequence)) return false;
    if (sequence != null) this.sequence = sequence;
    // Copy the bounded wire data: a later render must not mutate saved evidence.
    const timing = { ...d, stages: (d.stages ?? []).slice(0, 128).filter(s => valid(s.duration_ms) && typeof s.op === "string").map(s => ({ ...s, op: s.op.slice(0, 80) })) };
    this.samples.push({ at: now, timing }); this.seen.add(d.trace_id);
    while (this.samples.length > this.capacity) this.removeFirst();
    return true;
  }

  private removeFirst() { const sample = this.samples.shift(); if (sample) this.seen.delete(sample.timing.trace_id); }
  private prune(now: number) { while (this.samples.length && this.samples[0].at <= now - this.windowMs) this.removeFirst(); }

  summarize(now: number): TickSummary {
    this.prune(now);
    const values = this.samples.map(s => s.timing.duration_ms).sort((a, b) => a - b);
    const budgets = this.samples.map(s => s.timing.budget_ms);
    const byStage = new Map<string, { values: number[]; errors: number }>();
    let worst: Timing | null = null;
    for (const { timing } of this.samples) {
      if (!worst || timing.duration_ms > worst.duration_ms) worst = timing;
      const tickStages = new Map<string, number>();
      for (const stage of timing.stages) {
        tickStages.set(stage.op, (tickStages.get(stage.op) ?? 0) + stage.duration_ms);
        const entry = byStage.get(stage.op) ?? { values: [], errors: 0 };
        if (stage.status !== "ok") entry.errors += 1;
        byStage.set(stage.op, entry);
      }
      for (const [op, duration] of tickStages) byStage.get(op)!.values.push(duration);
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    const stages = Array.from(byStage, ([op, data]) => {
      // An absent operation contributes zero time to that tick, not a new call.
      const sorted = [...Array(Math.max(0, values.length - data.values.length)).fill(0), ...data.values].sort((a, b) => a - b);
      return { op, p95: percentile(sorted, .95) ?? 0, max: sorted.at(-1) ?? 0,
        share: total ? data.values.reduce((sum, value) => sum + value, 0) / total : 0, errors: data.errors };
    }).sort((a, b) => a.op.localeCompare(b.op));
    return { runId: this.runId, count: values.length,
      spanSeconds: this.samples.length > 1 ? (this.samples.at(-1)!.at - this.samples[0].at) / 1000 : 0,
      p50: percentile(values, .5), p95: percentile(values, .95), max: values.at(-1) ?? null,
      overBudget: this.samples.filter(s => s.timing.duration_ms > s.timing.budget_ms).length,
      minBudget: budgets.length ? Math.min(...budgets) : null, maxBudget: budgets.length ? Math.max(...budgets) : null,
      worst, stages };
  }
}
