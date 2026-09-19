import dynamic from "next/dynamic";
import Head from "next/head";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Scorecard, StrategyPlan, SwarmState, TelemetrySample, TrackState } from "../lib/types";

const TacticalMap = dynamic(() => import("../components/TacticalMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">Acquiring Arctic tiles…</div>
  ),
});

const TacticalScene = dynamic(() => import("../components/TacticalScene"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">Building stand-in arena…</div>
  ),
});

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/telemetry";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type ConnState = "connecting" | "live" | "down";

const EMPTY_SCORES: Scorecard = {
  coverage: 0,
  collaboration: 0,
  efficiency: 0,
  tracking: 0,
};

export default function CommandCenter() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [state, setState] = useState<SwarmState>({});
  const [strategy, setStrategy] = useState<StrategyPlan | null>(null);
  const [view, setView] = useState<"3d" | "2d">("3d");

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      setConn("connecting");
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConn("live");
      ws.onclose = () => {
        setConn("down");
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as SwarmState & { type?: string; data?: StrategyPlan };
          if (msg.type === "strategy") {
            setStrategy(msg.data ?? null);
            return;
          }
          setState(msg);
          if (msg.advisor) setStrategy(msg.advisor);
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const fleet = state.fleet ?? {};
  const vehicles = useMemo(() => Object.values(fleet), [fleet]);
  const scores = state.scores ?? EMPTY_SCORES;
  const track: TrackState | null = state.track ?? null;
  const deployed = Boolean(state.deployed);

  return (
    <>
      <Head>
        <title>OVERWATCH // WHITEOUT</title>
      </Head>
      <main className="flex h-full min-h-screen flex-col bg-ice-950 text-slate-100">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.28em] text-teal-400/80">Dominion Dynamics · WHITEOUT</div>
            <h1 className="font-mono text-lg tracking-wide">OPERATION OVERWATCH</h1>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
            <span
              className={`rounded px-2 py-1 ${deployed && conn === "live" ? "bg-teal-900/70 text-teal-200" : "bg-rose-950 text-rose-200"}`}
            >
              {deployed && conn === "live" ? "AGENT DEPLOYED" : "AGENT DOWN"}
            </span>
            <StatusDot state={conn} />
            <span>{state.adapter ?? "—"}</span>
            <span className="uppercase text-amber-200">C2 {state.c2?.phase ?? "find"}</span>
            <span>{(state.tick_hz ?? 0).toFixed(1)} Hz</span>
            <span className="inline-flex overflow-hidden rounded border border-slate-600">
              <button
                type="button"
                onClick={() => setView("3d")}
                className={`px-2 py-1 ${view === "3d" ? "bg-slate-700 text-teal-200" : "text-slate-400"}`}
              >
                3D
              </button>
              <button
                type="button"
                onClick={() => setView("2d")}
                className={`px-2 py-1 ${view === "2d" ? "bg-slate-700 text-teal-200" : "text-slate-400"}`}
              >
                2D
              </button>
            </span>
            <button
              type="button"
              onClick={() => fetch(`${API_URL}/strategy/run`, { method: "POST" }).catch(() => undefined)}
              className="rounded border border-slate-600 px-3 py-1 text-slate-200 hover:bg-slate-800"
            >
              Advisor pulse
            </button>
          </div>
        </header>

        <div className="grid grid-cols-2 gap-px border-b border-slate-800 bg-slate-800 lg:grid-cols-4">
          <ScoreTile label="Coverage" value={scores.coverage} hint={`${scores.cells_seen ?? 0}/${scores.cells_total ?? 0} cells`} />
          <ScoreTile label="Collaboration" value={scores.collaboration} hint={`${scores.unique_roles ?? 0} roles · overlap ${(scores.overlap_ratio ?? 0).toFixed(2)}`} />
          <ScoreTile label="Efficiency" value={scores.efficiency} hint={`ttd ${fmt(scores.time_to_detect_s, 1)}s · ${Math.round(scores.meters_flown ?? 0)} m`} />
          <ScoreTile label="Tracking" value={scores.tracking} hint={`err ${fmt(scores.track_error_m, 1)} m`} />
        </div>

        <section className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="relative min-h-[420px]">
            {view === "3d" ? (
              <TacticalScene
                fleet={fleet}
                track={track}
                truth={state.truth ?? null}
                heatmap={state.heatmap ?? []}
                strategy={strategy}
                arena={state.arena}
              />
            ) : (
              <TacticalMap
                fleet={fleet}
                track={track}
                truth={state.truth ?? null}
                heatmap={state.heatmap ?? []}
                strategy={strategy}
                arena={state.arena}
              />
            )}
          </div>
          <aside className="flex flex-col gap-4 overflow-y-auto border-l border-slate-800 bg-ice-900 p-4 text-sm">
            <Panel title="Fleet / roles">
              {state.c2?.intent && <p className="mb-3 text-xs text-amber-200/90">{state.c2.intent}</p>}
              {vehicles.length === 0 ? (
                <p className="text-slate-500">Waiting on adapter…</p>
              ) : (
                vehicles.map((v: TelemetrySample) => (
                  <div key={v.vehicle_id} className="mb-3 font-mono text-xs leading-5">
                    <div className="text-teal-300">
                      {v.vehicle_id} · {v.role ?? "—"} · {v.vehicle_class}
                    </div>
                    <div className="text-slate-400">{state.intents?.[v.vehicle_id] ?? "—"}</div>
                    <div>
                      lat {fmt(v.lat)} lon {fmt(v.lon)}
                    </div>
                    <div>
                      alt {fmt(v.alt, 1)} m · {v.mavlink ? "MAVLink" : "kinematic"}
                    </div>
                  </div>
                ))
              )}
            </Panel>
            <Panel title="Blackboard">
              {(state.blackboard ?? []).length === 0 && !strategy ? (
                <p className="text-slate-500">No tasking traffic yet.</p>
              ) : (
                <ul className="space-y-2 text-xs text-slate-300">
                  {(state.blackboard ?? []).slice(-8).map((m, i) => (
                    <li key={i}>
                      {m.sender} → {m.recipient}: {m.kind}
                    </li>
                  ))}
                  {strategy?.rationale && <li className="text-amber-200">{strategy.rationale}</li>}
                </ul>
              )}
            </Panel>
          </aside>
        </section>
      </main>
    </>
  );
}

function ScoreTile({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-ice-950 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="font-mono text-2xl text-teal-300">{(value * 100).toFixed(0)}</div>
      <div className="text-[11px] text-slate-500">{hint}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] uppercase tracking-[0.2em] text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function StatusDot({ state }: { state: ConnState }) {
  const color = state === "live" ? "bg-teal-400" : state === "connecting" ? "bg-amber-400" : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {state}
    </span>
  );
}

function fmt(n: number | null | undefined, digits = 5) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}
