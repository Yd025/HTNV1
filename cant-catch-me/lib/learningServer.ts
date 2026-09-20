import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGame, sampleRiverHeight, startGame, type WorldData } from './game';
import { applyLearningLayout, applyTowerLayout } from './learningWorld';
import { DEFAULT_FLIGHT_POLICY, FLIGHT_ALGORITHM, type SurveillanceRole } from './surveillance';
import { createSentryTransport, importSentryRecord, sentryEventId, sentryRecord, SentrySyncError, type SentryAttemptRecord, type SentryTransport } from './learningSentry';
import { gameFrame, introducesEarlyCapture, MAX_TICKS, promotionDecision, proposeMissionPolicies, replayTrace, scoreReplays, type ReplayResult, type ReplayTrace } from './learningOptimizer';
import { LEARNING_POLICY, LEGACY_RULES_VERSION, OVERHEAD_RULES_VERSION, COORDINATED_RULES_VERSION, RULES_VERSION, WORLD_VERSION, type AttemptReplay, type AttemptSummary, type FinishRequest, type GameDashboard, type Layout, type LearningRound, type LiveFrame, type PathSample, type StartRequest, type StartResponse } from './learningTypes';

type StoredAttempt = {
  id: string; tokenHash: string; seed: number; startedAt: string; layout: Layout;
  summary?: AttemptSummary; finishDigest?: string; controls?: FinishRequest['controls']; ticks?: number;
  result?: ReplayResult; rulesVersion?: string; worldVersion?: string;
  sentry?: { eventId: string; destination?: string | null; retries: number; nextRetryAt: number; uploaded: boolean; imported?: SentryAttemptRecord };
};
type Completed = Pick<StoredAttempt, 'id' | 'tokenHash' | 'finishDigest'> & { summary: AttemptSummary };
type Archive = { schema: 1; rulesVersion: string; worldVersion: string; layout: Layout; rounds: LearningRound[]; lastTrainedCount: number; trainingSource?: 'sentry-v1'; sentryDestination?: string | null };
type LiveState = NonNullable<GameDashboard['live']>;
type Options = { directory?: string; world?: WorldData; autoTrain?: boolean; autoSync?: boolean; sentryTransport?: SentryTransport; now?: () => number };
const MAX_SESSIONS = 128;
const SESSION_LIFETIME = 2 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const copy = <T>(value: T): T => structuredClone(value);
const attemptRules = (attempt: Pick<StoredAttempt, 'rulesVersion'>) => attempt.rulesVersion ?? LEGACY_RULES_VERSION;
const supportedRules = (version: string) => [RULES_VERSION, COORDINATED_RULES_VERSION, OVERHEAD_RULES_VERSION, LEGACY_RULES_VERSION].includes(version);

export class LearningError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'LearningError'; }
}
function check(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new LearningError(message, status); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function number(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum; }
function integer(value: unknown, minimum: number, maximum: number): value is number { return number(value, minimum, maximum) && Number.isInteger(value); }

export function validateFinish(value: unknown): FinishRequest {
  check(record(value), 'A finish payload is required.');
  check(typeof value.attemptId === 'string' && UUID.test(value.attemptId), 'Invalid attempt id.');
  check(typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token), 'Invalid attempt token.');
  check(integer(value.ticks, 0, MAX_TICKS), 'Attempt exceeds the 300 active-second limit.');
  check(['caught', 'escaped', 'abandoned'].includes(String(value.outcome)), 'Unknown attempt outcome.');
  check(value.replayId === undefined || (typeof value.replayId === 'string' && /^[a-f0-9]{32}$/.test(value.replayId)), 'Invalid Sentry replay id.');
  check(Array.isArray(value.controls) && value.controls.length <= MAX_TICKS && value.controls.length <= Math.max(1, value.ticks), 'Too many input changes.');
  check(value.ticks === 0 || value.controls.length > 0, 'Controls must start at tick zero.');
  let previous = -1;
  const controls = value.controls.map((input: unknown, index: number) => {
    check(record(input) && integer(input.tick, 0, Math.max(0, value.ticks as number - 1)), 'Invalid control tick.');
    check(input.tick > previous && (index !== 0 || input.tick === 0), 'Control ticks must increase from zero.');
    check(number(input.throttle, -1, 1) && number(input.steer, -1, 1), 'Controls must be finite values between -1 and 1.');
    previous = input.tick;
    return { tick: input.tick, throttle: input.throttle, steer: input.steer };
  });
  return { attemptId: value.attemptId, token: value.token, ticks: value.ticks, outcome: value.outcome as FinishRequest['outcome'], controls,
    ...(value.replayId ? { replayId: value.replayId as string } : {}) };
}

