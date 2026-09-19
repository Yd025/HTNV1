import { useEffect, useMemo, useState } from "react";
import type { StrategyPlan, SwarmState } from "../lib/types";

const DEFAULT_WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/telemetry";
const STALE_AFTER_MS = 5000;
const RATE_WINDOW_MS = 10000;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_BACKOFF_MS = 15000;
const MAX_RATE_SAMPLES = 2048;

export type TelemetryConnection = "connecting" | "live" | "down";

export type MissionTelemetry = {
  state: SwarmState;
  strategy: StrategyPlan | null;
  /** Socket transport state; an open socket does not establish usable telemetry. */
  connection: TelemetryConnection;
  lastReceived: number | null;
  ageSeconds: number | null;
  isFresh: boolean;
  hasReceived: boolean;
  frameCount: number;
  /** Accepted state frames per second, over at most the last 10 seconds. */
  receivedHz: number | null;
  reconnects: number;
  error: string | null;
};

type Observations = { count: number; first: number | null; last: number | null; wallTime: number | null; times: number[] };
const EMPTY_OBSERVATIONS: Observations = { count: 0, first: null, last: null, wallTime: null, times: [] };

/** Call once in the page; share the returned state with every presentation panel. */
export function useMissionTelemetry(url = DEFAULT_WS_URL): MissionTelemetry {
  const [state, setState] = useState<SwarmState>({});
  const [strategy, setStrategy] = useState<StrategyPlan | null>(null);
  const [connection, setConnection] = useState<TelemetryConnection>("connecting");
  const [connectionHasState, setConnectionHasState] = useState(false);
  const [observations, setObservations] = useState<Observations>(EMPTY_OBSERVATIONS);
  const [clock, setClock] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let connectTimer: number | undefined;
    let attempts = 0;
    let failures = 0;

    setState({});
    setStrategy(null);
    setObservations(EMPTY_OBSERVATIONS);
    setReconnects(0);
    setError(null);
    setClock(performance.now());
    const ageTimer = window.setInterval(() => setClock(performance.now()), 1000);

    const scheduleReconnect = (message: string) => {
      if (stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 4));
      failures += 1;
      setConnection("down");
      setError(`${message} Retrying in ${delay / 1000} s.`);
      reconnectTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped) return;
      if (attempts > 0) setReconnects((value) => value + 1);
      attempts += 1;
      setConnection("connecting");
      setConnectionHasState(false);
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect("Cannot open the telemetry socket. Check its configured address.");
        return;
      }
      activeSocket = socket;

      const disconnect = (message: string) => {
        if (stopped || activeSocket !== socket) return;
        activeSocket = null;
        window.clearTimeout(connectTimer);
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
        scheduleReconnect(message);
      };

      connectTimer = window.setTimeout(() => disconnect("The telemetry connection timed out."), CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (stopped || activeSocket !== socket) return;
        window.clearTimeout(connectTimer);
        setConnection("live");
        setError(null);
      };
      socket.onerror = () => disconnect("The telemetry service could not be reached.");
      socket.onclose = (event) => disconnect(`The telemetry connection closed (code ${event.code}).`);
      socket.onmessage = (event) => {
        if (stopped || activeSocket !== socket || typeof event.data !== "string") return;
        const message = parseTelemetryMessage(event.data);
        if (!message) return;
        if (message.kind === "strategy") {
          setStrategy(message.strategy);
          return;
        }
        const receivedAt = performance.now();
        const wallTime = Date.now();
        failures = 0;
        setConnectionHasState(true);
        setState(message.state);
        if (Object.prototype.hasOwnProperty.call(message.state, "advisor")) setStrategy(message.state.advisor ?? null);
        setError(null);
        setObservations((previous) => ({
          count: previous.count + 1,
          first: previous.first ?? receivedAt,
          last: receivedAt,
          wallTime,
          times: [...previous.times.filter((time) => time > receivedAt - RATE_WINDOW_MS), receivedAt].slice(-MAX_RATE_SAMPLES),
        }));
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearInterval(ageTimer);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(connectTimer);
      if (activeSocket) {
        activeSocket.onopen = null;
        activeSocket.onmessage = null;
        activeSocket.onclose = null;
        activeSocket.onerror = null;
        activeSocket.close();
      }
    };
  }, [url]);

  return useMemo(() => {
    const currentTime = Math.max(clock, observations.last ?? clock);
    const ageSeconds = observations.last === null ? null : Math.max(0, (currentTime - observations.last) / 1000);
    return {
      state,
      strategy,
      connection,
      lastReceived: observations.wallTime,
      ageSeconds,
      isFresh: connection === "live" && connectionHasState && ageSeconds !== null && ageSeconds * 1000 <= STALE_AFTER_MS,
      hasReceived: observations.count > 0,
      frameCount: observations.count,
      receivedHz: observedRate(observations, currentTime),
      reconnects,
      error,
    };
  }, [state, strategy, connection, connectionHasState, observations, clock, reconnects, error]);
}

