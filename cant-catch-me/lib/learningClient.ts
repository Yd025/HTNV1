import { GAME_RULES, SIMULATION_STEP, type GameState, type InputState, type WorldData } from './game';
import { LEARNING_POLICY, RULES_VERSION, WORLD_VERSION, type ControlSample, type FinishRequest, type LiveFrame, type StartResponse } from './learningTypes';
import { applyLearningLayout } from './learningWorld';
import { FLIGHT_ALGORITHM } from './surveillance';

const PENDING_KEY = 'cant-catch-me-pending-opening-attempts-v1';
const MAX_TICKS = Math.round(LEARNING_POLICY.maxSeconds * GAME_RULES.pace / SIMULATION_STEP);
const pending = new Map<string, FinishRequest>();
const sending = new Set<string>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Optional browser recording hooks; the deterministic recorder has no SDK dependency. */
type GameReplayHooks = {
  start: (attemptId: string, layoutVersion: number) => void;
  finish: (attemptId: string, outcome: FinishRequest['outcome']) => string | undefined;
};
let replayHooks: GameReplayHooks | null = null;
export function registerGameReplayHooks(hooks: GameReplayHooks | null): void { replayHooks = hooks; }

export type AttemptTransport = {
  live: (message: { attemptId: string; token: string; seq: number; frame: LiveFrame }) => Promise<void>;
  finish: (message: FinishRequest, leaving: boolean) => void;
  now: () => number;
};

function frameFor(state: GameState): LiveFrame {
  return {
    ...(state.algorithm === FLIGHT_ALGORITHM ? { algorithm: FLIGHT_ALGORITHM } : {}),
    time: state.time, status: state.status === 'ready' ? 'paused' : state.status,
    boat: { x: state.boat.x, z: state.boat.z, heading: state.boat.heading },
    towers: state.towers.map(({ id, x, z, heading, range, detecting }) => ({ id, x, z, heading, range, detecting })),
    drones: state.drones.map(({ id, x, z, heading, detecting, tagProgress, role, target }) => ({ id, x, z, heading, detecting, tagProgress, ...(role ? { role, ...(target ? { target: { ...target } } : {}) } : {}) })),
    plane: { x: state.plane.x, z: state.plane.z, heading: state.plane.heading, detecting: state.plane.detecting,
      ...(state.plane.role ? { role: state.plane.role, ...(state.plane.target ? { target: { ...state.plane.target } } : {}) } : {}) },
    detected: state.detected, tagProgress: state.tagProgress,
  };
}

function savePending(): void {
  try {
    // Small control-change records normally fit easily. Bound persistence even
    // when an automated client changes controls on every simulation tick.
    const items = [...pending.values()].slice(-3);
    while (items.length && JSON.stringify(items).length > 2_000_000) items.shift();
    localStorage.setItem(PENDING_KEY, JSON.stringify(items));
  } catch { /* Playing and in-memory retries still work without storage. */ }
}

async function deliverFinish(message: FinishRequest, attempt = 0, leaving = false): Promise<void> {
  if (sending.has(message.attemptId) || !pending.has(message.attemptId)) return;
  const timer = retryTimers.get(message.attemptId);
  if (timer) clearTimeout(timer);
  retryTimers.delete(message.attemptId);
  const body = JSON.stringify(message);
  // The browser limits all outstanding keepalive bodies to roughly 64 KiB.
  // Large records stay persisted for the next visit instead of being truncated.
  if (leaving && new TextEncoder().encode(body).length > 55_000) return;
  sending.add(message.attemptId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/api/learning/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      signal: controller.signal, keepalive: leaving,
    });
    if (response.ok || (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status))) {
      pending.delete(message.attemptId);
      savePending();
    } else throw new Error('Attempt upload unavailable');
  } catch {
    if (!leaving && attempt < 3) {
      const retry = setTimeout(() => void deliverFinish(message, attempt + 1), [1000, 3000, 10000][attempt]);
      retryTimers.set(message.attemptId, retry);
    }
  } finally {
    clearTimeout(timeout);
    sending.delete(message.attemptId);
  }
}

/** Retry completed uploads without restarting or changing the player's run. */
export function flushPendingAttempts(): void {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    if (Array.isArray(saved)) for (const item of saved.slice(-3)) {
      if (item && typeof item.attemptId === 'string' && typeof item.token === 'string'
        && Number.isInteger(item.ticks) && Array.isArray(item.controls)
        && ['caught', 'escaped', 'abandoned'].includes(item.outcome)) pending.set(item.attemptId, item);
    }
  } catch { /* Missing or malformed browser storage cannot block the game. */ }
  for (const message of pending.values()) void deliverFinish(message);
}