function validateFrame(value: unknown, towerIds: string[]): LiveFrame {
  check(record(value), 'A live frame is required.');
  check(number(value.time, 0, LEARNING_POLICY.maxSeconds + 0.001), 'Invalid active game time.');
  check(['playing', 'paused', 'caught', 'escaped', 'abandoned'].includes(String(value.status)), 'Invalid live status.');
  const pose = (item: unknown) => {
    check(record(item) && number(item.x, -100000, 100000) && number(item.z, -100000, 100000) && number(item.heading, -1e6, 1e6), 'Invalid live position.');
    return { x: item.x, z: item.z, heading: item.heading };
  };
  const detected = (item: Record<string, unknown>) => { check(typeof item.detecting === 'boolean', 'Invalid detecting flag.'); return item.detecting; };
  const flight = (item: Record<string, unknown>) => {
    if (item.role === undefined) return {};
    check(['gap-search', 'broad-search', 'track', 'forward-support', 'reacquire'].includes(String(item.role)), 'Invalid surveillance role.');
    if (item.target === undefined) return { role: item.role as SurveillanceRole };
    check(record(item.target) && number(item.target.x, -100000, 100000) && number(item.target.z, -100000, 100000), 'Invalid flight target.');
    return { role: item.role as SurveillanceRole, target: { x: item.target.x, z: item.target.z } };
  };
  check(Array.isArray(value.towers) && value.towers.length === towerIds.length, 'Invalid tower count.');
  const towers = value.towers.map((tower: unknown, i: number) => {
    check(record(tower) && tower.id === towerIds[i] && number(tower.range, 1, 10000), 'Invalid tower data.');
    return { ...pose(tower), id: String(tower.id), range: tower.range, detecting: detected(tower) };
  });
  check(Array.isArray(value.drones) && value.drones.length === 2, 'Invalid drone count.');
  const drones = value.drones.map((drone: unknown, i: number) => {
    check(record(drone) && drone.id === `D${i + 1}` && number(drone.tagProgress, 0, 1.00001), 'Invalid drone data.');
    return { ...pose(drone), id: String(drone.id), tagProgress: drone.tagProgress, detecting: detected(drone), ...flight(drone) };
  });
  check(record(value.plane), 'Invalid aircraft data.');
  check(typeof value.detected === 'boolean' && number(value.tagProgress, 0, 1.00001), 'Invalid capture progress.');
  check(value.algorithm === undefined || value.algorithm === FLIGHT_ALGORITHM, 'Invalid flight algorithm.');
  return { time: value.time, status: value.status as LiveFrame['status'], boat: pose(value.boat), towers, drones,
    ...(value.algorithm ? { algorithm: FLIGHT_ALGORITHM } : {}),
    plane: { ...pose(value.plane), detecting: detected(value.plane), ...flight(value.plane) }, detected: value.detected, tagProgress: value.tagProgress };
}