export default useMissionTelemetry;

/** The initial frame starts the clock; it is not treated as a measured interval. */
function observedRate(observations: Observations, now: number): number | null {
  if (observations.first === null || observations.count < 2) return null;
  const start = Math.max(observations.first, now - RATE_WINDOW_MS);
  const elapsed = now - start;
  if (elapsed <= 0) return null;
  const samples = observations.times.filter((time) => time > start);
  return samples.length / (elapsed / 1000);
}

type ParsedMessage = { kind: "state"; state: SwarmState } | { kind: "strategy"; strategy: StrategyPlan | null };
type RecordValue = Record<string, unknown>;
type Validator = (value: unknown) => boolean;

const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const finite: Validator = (value) => typeof value === "number" && Number.isFinite(value);
const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const nullable = (check: Validator): Validator => (value) => value === null || check(value);
const arrayOf = (check: Validator): Validator => (value) => Array.isArray(value) && value.every(check);
const mapOf = (check: Validator): Validator => (value) => record(value) && Object.values(value).every(check);
const oneOf = (...values: unknown[]): Validator => (value) => values.includes(value);
const latitude: Validator = (value) => finite(value) && Math.abs(value as number) <= 90;
const longitude: Validator = (value) => finite(value) && Math.abs(value as number) <= 180;

function fields(value: unknown, required: Record<string, Validator>, optional: Record<string, Validator> = {}): boolean {
  return record(value)
    && Object.entries(required).every(([key, check]) => Object.prototype.hasOwnProperty.call(value, key) && check(value[key]))
    && Object.entries(optional).every(([key, check]) => !Object.prototype.hasOwnProperty.call(value, key) || check(value[key]));
}

const position: Validator = (value) => fields(value, { lat: latitude, lon: longitude });
const strategy: Validator = (value) => fields(value, {}, {
  assigned_vehicle: string, intercept: position, rationale: string, role_bias: mapOf(string), radio_script: string, ts: string,
});
const vehicle: Validator = (value) => fields(value, { vehicle_id: string, lat: nullable(latitude), lon: nullable(longitude) }, {
  sysid: nullable(finite), vehicle_class: oneOf("plane", "copter", "rover", "tower"), role: nullable(oneOf("search", "track", "confirm", "cue", "reserve")),
  timestamp: string, alt: nullable(finite), heading: nullable(finite), groundspeed: nullable(finite), battery_remaining: nullable(finite), armed: boolean, mode: nullable(string), mavlink: boolean, connected: boolean,
});
const track: Validator = (value) => fields(value, { lat: latitude, lon: longitude }, {
  vn: finite, ve: finite, speed_mps: finite, class_hint: string, confidence: finite, age_s: finite, sigma_m: finite,
  history: arrayOf((point) => Array.isArray(point) && point.length === 2 && latitude(point[0]) && longitude(point[1])),
});
const scorecard: Validator = (value) => fields(value, { coverage: finite, collaboration: finite, efficiency: finite, tracking: finite }, {
  time_to_detect_s: nullable(finite), meters_flown: finite, commands_issued: finite, overlap_ratio: finite, unique_roles: finite, cells_seen: finite, cells_total: finite, track_error_m: nullable(finite),
});
const stateFields: Record<string, Validator> = {
  adapter: string, deployed: boolean, heartbeat: finite, tick_hz: finite,
  fleet: mapOf(vehicle), scores: scorecard, track: nullable(track), truth: nullable(position), advisor: nullable(strategy),
  detections: arrayOf((value) => fields(value, { source_id: string, lat: latitude, lon: longitude, class_hint: string, confidence: finite }, { range_m: nullable(finite), timestamp: finite, bearing: nullable(finite) })),
  heatmap: arrayOf((value) => fields(value, { lat: latitude, lon: longitude, heat: finite })),
  blackboard: arrayOf((value) => fields(value, { sender: string, recipient: string, kind: string, body: record }, { t: finite })),
  c2: (value) => fields(value, {}, { phase: string, intent: string }),
  intents: mapOf(string),
  commands: arrayOf((value) => fields(value, { vehicle_id: string, type: string }, { lat: nullable(latitude), lon: nullable(longitude), alt: nullable(finite), sector: nullable(finite) })),
  arena: (value) => fields(value, { origin_lat: latitude, origin_lon: longitude, half_m: (half) => finite(half) && (half as number) > 0 }, { heading_offset_deg: finite }),
};

/** Reject malformed frames atomically so a bad nested value cannot replace a usable mission. */
export function parseTelemetryMessage(raw: string): ParsedMessage | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value)) return null;
  if (value.type === "strategy") {
    return value.data === null || strategy(value.data) ? { kind: "strategy", strategy: value.data as StrategyPlan | null } : null;
  }
  if (value.type !== "state" || "status" in value) return null;
  if (!["fleet", "scores", "track", "heartbeat", "arena"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) return null;
  if (!fields(value, {}, stateFields)) return null;
  return { kind: "state", state: value as SwarmState };
}
