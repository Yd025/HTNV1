export type VehicleClass = "plane" | "copter" | "rover" | "tower";
export type Role = "search" | "track" | "confirm" | "cue" | "reserve";

export type TelemetrySample = {
  vehicle_id: string;
  sysid?: number | null;
  vehicle_class?: VehicleClass;
  role?: Role | null;
  timestamp?: string;
  lat: number | null;
  lon: number | null;
  alt?: number | null;
  alt_msl?: number | null;
  heading?: number | null;
  groundspeed?: number | null;
  battery_remaining?: number | null;
  armed?: boolean;
  mode?: string | null;
  mavlink?: boolean;
};

export type TrackState = {
  lat: number;
  lon: number;
  vn?: number;
  ve?: number;
  speed_mps?: number;
  class_hint?: string;
  confidence?: number;
  age_s?: number;
  sigma_m?: number;
  history?: [number, number][];
  status?: "tentative" | "observed" | "coasting";
};

export type HeatCell = { lat: number; lon: number; heat: number };

export type Scorecard = {
  coverage: number;
  collaboration: number;
  efficiency: number;
  tracking: number | null;
  tracking_basis?: "truth" | "residual" | null;
  time_to_detect_s?: number | null;
  meters_flown?: number;
  commands_issued?: number;
  overlap_ratio?: number;
  unique_roles?: number;
  cells_seen?: number;
  cells_total?: number;
  track_error_m?: number | null;
};

export type SwarmState = {
  type?: string;
  status?: "ok" | "warming" | "stale" | "failed" | "complete";
  adapter?: string;
  deployed?: boolean;
  heartbeat?: number;
  tick_hz?: number;
  run?: { run_id: string; mode: "synthetic" | "hybrid" | "live" | "replay"; source: string; sequence: number; clock: string; evaluation_truth_available: boolean; source_run_id?: string | null };
  observations?: { received: number; forwarded: number; rejected: { observation_id: string; source_id: string; reason: string }[]; latest_age_s: number | null; basis: string };
  command_outcomes?: { command_id: string; vehicle_id: string; status: "suppressed" | "dispatched" | "dispatch_error"; error?: string }[];
  recording?: { enabled: boolean; state?: string; dropped_records?: number; written_records?: number; accepted_records?: number; bytes_written?: number; max_bytes?: number; queue_depth?: number; complete?: boolean; error?: string | null; path?: string; run_id?: string };
  scores?: Scorecard;
  fleet?: Record<string, TelemetrySample>;
  detections?: { source_id: string; lat: number; lon: number; class_hint: string; confidence: number; range_m?: number | null; timestamp?: number; observation_id?: string | null; frame_id?: string | null; timestamp_basis?: string; coordinate_frame?: string; provenance?: string | null }[];
  track?: TrackState | null;
  truth?: { lat: number; lon: number } | null;
  heatmap?: HeatCell[];
  blackboard?: { sender: string; recipient: string; kind: string; body: Record<string, unknown> }[];
  advisor?: StrategyPlan | null;
  c2?: {
    phase?: string; intent?: string; mission_active?: boolean; custody?: string | null;
    handoff?: { state?: string; receiver?: string | null; evidence?: string | null; cue_source?: string | null };
    tower_confirmation?: { hits: number; required_hits: number; window_s: number };
    observation_age_s?: number | null;
    metrics?: { confirmed_tower_cues?: number; confirmed_cues?: number; successful_handoffs?: number; reacquisitions?: number; custody_breaks?: number };
  };
  judge_track?: {
    enabled?: boolean;
    url?: string | null;
    name?: string;
    state?: string;
    created?: boolean;
    uuid?: string | null;
    lat?: number | null;
    lon?: number | null;
    heading?: number | null;
    speed?: number | null;
    error?: string | null;
    judge_tracks?: { name?: string; uuid?: string; lat?: number; lon?: number }[];
  };
  intents?: Record<string, string>;
  commands?: { vehicle_id: string; type: string; lat?: number | null; lon?: number | null; alt?: number | null; yaw_deg?: number | null; sector?: number | null; command_id?: string | null }[];
  arena?: { origin_lat: number; origin_lon: number; half_m: number; heading_offset_deg?: number };
};

export type StrategyPlan = {
  assigned_vehicle?: string;
  intercept?: { lat: number; lon: number };
  rationale?: string;
  role_bias?: Record<string, string>;
  radio_script?: string;
  ts?: string;
};