const browserTransport: AttemptTransport = {
  now: () => Date.now(),
  live: async message => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch('/api/learning/live', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message), signal: controller.signal,
      });
    } finally { clearTimeout(timeout); }
  },
  finish: (message, leaving) => {
    // Pin the replay association before persisting. Retries must never acquire
    // the next player's replay or change the completed attempt payload.
    let replayId: string | undefined;
    try { replayId = replayHooks?.finish(message.attemptId, message.outcome); } catch { /* Recording cannot interrupt play. */ }
    const recorded = replayId ? { ...message, replayId } : message;
    pending.set(message.attemptId, recorded);
    while (pending.size > 3) {
      const oldest = pending.keys().next().value!;
      pending.delete(oldest);
      const timer = retryTimers.get(oldest);
      if (timer) clearTimeout(timer);
      retryTimers.delete(oldest);
    }
    savePending();
    void deliverFinish(recorded, 0, leaving);
  },
};

/** Pin the layout before launch. An unavailable service leaves baseline play usable. */
export async function requestLearningStart(world: WorldData, seed: number, signal?: AbortSignal): Promise<{ world: WorldData; session: StartResponse | null }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 2000);
  try {
    const response = await fetch('/api/learning/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Learning unavailable');
    const session: StartResponse = await response.json();
    if (typeof session.attemptId !== 'string' || !session.attemptId || typeof session.token !== 'string' || !session.token
      || session.rulesVersion !== RULES_VERSION || session.worldVersion !== WORLD_VERSION
      || !session.layout || !Number.isInteger(session.layout.version)) throw new Error('Unsupported layout');
    const pinnedWorld = applyLearningLayout(world, session.layout);
    try { replayHooks?.start(session.attemptId, session.layout.version); } catch { /* Recording cannot interrupt launch. */ }
    return { world: pinnedWorld, session };
  } catch { return { world, session: null }; }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/** Records the opening stretch at fixed tick boundaries, independent of rendering. */
export class OpeningAttemptRecorder {
  private ticks = 0;
  private controls: ControlSample[] = [];
  private completed = false;
  private sequence = 0;
  private liveBusy = false;
  private nextLiveAt = 0;
  private lastOpeningFrame: LiveFrame | null = null;

  constructor(private session: StartResponse, private transport: AttemptTransport = browserTransport) {}

  beforeTick(state: GameState, input: InputState): void {
    if (this.completed) return;
    // A single rendered frame may cross the boundary and execute more ticks.
    // Finish before recording the first tick belonging to the next patrol.
    if (state.loop > 0) { this.finish(state, 'escaped'); return; }
    if (state.status !== 'playing') return;
    if (this.ticks >= MAX_TICKS) { this.finish(state, 'abandoned'); return; }
    const throttle = Math.max(-1, Math.min(1, Number.isFinite(input.throttle) ? input.throttle : 0));
    const steer = Math.max(-1, Math.min(1, Number.isFinite(input.steer) ? input.steer : 0));
    const previous = this.controls[this.controls.length - 1];
    if (!previous || previous.throttle !== throttle || previous.steer !== steer) {
      this.controls.push({ tick: this.ticks, throttle, steer });
    }
    this.lastOpeningFrame = frameFor(state);
    this.ticks++;
  }

  afterStep(state: GameState): void {
    if (this.completed) return;
    if (state.loop > 0) this.finish(state, 'escaped');
    else if (state.status === 'caught') this.finish(state, 'caught');
    else if (this.ticks >= MAX_TICKS) this.finish(state, 'abandoned');
    else if (!this.liveBusy && this.transport.now() >= this.nextLiveAt) this.sendLive(frameFor(state));
  }

  abandon(state: GameState, leaving = false): void {
    if (this.completed) return;
    this.finish(state, state.loop > 0 ? 'escaped' : state.status === 'caught' ? 'caught' : 'abandoned', leaving);
  }

  private sendLive(frame: LiveFrame): void {
    this.nextLiveAt = this.transport.now() + 500;
    this.liveBusy = true;
    void this.transport.live({ attemptId: this.session.attemptId, token: this.session.token, seq: ++this.sequence, frame })
      .catch(() => { /* Live preview is expendable; the complete run is retried. */ })
      .finally(() => { this.liveBusy = false; });
  }

  private finish(state: GameState, outcome: FinishRequest['outcome'], leaving = false): void {
    if (this.completed) return;
    this.completed = true;
    // Patrol replacement already happened on an escape tick. Keep opening
    // sensors in the terminal preview while showing the boat at the boundary.
    const frame = outcome === 'escaped' && this.lastOpeningFrame
      ? { ...this.lastOpeningFrame, boat: { x: state.boat.x, z: state.boat.z, heading: state.boat.heading }, time: this.ticks * SIMULATION_STEP / GAME_RULES.pace }
      : frameFor(state);
    frame.status = outcome;
    if (!leaving) this.sendLive(frame);
    this.transport.finish({ attemptId: this.session.attemptId, token: this.session.token, ticks: this.ticks, controls: this.controls, outcome }, leaving);
  }
}