export class LearningService {
  readonly ready: Promise<void>;
  private readonly directory: string;
  private world!: WorldData;
  private dashboardWorld!: GameDashboard['world'];
  private archive!: Archive;
  private sessions = new Map<string, StoredAttempt>();
  private completed = new Map<string, Completed>();
  private liveSequences = new Map<string, { seq: number; time: number }>();
  private latestLive: LiveState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private finishing = new Map<string, { digest: string; promise: Promise<AttemptSummary> }>();
  private replayCache = new Map<string, AttemptReplay>();
  private replaying = new Map<string, Promise<AttemptReplay>>();
  private training: Promise<void> | null = null;
  private readonly sentryTransport: SentryTransport;
  private syncing: Promise<void> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private learning: GameDashboard['learning'] = { status: 'collecting', message: 'Waiting for eight completed opening attempts.', completed: 0, total: 0 };
  constructor(private options: Options = {}) {
    this.directory = path.resolve(options.directory ?? process.env.GAME_LEARNING_DIR ?? path.join(process.cwd(), '.game-learning'));
    this.sentryTransport = options.sentryTransport ?? createSentryTransport();
    this.ready = this.initialize();
  }
  private filename(id: string): string { check(UUID.test(id), 'Invalid attempt id.'); return path.join(this.directory, 'attempts', `${id}.json`); }
  private async atomic(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filename);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async initialize(): Promise<void> {
    this.world = this.options.world ?? JSON.parse(await readFile(path.join(process.cwd(), 'public', 'assets', 'world.json'), 'utf8')) as WorldData;
    check(this.world.size >= 2 && this.world.heights.length === this.world.size ** 2, 'Game terrain is invalid.', 503);
    await mkdir(path.join(this.directory, 'attempts'), { recursive: true });
    try {
      this.archive = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')) as Archive;
      check(this.archive.schema === 1 && supportedRules(this.archive.rulesVersion) && this.archive.worldVersion === WORLD_VERSION, 'Learning archive uses unsupported game rules. Choose a new GAME_LEARNING_DIR for these rules.', 503);
      check(Array.isArray(this.archive.rounds) && Array.isArray(this.archive.layout?.towers), 'Learning archive is damaged.', 503);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.archive = { schema: 1, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION, layout: {
        version: 0, towers: this.world.towers.map(({ id, x, z }) => ({ id, x, z })), algorithm: FLIGHT_ALGORITHM, flightPolicy: { ...DEFAULT_FLIGHT_POLICY },
        createdAt: new Date().toISOString(), reason: 'Original towers with coordinated surveillance flight policy.' }, rounds: [], lastTrainedCount: 0, trainingSource: 'sentry-v1', sentryDestination: this.sentryTransport.destination };
      await this.atomic(path.join(this.directory, 'state.json'), this.archive);
    }
    if (this.archive.rulesVersion !== RULES_VERSION) {
      // Preserve deployed tower positions and past evaluations. The new model
      // starts with an empty cohort; old recordings retain their own mechanics.
      this.archive = { ...this.archive, rulesVersion: RULES_VERSION, lastTrainedCount: 0,
        layout: { ...this.archive.layout, algorithm: FLIGHT_ALGORITHM, flightPolicy: { ...(this.archive.layout.flightPolicy ?? DEFAULT_FLIGHT_POLICY) } },
        rounds: this.archive.rounds.map((round) => ({ ...round, rulesVersion: round.rulesVersion ?? this.archive.rulesVersion })) };
      await this.atomic(path.join(this.directory, 'state.json'), this.archive);
    }
    applyLearningLayout(this.world, this.archive.layout);
    if (this.archive.trainingSource !== 'sentry-v1' || this.archive.sentryDestination !== this.sentryTransport.destination) {
      // Preserve deployed sites and earlier rounds, but start a new eligibility
      // count so previously local attempts must make the Sentry round trip.
      this.archive = { ...this.archive, lastTrainedCount: 0, trainingSource: 'sentry-v1', sentryDestination: this.sentryTransport.destination };
      await this.atomic(path.join(this.directory, 'state.json'), this.archive);
    }
    for (const name of await readdir(path.join(this.directory, 'attempts'))) {
      if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
      const attempt = JSON.parse(await readFile(path.join(this.directory, 'attempts', name), 'utf8')) as StoredAttempt;
      check(attempt.id === name.slice(0, -5) && typeof attempt.tokenHash === 'string', 'An attempt archive is damaged.', 503);
      if (attempt.summary) {
        attempt.summary.rulesVersion = attemptRules(attempt);
        attempt.summary.replayAvailable = this.hasRecording(attempt);
        if (attempt.summary.replayAvailable) {
          let changed = false;
          if (!attempt.sentry || !attempt.summary.sentry || attempt.sentry.destination !== this.sentryTransport.destination) {
            // Upload/import acknowledgments and visual replay IDs belong to a
            // specific project. Only the numeric recording can be re-exported.
            this.queueForSentry(attempt, !!attempt.sentry && attempt.sentry.destination !== this.sentryTransport.destination); changed = true;
          }
          const replayUrl = attempt.summary.sentry!.replayId ? this.sentryTransport.replayUrl(attempt.summary.sentry!.replayId) : undefined;
          if (attempt.summary.sentry!.replayUrl !== replayUrl) { attempt.summary.sentry!.replayUrl = replayUrl; changed = true; }
          if (attempt.summary.sentry!.state === 'imported') {
            try { importSentryRecord(JSON.stringify(attempt.sentry?.imported), this.recordingForSentry(attempt)); }
            catch {
              attempt.sentry!.imported = undefined; attempt.sentry!.nextRetryAt = 0;
              attempt.summary.sentry = { ...attempt.summary.sentry!, state: 'error', error: 'Saved Sentry import must be downloaded and checked again.' }; changed = true;
            }
          }
          if (changed) await this.atomic(this.filename(attempt.id), attempt);
        }
        this.completed.set(attempt.id, { id: attempt.id, tokenHash: attempt.tokenHash, finishDigest: attempt.finishDigest, summary: attempt.summary });
        if (attempt.result && (!this.latestLive || attempt.summary.endedAt > this.latestLive.receivedAt)) this.latestLive = {
          attemptId: attempt.id, rulesVersion: attemptRules(attempt), layoutVersion: attempt.layout.version, receivedAt: attempt.summary.endedAt, stale: true, frame: attempt.result.frame, path: attempt.result.path,
        };
      } else this.sessions.set(attempt.id, attempt);
    }
    // Rendering uses a consistent 65x65 reduction; replay always uses original 257x257 terrain.
    const size = Math.min(65, this.world.size), heights: number[] = [];
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) heights.push(sampleRiverHeight(this.world, -this.world.half + 2 * this.world.half * x / (size - 1), -this.world.half + 2 * this.world.half * z / (size - 1)));
    this.dashboardWorld = { size, heights, half: this.world.half, waterLevel: this.world.waterLevel, spawn: copy(this.world.spawn) };
    this.updateCollecting();
    // Finish durability precedes training, so a restart can resume an unfinished batch.
    if (this.options.autoTrain !== false) setTimeout(() => this.scheduleTraining(), 0);
    this.scheduleSentry(0);
  }
  private authorized(id: string, token: string): StoredAttempt | Completed {
    check(typeof id === 'string' && UUID.test(id) && typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Invalid attempt credentials.', 401);
    const attempt = this.sessions.get(id) ?? this.completed.get(id);
    check(attempt, 'Attempt was not found.', 404);
    const supplied = Buffer.from(digest(token), 'hex'), expected = Buffer.from(attempt.tokenHash, 'hex');
    check(supplied.length === expected.length && timingSafeEqual(supplied, expected), 'Invalid attempt credentials.', 401);
    return attempt;
  }
  private hasRecording(attempt: StoredAttempt): boolean {
    if (!attempt.summary || !attempt.finishDigest || !integer(attempt.seed, 0, 0xffffffff)
      || attempt.summary.id !== attempt.id || attempt.summary.layoutVersion !== attempt.layout?.version
      || !number(attempt.summary.seconds, 0, LEARNING_POLICY.maxSeconds + 0.001)
      || !supportedRules(attemptRules(attempt))
      || (attempt.worldVersion !== undefined && attempt.worldVersion !== WORLD_VERSION)) return false;
    try {
      // Missing per-record provenance belongs to the original legacy rules,
      // even after state.json has migrated to the next training cohort.
      validateFinish({ attemptId: attempt.id, token: '0'.repeat(64), ticks: attempt.ticks, controls: attempt.controls, outcome: attempt.summary.outcome });
      if ([RULES_VERSION, COORDINATED_RULES_VERSION].includes(attemptRules(attempt))) applyLearningLayout(this.world, attempt.layout);
      else applyTowerLayout(this.world, attempt.layout.towers);
      return true;
    } catch { return false; }
  }
  private verified(): Completed[] { return [...this.completed.values()].filter((item) => item.summary.rulesVersion === RULES_VERSION && item.summary.verified && item.summary.outcome !== 'abandoned' && item.summary.sentry?.state === 'imported').sort((a, b) => a.summary.endedAt.localeCompare(b.summary.endedAt)); }
  private updateCollecting(): void {
    const count = this.verified().length;
    this.learning = { status: count < LEARNING_POLICY.minimumAttempts ? 'collecting' : 'ready', message: count < LEARNING_POLICY.minimumAttempts
      ? `${count} of ${LEARNING_POLICY.minimumAttempts} Sentry-imported opening attempts ready.${this.sentryTransport.configured ? '' : ' Learning waits for Sentry import configuration; gameplay is still saved.'}`
      : this.archive.rounds.filter((round) => round.rulesVersion === RULES_VERSION).at(-1)?.reason ?? 'Ready to evaluate Sentry-imported attempts.', completed: count, total: LEARNING_POLICY.minimumAttempts };
  }
  async start(value: unknown): Promise<StartResponse> {
    await this.ready;
    check(record(value) && integer(value.seed, 0, 0xffffffff), 'A uint32 pickup seed is required.');
    check(value.rulesVersion === RULES_VERSION && value.worldVersion === WORLD_VERSION, 'Reload the game to use the current learning rules.', 409);
    const request = value as StartRequest;
    return this.serialize(async () => {
      for (const [id, attempt] of this.sessions) if (Date.now() - Date.parse(attempt.startedAt) > SESSION_LIFETIME) {
        const summary: AttemptSummary = { id, rulesVersion: attemptRules(attempt), layoutVersion: attempt.layout.version, endedAt: new Date().toISOString(), outcome: 'abandoned', seconds: 0, firstDetectionSeconds: null, verified: false, replayAvailable: false };
        await this.atomic(this.filename(id), { ...attempt, summary });
        this.completed.set(id, { id, tokenHash: attempt.tokenHash, summary }); this.sessions.delete(id); this.liveSequences.delete(id);
      }
      check(this.sessions.size < MAX_SESSIONS, 'Too many active attempts. Try again later.', 429);
      const id = randomUUID(), token = randomBytes(32).toString('hex');
      const attempt: StoredAttempt = { id, tokenHash: digest(token), seed: request.seed, startedAt: new Date().toISOString(), layout: copy(this.archive.layout), rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION };
      await this.atomic(this.filename(id), attempt);
      this.sessions.set(id, attempt);
      const game = createGame(applyLearningLayout(this.world, attempt.layout), request.seed); startGame(game);
      this.latestLive = { attemptId: id, rulesVersion: attemptRules(attempt), layoutVersion: attempt.layout.version, receivedAt: attempt.startedAt, stale: false, frame: gameFrame(game), path: [] };
      return { attemptId: id, token, layout: copy(attempt.layout), rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION };
    });
  }
  async live(value: unknown): Promise<{ accepted: boolean }> {
    await this.ready;
    check(record(value) && typeof value.attemptId === 'string' && typeof value.token === 'string' && integer(value.seq, 0, Number.MAX_SAFE_INTEGER), 'Invalid live request.');
    const attempt = this.authorized(value.attemptId, value.token);
    if (attempt.summary) return { accepted: false }; // A verified terminal frame cannot be overwritten by a delayed browser frame.
    const frame = validateFrame(value.frame, this.world.towers.map((tower) => tower.id));
    const pinned = (attempt as StoredAttempt).layout;
    check(frame.towers.every((tower, i) => tower.x === pinned.towers[i].x && tower.z === pinned.towers[i].z && tower.range === this.world.towers[i].range), 'Live towers must match this attempt’s pinned layout.');
    const previous = this.liveSequences.get(attempt.id);
    if (previous && (value.seq <= previous.seq || frame.time < previous.time)) return { accepted: false };
    this.liveSequences.set(attempt.id, { seq: value.seq, time: frame.time });
    const old = this.latestLive?.attemptId === attempt.id ? this.latestLive : null;
    const point: PathSample = { t: frame.time, x: frame.boat.x, z: frame.boat.z, detected: frame.detected, tagProgress: frame.tagProgress };
    const trail = old?.path ?? [];
    if (!trail.length || point.t > trail[trail.length - 1].t) trail.push(point);
    this.latestLive = { attemptId: attempt.id, rulesVersion: attemptRules(attempt as StoredAttempt), layoutVersion: (attempt as StoredAttempt).layout.version, receivedAt: new Date().toISOString(), stale: false, frame, path: trail.slice(-650) };
    return { accepted: true };
  }
  async finish(value: unknown): Promise<AttemptSummary> {
    await this.ready;
    const request = validateFinish(value);
    const attempt = this.authorized(request.attemptId, request.token);
    const fingerprint = digest(JSON.stringify({ ticks: request.ticks, controls: request.controls, outcome: request.outcome }));
    if (attempt.summary && attempt.finishDigest) {
      check(attempt.finishDigest === fingerprint, 'This attempt already has a different final result.', 409);
      return copy(attempt.summary);
    }
    const pending = this.finishing.get(attempt.id);
    if (pending) { check(pending.digest === fingerprint, 'Another finish request is being verified.', 409); return pending.promise; }
    check(this.finishing.size < 4, 'Replay verification is busy. Retry the same finish request.', 429);
    const promise = (async () => {
      // Expiry frees an active slot but cannot discard an offline player's
      // authenticated recording. Its provisional abandonment has no digest.
      const source: StoredAttempt = 'layout' in attempt ? attempt
        : JSON.parse(await readFile(this.filename(attempt.id), 'utf8')) as StoredAttempt;
      check(source.id === attempt.id && source.tokenHash === attempt.tokenHash, 'Attempt archive is inconsistent.', 503);
      check(!source.summary || (!source.finishDigest && source.summary.outcome === 'abandoned' && !source.summary.verified), 'This attempt already has a final result.', 409);
      return this.verifyFinish(source, request, fingerprint);
    })();
    this.finishing.set(attempt.id, { digest: fingerprint, promise });
    try { return await promise; } finally { this.finishing.delete(attempt.id); }
  }
  private async verifyFinish(attempt: StoredAttempt, request: FinishRequest, fingerprint: string): Promise<AttemptSummary> {
    check(supportedRules(attemptRules(attempt)) && (attempt.worldVersion === undefined || attempt.worldVersion === WORLD_VERSION), 'Reload the game to use the current learning rules.', 409);
    const result = await replayTrace(this.world, attempt.layout, { seed: attempt.seed, ticks: request.ticks, controls: request.controls, rulesVersion: attemptRules(attempt) }, true);
    check(result.ticks === request.ticks, 'Recorded controls continue past the opening attempt outcome.', 422);
    const outcome = result.outcome === 'censored' ? 'abandoned' : result.outcome;
    check(request.outcome === outcome, 'Recorded outcome does not match the game replay.', 422);
    const summary: AttemptSummary = { id: attempt.id, rulesVersion: attemptRules(attempt), layoutVersion: attempt.layout.version, endedAt: new Date().toISOString(), outcome,
      seconds: result.seconds, firstDetectionSeconds: result.firstDetectionSeconds, verified: outcome !== 'abandoned', replayAvailable: true,
      sentry: { state: 'pending', eventId: sentryEventId(attempt.id), ...(request.replayId ? { replayId: request.replayId, replayUrl: this.sentryTransport.replayUrl(request.replayId) } : {}) } };
    await this.serialize(async () => {
      const saved: StoredAttempt = { ...attempt, summary, finishDigest: fingerprint, controls: request.controls, ticks: request.ticks, result };
      this.queueForSentry(saved);
      await this.atomic(this.filename(attempt.id), saved);
      this.completed.set(attempt.id, { id: attempt.id, tokenHash: attempt.tokenHash, summary, finishDigest: fingerprint });
      this.sessions.delete(attempt.id); this.liveSequences.delete(attempt.id);
      if (!this.latestLive || this.latestLive.attemptId === attempt.id) this.latestLive = {
        attemptId: attempt.id, rulesVersion: attemptRules(attempt), layoutVersion: attempt.layout.version, receivedAt: summary.endedAt, stale: false, frame: result.frame, path: result.path,
      };
    });
    if (!this.training) this.updateCollecting();
    this.scheduleSentry(0);
    return copy(summary);
  }
  private queueForSentry(attempt: StoredAttempt, clearReplay = false): void {
    const eventId = sentryEventId(attempt.id);
    const replayId = clearReplay ? undefined : attempt.summary!.sentry?.replayId;
    attempt.sentry = { eventId, destination: this.sentryTransport.destination, retries: 0, nextRetryAt: 0, uploaded: false };
    attempt.summary!.sentry = { state: 'pending', eventId, ...(replayId ? { replayId, replayUrl: this.sentryTransport.replayUrl(replayId) } : {}) };
  }
  private recordingForSentry(attempt: StoredAttempt): SentryAttemptRecord {
    check(this.hasRecording(attempt), 'The saved attempt cannot be exported to Sentry.', 503);
    return sentryRecord({ id: attempt.id, seed: attempt.seed, ticks: attempt.ticks!, controls: attempt.controls!, layout: attempt.layout, summary: attempt.summary!, rulesVersion: attemptRules(attempt), worldVersion: attempt.worldVersion ?? WORLD_VERSION });
  }
  private async persistSentry(attempt: StoredAttempt): Promise<void> {
    await this.serialize(async () => {
      await this.atomic(this.filename(attempt.id), attempt);
      this.completed.set(attempt.id, { id: attempt.id, tokenHash: attempt.tokenHash, finishDigest: attempt.finishDigest, summary: attempt.summary! });
      this.replayCache.delete(attempt.id);
    });
  }
  private scheduleSentry(delay = 10000): void {
    if (this.options.autoSync === false || !this.sentryTransport.uploadConfigured || this.syncTimer || this.syncing) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncSentry().catch(() => { /* The persisted outbox is retried on the next background pass. */ });
    }, delay);
    this.syncTimer.unref?.();
  }
  /** Drain a bounded durable outbox; only downloaded, checked records feed learning. */
  async syncSentry(): Promise<void> {
    await this.ready;
    if (this.syncing) return this.syncing;
    if (!this.sentryTransport.uploadConfigured) return;
    const work = this.runSentrySync(); this.syncing = work;
    try { await work; }
    finally { this.syncing = null; this.scheduleSentry(); }
  }
  private async runSentrySync(): Promise<void> {
    const pending = [...this.completed.values()].filter((item) => item.summary.replayAvailable && item.summary.sentry?.state !== 'imported')
      .sort((a, b) => a.summary.endedAt.localeCompare(b.summary.endedAt));
    let processed = 0;
    for (const item of pending) {
      const attempt = JSON.parse(await readFile(this.filename(item.id), 'utf8')) as StoredAttempt;
      if (!attempt.sentry || !attempt.summary || !this.hasRecording(attempt)) continue;
      if (attempt.sentry.destination !== this.sentryTransport.destination) { this.queueForSentry(attempt, true); await this.persistSentry(attempt); }
      const clock = this.options.now?.() ?? Date.now();
      if (attempt.sentry.nextRetryAt > clock || (attempt.sentry.uploaded && !this.sentryTransport.configured)) continue;
      if (processed++ >= 4) break;
      try {
        const expected = this.recordingForSentry(attempt);
        if (!attempt.sentry.uploaded) {
          await this.sentryTransport.publish(expected, attempt.sentry.eventId);
          attempt.sentry.uploaded = true;
          attempt.summary.sentry = { ...attempt.summary.sentry!, state: 'uploaded', error: undefined };
          await this.persistSentry(attempt);
        }
        if (!this.sentryTransport.configured) continue;
        const downloaded = await this.sentryTransport.download(attempt.sentry.eventId);
        if (downloaded === null) throw new SentrySyncError('Waiting for Sentry to index the uploaded recording.', true);
        attempt.sentry.imported = importSentryRecord(downloaded, expected);
        attempt.sentry.nextRetryAt = 0; attempt.sentry.retries = 0;
        attempt.summary.sentry = { ...attempt.summary.sentry!, state: 'imported', error: undefined,
          replayUrl: attempt.summary.sentry?.replayId ? this.sentryTransport.replayUrl(attempt.summary.sentry.replayId) : undefined };
        await this.persistSentry(attempt);
      } catch (error) {
        const awaitingIndex = error instanceof SentrySyncError && error.awaitingIndex;
        attempt.sentry.retries++;
        attempt.sentry.nextRetryAt = clock + Math.min(300000, 10000 * 2 ** Math.min(5, attempt.sentry.retries - 1));
        attempt.summary.sentry = { ...attempt.summary.sentry!, state: awaitingIndex ? 'uploaded' : 'error',
          error: awaitingIndex ? undefined : error instanceof SentrySyncError ? error.message : 'Sentry import failed; the saved recording will retry.' };
        await this.persistSentry(attempt);
      }
    }
    // Restarts may begin with already imported recordings but no cached project
    // metadata. Resolve their link destination without repeating any upload.
    if (this.sentryTransport.configured && this.sentryTransport.resolveProject
      && [...this.completed.values()].some((item) => item.summary.sentry?.replayId)) {
      try { await this.sentryTransport.resolveProject(); } catch { /* Links stay closed while metadata is unavailable. */ }
      for (const item of this.completed.values()) {
        const replayId = item.summary.sentry?.replayId;
        if (!replayId) continue;
        const replayUrl = this.sentryTransport.replayUrl(replayId);
        if (item.summary.sentry!.replayUrl === replayUrl) continue;
        const attempt = JSON.parse(await readFile(this.filename(item.id), 'utf8')) as StoredAttempt;
        if (attempt.sentry?.destination !== this.sentryTransport.destination || !attempt.summary?.sentry) continue;
        attempt.summary.sentry.replayUrl = replayUrl; await this.persistSentry(attempt);
      }
    }
    if (!this.training) this.updateCollecting();
    this.scheduleTraining();
  }
  private sentryDashboard(): GameDashboard['sentry'] {
    const states = [...this.completed.values()].flatMap((item) => item.summary.sentry ? [item.summary.sentry] : []);
    const imported = states.filter((item) => item.state === 'imported').length;
    const failed = states.filter((item) => item.state === 'error').length, pending = states.length - imported;
    const configured = this.sentryTransport.configured;
    const status = !configured ? 'unconfigured' : failed ? 'error' : pending || this.syncing ? 'syncing' : 'ready';
    const message = !configured ? this.sentryTransport.configurationMessage : failed
      ? `${failed} recording${failed === 1 ? '' : 's'} awaiting a Sentry retry. ${states.find((item) => item.state === 'error')?.error || ''}`
      : pending ? `${pending} saved recording${pending === 1 ? '' : 's'} waiting for the Sentry upload and import round trip.`
      : `${imported} recording${imported === 1 ? '' : 's'} imported from Sentry. Verified current-rule attempts train tower positions and coordinated flight paths.`;
    return { configured, status, pending, imported, failed, message };
  }
  /** Reconstruct read-only playback from the attempt's own pinned world state. */
  async replay(attemptId: unknown): Promise<AttemptReplay> {
    await this.ready;
    check(typeof attemptId === 'string' && UUID.test(attemptId), 'Recording was not found.', 404);
    const completed = this.completed.get(attemptId);
    check(completed?.summary.replayAvailable, 'This attempt has no saved recording.', 404);
    const cached = this.replayCache.get(attemptId);
    if (cached) {
      this.replayCache.delete(attemptId); this.replayCache.set(attemptId, cached);
      return copy(cached);
    }
    const pending = this.replaying.get(attemptId);
    if (pending) return copy(await pending);
    check(this.replaying.size < 2, 'Recordings are being prepared. Try again shortly.', 429);
    const reconstruction = (async () => {
      let attempt: StoredAttempt;
      try { attempt = JSON.parse(await readFile(this.filename(attemptId), 'utf8')) as StoredAttempt; }
      catch { throw new LearningError('This recording is unavailable.', 404); }
      check(attempt.id === attemptId && this.hasRecording(attempt), 'This recording is unavailable for the current game rules.', 404);
      const frames: LiveFrame[] = [];
      const result = await replayTrace(this.world, attempt.layout, { seed: attempt.seed, ticks: attempt.ticks!, controls: attempt.controls!, rulesVersion: attemptRules(attempt) }, false, (frame) => {
        // A zero-tick abandoned attempt has one initial/terminal frame.
        if (frames.length && frames[frames.length - 1].time === frame.time) frames[frames.length - 1] = frame;
        else frames.push(frame);
      });
      const outcome = result.outcome === 'censored' ? 'abandoned' : result.outcome;
      check(result.ticks === attempt.ticks && outcome === attempt.summary!.outcome
        && Math.abs(result.seconds - attempt.summary!.seconds) < 0.001, 'The saved recording does not match this game version.', 404);
      const replay: AttemptReplay = { attempt: { ...attempt.summary!, rulesVersion: attemptRules(attempt), replayAvailable: true }, layout: copy(attempt.layout), frames };
      this.replayCache.set(attemptId, replay);
      if (this.replayCache.size > 8) this.replayCache.delete(this.replayCache.keys().next().value!);
      return replay;
    })();
    this.replaying.set(attemptId, reconstruction);
    try { return copy(await reconstruction); }
    finally { this.replaying.delete(attemptId); }
  }
  private scheduleTraining(): void {
    if (this.options.autoTrain === false || this.training || !this.sentryTransport.configured) return;
    const count = this.verified().length;
    if (count < LEARNING_POLICY.minimumAttempts || count <= this.archive.lastTrainedCount) return;
    this.training = this.train(count).catch((error) => {
      this.learning = { status: 'error', message: `Learning stopped: ${error instanceof Error ? error.message : 'unknown failure'}`, completed: 0, total: 0 };
    }).finally(() => { this.training = null; if (this.learning.status !== 'error') this.scheduleTraining(); });
  }
  private async train(totalCount: number): Promise<void> {
    const selected = this.verified().slice(-24);
    const records = await Promise.all(selected.map(async (item) => JSON.parse(await readFile(this.filename(item.id), 'utf8')) as StoredAttempt));
    const traces: ReplayTrace[] = records.map((item) => {
      check(item.sentry?.destination === this.sentryTransport.destination, 'The recording was imported from a different Sentry project.', 503);
      const imported = importSentryRecord(JSON.stringify(item.sentry?.imported), this.recordingForSentry(item));
      check(imported.rulesVersion === RULES_VERSION, 'Only recordings using current rules can train coordinated surveillance.', 503);
      return { seed: imported.seed, ticks: imported.ticks, controls: imported.controls, outcome: imported.summary.outcome as 'caught' | 'escaped', seconds: imported.summary.seconds, rulesVersion: imported.rulesVersion };
    });
    const current = copy(this.archive.layout), validationStart = traces.length - Math.max(4, Math.ceil(traces.length / 4));
    const candidates = proposeMissionPolicies(this.world, current, this.archive.rounds.length);
    const total = traces.length + candidates.length * validationStart + (traces.length - validationStart);
    let completed = 0;
    this.learning = { status: 'training', message: 'Training tower positions, drone search paths, plane sweeps and observation handoffs on separate attempt groups.', completed, total };
    const evaluate = async (layout: Layout, subset: ReplayTrace[]) => {
      const rows: ReplayResult[] = [];
      for (const trace of subset) {
        rows.push(await replayTrace(this.world, layout, trace));
        this.learning = { ...this.learning, completed: ++completed };
      }
      return rows;
    };
    const baseline = await evaluate(current, traces);
    let winning = current, winningRows = baseline.slice(0, validationStart), best = scoreReplays(winningRows);
    for (const layout of candidates) {
      const rows = await evaluate(layout, traces.slice(0, validationStart));
      // A candidate already known to violate fairness on training attempts
      // cannot displace a fair finalist; validation stays untouched here.
      if (introducesEarlyCapture(baseline.slice(0, validationStart), rows)) continue;
      const score = scoreReplays(rows);
      if (score.captureRate >= best.captureRate && score.cappedMeanSeconds < best.cappedMeanSeconds - 0.01) { winning = layout; winningRows = rows; best = score; }
    }
    // The latest validation attempts are consulted once, after training selects the proposal.
    const candidate = [...winningRows, ...await evaluate(winning, traces.slice(validationStart))];
    const decision = winning === current ? { promote: false, reason: 'No tower-and-flight candidate improved training attempts; current mission policy retained.' }
      : promotionDecision(traces, baseline, candidate, validationStart);
    await this.serialize(async () => {
      const nextLayout: Layout = decision.promote ? { ...copy(winning), version: current.version + 1, createdAt: new Date().toISOString(), reason: decision.reason } : current;
      const round: LearningRound = { id: this.archive.rounds.length + 1, rulesVersion: RULES_VERSION, at: new Date().toISOString(), attempts: traces.length, candidateCount: candidates.length + 1,
        promoted: decision.promote, previousVersion: current.version, selectedVersion: nextLayout.version, reason: decision.reason,
        baseline: scoreReplays(baseline.slice(validationStart)), candidate: scoreReplays(candidate.slice(validationStart)), towers: copy(winning.towers),
        algorithm: FLIGHT_ALGORITHM, flightPolicy: copy(winning.flightPolicy ?? DEFAULT_FLIGHT_POLICY) };
      const next: Archive = { ...this.archive, layout: nextLayout, rounds: [...this.archive.rounds, round], lastTrainedCount: totalCount };
      await this.atomic(path.join(this.directory, 'state.json'), next);
      this.archive = next;
    });
    this.updateCollecting();
  }
  async dashboard(): Promise<GameDashboard> {
    await this.ready;
    const all = [...this.completed.values()].map((item) => item.summary).sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    const completed = all.filter((item) => item.verified && item.outcome !== 'abandoned'), caught = completed.filter((item) => item.outcome === 'caught');
    return copy({ rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION, layout: this.archive.layout, policy: LEARNING_POLICY, learning: this.learning,
      totals: { attempts: all.length, captured: caught.length, escaped: completed.length - caught.length, abandoned: all.filter((item) => item.outcome === 'abandoned').length,
        captureRate: completed.length ? caught.length / completed.length : null, meanCaptureSeconds: caught.length ? caught.reduce((sum, item) => sum + item.seconds, 0) / caught.length : null },
      attempts: all.slice(-200), rounds: this.archive.rounds.slice(-100), sentry: this.sentryDashboard(), live: this.latestLive ? { ...this.latestLive, stale: Date.now() - Date.parse(this.latestLive.receivedAt) > 5000 } : null,
      world: this.dashboardWorld });
  }
  async waitForTraining(): Promise<void> { await this.ready; if (this.training) await this.training; }
}

const shared = globalThis as typeof globalThis & { cantCatchMeLearningService?: LearningService };
export function getLearningService(): LearningService { return shared.cantCatchMeLearningService ??= new LearningService(); }
