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
};

export type HeatCell = { lat: number; lon: number; heat: number };

export type Scorecard = {
  coverage: number;
  collaboration: number;
  efficiency: number;
  tracking: number | null;
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
  scores?: Scorecard;
  fleet?: Record<string, TelemetrySample>;
  detections?: { source_id: string; lat: number; lon: number; class_hint: string; confidence: number; range_m?: number | null }[];
  track?: TrackState | null;
  truth?: { lat: number; lon: number } | null;
  heatmap?: HeatCell[];
  blackboard?: { sender: string; recipient: string; kind: string; body: Record<string, unknown> }[];
  advisor?: StrategyPlan | null;
  c2?: { phase?: string; intent?: string };
  intents?: Record<string, string>;
  commands?: { vehicle_id: string; type: string; lat?: number; lon?: number }[];
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
