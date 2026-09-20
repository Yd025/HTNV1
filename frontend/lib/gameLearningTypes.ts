/** Version the dataset whenever terrain or game mechanics change. */
export const LEGACY_RULES_VERSION = 'opening-physics-loop-pace2-v1';
export const RULES_VERSION = 'opening-overhead-spotting-v2';
export const WORLD_VERSION = 'fort-ross-257-v1';
export const LEARNING_POLICY = {
  minimumAttempts: 8,
  maxSeconds: 300,
  spawnProtectionMetres: 250,
  minimumCaptureSeconds: 12,
  maximumValidationCaptureRate: 0.8,
  minimumTowerSeparation: 350,
} as const;

export type TowerPosition = { id: string; x: number; z: number };
export type Layout = { version: number; towers: TowerPosition[]; createdAt: string; reason: string };
export type ControlSample = { tick: number; throttle: number; steer: number };
export type PathSample = { t: number; x: number; z: number; detected: boolean; tagProgress: number };
export type LiveFrame = {
  time: number; status: 'playing' | 'paused' | 'caught' | 'escaped' | 'abandoned';
  boat: { x: number; z: number; heading: number };
  towers: { id: string; x: number; z: number; heading: number; range: number; detecting: boolean }[];
  drones: { id: string; x: number; z: number; heading: number; detecting: boolean; tagProgress: number }[];
  plane: { x: number; z: number; heading: number; detecting: boolean };
  detected: boolean; tagProgress: number;
};
export type StartRequest = { seed: number; rulesVersion: string; worldVersion: string };
export type StartResponse = { attemptId: string; token: string; layout: Layout; rulesVersion: string; worldVersion: string };
export type FinishRequest = {
  attemptId: string; token: string; ticks: number; controls: ControlSample[];
  outcome: 'caught' | 'escaped' | 'abandoned'; replayId?: string;
};
export type SentryAttemptStatus = {
  state: 'pending' | 'uploaded' | 'imported' | 'error'; eventId?: string;
  replayId?: string; replayUrl?: string; error?: string;
};
export type AttemptSummary = {
  rulesVersion?: string;
  id: string; layoutVersion: number; endedAt: string; outcome: FinishRequest['outcome'];
  seconds: number; firstDetectionSeconds: number | null; verified: boolean; replayAvailable?: boolean; sentry?: SentryAttemptStatus;
};
/** A saved run reconstructed from its original layout and recorded controls. */
export type AttemptReplay = { attempt: AttemptSummary; layout: Layout; frames: LiveFrame[] };
export type ReplayScore = {
  attempts: number; captures: number; escapes: number; censored: number;
  captureRate: number; meanCaptureSeconds: number | null; cappedMeanSeconds: number;
};
export type LearningRound = {
  rulesVersion?: string;
  id: number; at: string; attempts: number; candidateCount: number; promoted: boolean;
  previousVersion: number; selectedVersion: number; reason: string;
  baseline: ReplayScore; candidate: ReplayScore;
  towers: TowerPosition[];
};
export type GameDashboard = {
  rulesVersion: string; worldVersion: string; layout: Layout; policy: typeof LEARNING_POLICY;
  learning: { status: 'collecting' | 'training' | 'ready' | 'error'; message: string; completed: number; total: number };
  totals: { attempts: number; captured: number; escaped: number; abandoned: number; captureRate: number | null; meanCaptureSeconds: number | null };
  attempts: AttemptSummary[]; rounds: LearningRound[];
  sentry: { configured: boolean; status: 'unconfigured' | 'syncing' | 'ready' | 'error'; pending: number; imported: number; failed: number; message: string };
  live: { attemptId: string; rulesVersion?: string; layoutVersion: number; receivedAt: string; stale: boolean; frame: LiveFrame; path: PathSample[] } | null;
  world: { half: number; size: number; heights: number[]; waterLevel: number; spawn: { x: number; z: number; heading: number } };
};
