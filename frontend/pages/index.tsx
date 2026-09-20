import dynamic from "next/dynamic";
import Head from "next/head";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import CameraRail from "../components/CameraRail";
import GraphTrainingDemo from "../components/GraphTrainingDemo";
import TelemetryMonitor, { getBackendStatusNotice } from "../components/TelemetryMonitor";
import { BrandMark, Icon } from "../components/ui/Icons";
import { Tabs } from "../components/ui/Tabs";
import { useMissionTelemetry } from "../hooks/useMissionTelemetry";
import { themes, themeStyle, type ThemeId } from "../lib/theme";
import type { SwarmState, TelemetrySample, TrackState } from "../lib/types";

const TacticalMap = dynamic(() => import("../components/TacticalMap"), {
  ssr: false,
  loading: () => <Loading>Loading map…</Loading>,
});
const TacticalScene = dynamic(() => import("../components/TacticalScene"), {
  ssr: false,
  loading: () => <Loading>Preparing operational scene…</Loading>,
});
const FleetModelPreview = dynamic(
  () => import("../components/TacticalScene").then((m) => m.FleetModelPreview),
  { ssr: false, loading: () => <Loading>Loading platform models…</Loading> },
);
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
type Section = "overview" | "fleet" | "cameras" | "activity" | "system";
const sections: {
  value: Section;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: "overview",
    label: "Overview",
    icon: "arena",
    description: "Optimize tower sites, test detection and drone handoff, then follow the live mission below.",
  },
  {
    value: "fleet",
    label: "Fleet",
    icon: "fleet",
    description: "Inspect reported platform state and the fleet’s 3D models.",
  },
  {
    value: "cameras",
    label: "Cameras",
    icon: "camera",
    description: "Sensor imagery from the simulator’s camera catalog.",
  },
  {
    value: "activity",
    label: "Activity",
    icon: "route",
    description: "Reported tasking, recent commands, and advisor reasoning.",
  },
  {
    value: "system",
    label: "System monitor",
    icon: "pulse",
    description:
      "Monitor the connection between this dashboard and the simulation.",
  },
];
const EMPTY_FLEET: Record<string, TelemetrySample> = {};

export default function CommandCenter() {
  const telemetry = useMissionTelemetry();
  const { state, strategy, isFresh, hasReceived, lastReceived, connection } =
    telemetry;
  const [section, setSection] = useState<Section>("overview");
  const [view, setView] = useState<"3d" | "2d">("3d");
  const [themeId, setThemeId] = useState<ThemeId>("ink");
  const [selected, setSelected] = useState<string | null>(null);
  const [showCoverage, setShowCoverage] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [showTruth, setShowTruth] = useState(false);
  const [query, setQuery] = useState("");
  const [vehicleClass, setVehicleClass] = useState("all");
  const [compactNavigation, setCompactNavigation] = useState(false);
  const fleet = state.fleet ?? EMPTY_FLEET;
  const vehicles = useMemo(() => Object.values(fleet), [fleet]);
  const focused = vehicles.find((v) => v.vehicle_id === selected);
  const track = state.track ?? null;
  const theme = themes[themeId];
  const backendNotice = getBackendStatusNotice(state.status);
  const stale = hasReceived && !isFresh && !backendNotice;
  const source =
    state.adapter === "local"
      ? "Local kinematic simulation"
      : state.adapter === "whiteout"
        ? "WHITEOUT simulator"
        : (state.adapter ?? "Awaiting simulation");
  const activeSection = sections.find((item) => item.value === section)!;
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [section]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setCompactNavigation(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const linkLabel = backendNotice?.label ?? (isFresh
    ? "Receiving telemetry"
    : stale
      ? "Stale telemetry"
      : connection === "live"
        ? "Waiting for state"
        : "Waiting for simulation");
  const shownVehicles = vehicles.filter(
    (v) =>
      (vehicleClass === "all" || v.vehicle_class === vehicleClass) &&
      `${v.vehicle_id} ${v.role ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const renderedTrack = track && !showTrail ? { ...track, history: [] } : track;
  useEffect(() => {
    try {
      const saved = localStorage.getItem("overwatch-theme");
      if (saved && Object.hasOwn(themes, saved)) setThemeId(saved as ThemeId);
    } catch {}
  }, []);
  useEffect(() => {
    if (selected && !fleet[selected]) setSelected(null);
  }, [fleet, selected]);
  const chooseTheme = (id: ThemeId) => {
    setThemeId(id);
    try {
      localStorage.setItem("overwatch-theme", id);
    } catch {}
  };

  return (
    <>
      <Head>
        <title>{`Overwatch | ${activeSection.label}`}</title>
        <meta
          name="description"
          content="Arctic mission dashboard with an interactive tower placement demo."
        />
        <meta name="theme-color" content={theme.colors.surface} />
      </Head>
      <main
        className={`mission-shell theme-${themeId}`}
        style={themeStyle(themeId)}
      >
        <aside className="mission-sidebar">
          <a
            className="brand"
            href="#workspace"
            onClick={() => setSection("overview")}
            aria-label="Overwatch overview"
          >
            <BrandMark />
            <span>
              OVERWATCH<small>WHITEOUT operations</small>
            </span>
          </a>
          <div className="sidebar-mission">
            <span className="mission-cross">
              <Icon name="target" />
            </span>
            <div>
              <strong>Arctic mission</strong>
              <span>{state.adapter ?? "No adapter connected"}</span>
            </div>
          </div>
          <Tabs
            id="section"
            label="Dashboard sections"
            value={section}
            onValueChange={setSection}
            orientation={compactNavigation ? "horizontal" : "vertical"}
            className="main-navigation"
            items={sections.map((item) => ({
              value: item.value,
              label: (
                <>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {item.value === "fleet" && vehicles.length > 0 && (
                    <small>{vehicles.length}</small>
                  )}
                </>
              ),
            }))}
          />
          <div className="sidebar-bottom">
            <div className="observation-note">
              <Icon name="eye" />
              <div>
                <strong>Observation mode</strong>
                <p>Monitoring the simulation.</p>
              </div>
            </div>
            <label className="appearance-select">
              Appearance
              <select
                aria-label="Appearance"
                value={themeId}
                onChange={(e) => chooseTheme(e.target.value as ThemeId)}
              >
                {Object.values(themes).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sidebar-caption">
              Shared intelligence.
              <br />
              One mission picture.
            </div>
          </div>
        </aside>
        <div className="mission-main">
          <header className="workspace-header">
            <div className="breadcrumb">
              <span>WHITEOUT</span>
              <span>/</span>
              <strong>{activeSection.label}</strong>
            </div>
            <button
              className={`connection-pill ${isFresh ? "is-live" : stale || state.status === "failed" ? "is-stale" : ""}`}
              onClick={() => setSection("system")}
              type="button"
            >
              <i />
              {linkLabel}
              <Icon name="chevron" />
            </button>
          </header>
          <div
            className="dashboard-content"
            id={`section-panel-${section}`}
            role="tabpanel"
            aria-labelledby={`section-tab-${section}`}
            tabIndex={0}
          >
            <section className="section-intro" id="workspace">
              <div>
                <h1>
                  {section === "overview"
                    ? "Mission overview"
                    : activeSection.label}
                </h1>
                <p>{activeSection.description}</p>
              </div>
              <div className="mission-badges">
                <span className="phase-badge">
                  {state.c2?.phase
                    ? `Phase: ${state.c2.phase.replaceAll("_", " ")}`
                    : "Awaiting mission phase"}
                </span>
                <span className="read-only-badge">
                  <Icon name="eye" />
                  Live fleet read only
                </span>
              </div>
            </section>
            {backendNotice && (
              <div className="connection-notice" role="status">
                <Icon name="pulse" />
                <div><strong>{backendNotice.title}</strong> {backendNotice.description}</div>
              </div>
            )}
            {stale && (
              <div className="connection-notice" role="status">
                <Icon name="signal" />
                <div>
                  <strong>Telemetry interrupted.</strong> Showing the last
                  received state
                  {telemetry.ageSeconds != null
                    ? ` (${fmt(telemetry.ageSeconds, 0)} seconds ago)`
                    : ""}
                  . {connection === "live" ? "Waiting for current telemetry from the open connection." : "The dashboard will reconnect automatically."}
                </div>
              </div>
            )}
            {section === "overview" && (
              <>
                <GraphTrainingDemo />
                <section className="score-strip" aria-label="Mission scores">
                  <Score
                    label="Coverage"
                    value={state.scores?.coverage}
                    detail={
                      state.scores
                        ? `${fmt(state.scores.cells_seen)} / ${fmt(state.scores.cells_total)} observed cells`
                        : "Observed arena cells"
                    }
                    icon="coverage"
                  />
                  <Score
                    label="Collaboration"
                    value={state.scores?.collaboration}
                    detail={
                      state.scores
                        ? `${fmt(state.scores.unique_roles)} roles · ${fmt(state.scores.overlap_ratio, 2)} overlap`
                        : "Roles working together"
                    }
                    icon="fleet"
                  />
                  <Score
                    label="Efficiency"
                    value={state.scores?.efficiency}
                    detail={
                      state.scores
                        ? `${fmt(state.scores.time_to_detect_s, 1)} s first detect · ${fmt(state.scores.meters_flown)} m`
                        : "Detection and movement"
                    }
                    icon="route"
                  />
                  <Score
                    label="Tracking accuracy"
                    value={
                      state.scores?.track_error_m == null
                        ? undefined
                        : state.scores.tracking
                    }
                    detail={
                      state.scores?.track_error_m != null
                        ? `${fmt(state.scores.track_error_m, 1)} m error against truth`
                        : "Evaluation truth unavailable"
                    }
                    icon="target"
                  />
                </section>
                <div className="operations-workbench">
                  <section
                    className="scene-panel"
                    aria-label="Operational picture"
                  >
                    <div className="panel-heading">
                      <h2>Operational picture</h2>
                      <Tabs
                        id="view"
                        label="Operational view"
                        value={view}
                        onValueChange={setView}
                        variant="pill"
                        items={[
                          { value: "3d", label: "3D scene" },
                          { value: "2d", label: "2D map" },
                        ]}
                      />
                    </div>
                    <div className="scene-toolbar">
                      <span>
                        <Icon name="layers" />
                        Layers
                      </span>
                      <Layer
                        active={showCoverage}
                        onClick={() => setShowCoverage((v) => !v)}
                      >
                        Coverage
                      </Layer>
                      <Layer
                        active={showTrail}
                        onClick={() => setShowTrail((v) => !v)}
                      >
                        Track trail
                      </Layer>
                      <Layer
                        active={showTruth}
                        onClick={() => setShowTruth((v) => !v)}
                      >
                        Evaluation truth
                      </Layer>
                    </div>
                    <div
                      className="scene-viewport"
                      id={`view-panel-${view}`}
                      role="tabpanel"
                      aria-labelledby={`view-tab-${view}`}
                      tabIndex={0}
                    >
                      {view === "3d" ? (
                        <TacticalScene
                          fleet={fleet}
                          track={renderedTrack}
                          truth={showTruth ? (state.truth ?? null) : null}
                          heatmap={showCoverage ? (state.heatmap ?? []) : []}
                          strategy={strategy}
                          arena={state.arena}
                          scene={theme.scene}
                          selectedVehicleId={selected}
                          onSelectVehicle={setSelected}
                        />
                      ) : (
                        <TacticalMap
                          fleet={fleet}
                          track={renderedTrack}
                          truth={showTruth ? (state.truth ?? null) : null}
                          heatmap={showCoverage ? (state.heatmap ?? []) : []}
                          strategy={strategy}
                          arena={state.arena}
                          scene={theme.scene}
                        />
                      )}
                      {!hasReceived && (
                        <div className="scene-waiting">
                          <span className="waiting-line" />
                          <div>
                            <strong>Standing by for simulation</strong>
                            <p>
                              Fleet positions appear here as telemetry arrives.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="scene-footer">
                      <span>
                        <i className="legend-dot" />
                        Fleet assets
                      </span>
                      <span>
                        <i className="legend-dot is-target" />
                        Target estimate
                      </span>
                      <span className="scene-source">
                        {state.arena
                          ? `${fmt((state.arena.half_m * 2) / 1000, 1)} km arena`
                          : "Stand-in arena"}
                      </span>
                    </div>
                  </section>
                  <aside className="roster-panel">
                    <div className="panel-heading">
                      <h2>Fleet roster</h2>
                      <span className="count-badge">
                        {vehicles.length} assets
                      </span>
                    </div>
                    <div className="intent-block">
                      <span>Mission intent</span>
                      <p>
                        {state.c2?.intent ??
                          "Waiting for the mission controller’s tasking."}
                      </p>
                      {state.c2?.handoff && <p>Handoff: {state.c2.handoff.state ?? "waiting"}{state.c2.custody ? ` · Observer: ${state.c2.custody}` : " · No current observer"}{state.c2.metrics?.successful_handoffs !== undefined ? ` · ${state.c2.metrics.successful_handoffs} confirmed transfers` : ""}</p>}
                    </div>
                    <div className="roster-list">
                      {vehicles.length ? (
                        vehicles.map((v) => (
                          <RosterRow
                            key={v.vehicle_id}
                            vehicle={v}
                            selected={selected === v.vehicle_id}
                            onSelect={() =>
                              setSelected(
                                selected === v.vehicle_id ? null : v.vehicle_id,
                              )
                            }
                            intent={state.intents?.[v.vehicle_id]}
                          />
                        ))
                      ) : (
                        <Empty
                          icon="fleet"
                          title="No assets reporting"
                          description="The fleet roster fills automatically when the simulation connects."
                        />
                      )}
                    </div>
                    <AssetInspector vehicle={focused} />
                  </aside>
                </div>
                <div className="overview-bottom">
                  <section className="panel target-panel">
                    <div className="panel-heading">
                      <h2>Target intelligence</h2>
                      <span className="count-badge">
                        {track ? "Fused estimate" : "No track"}
                      </span>
                    </div>
                    <TargetDetails track={track} />
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Recent tasking</h2>
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => setSection("activity")}
                      >
                        View activity
                        <Icon name="arrow" />
                      </button>
                    </div>
                    <ActivityFeed state={state} limit={4} />
                  </section>
                </div>
              </>
            )}
            {section === "fleet" && (
              <>
                <section className="panel fleet-table-panel">
                  <div className="panel-heading">
                    <h2>
                      Reporting assets{" "}
                      <span className="heading-count">{vehicles.length}</span>
                    </h2>
                    <div className="table-filters">
                      <label className="search-field">
                        <Icon name="search" />
                        <input
                          type="search"
                          aria-label="Search fleet"
                          placeholder="Search assets or roles"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Filter platform class"
                        value={vehicleClass}
                        onChange={(e) => setVehicleClass(e.target.value)}
                      >
                        <option value="all">All platforms</option>
                        <option value="plane">Fixed wing</option>
                        <option value="copter">Quadcopter</option>
                        <option value="rover">Rover</option>
                        <option value="tower">Sensor tower</option>
                      </select>
                    </div>
                  </div>
                  {shownVehicles.length ? (
                    <div className="table-scroll">
                      <table className="fleet-table">
                        <thead>
                          <tr>
                            <th>Asset</th>
                            <th>Role</th>
                            <th>Altitude</th>
                            <th>Speed</th>
                            <th>Heading</th>
                            <th>Battery</th>
                            <th>Transport</th>
                            <th>
                              <span className="sr-only">Inspect</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {shownVehicles.map((v) => (
                            <tr
                              key={v.vehicle_id}
                              className={
                                selected === v.vehicle_id ? "selected-row" : ""
                              }
                            >
                              <td>
                                <span className="asset-cell">
                                  <Icon name={v.vehicle_class ?? "fleet"} />
                                  <strong>{v.vehicle_id}</strong>
                                </span>
                              </td>
                              <td>
                                <Role value={v.role} />
                              </td>
                              <td>{fmt(v.alt, 1)} m</td>
                              <td>{fmt(v.groundspeed, 1)} m/s</td>
                              <td>{fmt(v.heading)}°</td>
                              <td>{formatBattery(v.battery_remaining)}</td>
                            <td>{v.mavlink === true ? "MAVLink" : v.mavlink === false ? "Kinematic" : "Unreported"}</td>
                              <td>
                                <button
                                  className="table-action"
                                  aria-label={`Inspect ${v.vehicle_id}`}
                                  onClick={() =>
                                    setSelected(
                                      selected === v.vehicle_id
                                        ? null
                                        : v.vehicle_id,
                                    )
                                  }
                                >
                                  <Icon name="chevron" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty
                      icon="fleet"
                      title={
                        vehicles.length
                          ? "No matching assets"
                          : "Waiting for the fleet"
                      }
                      description={
                        vehicles.length
                          ? "Try another asset name, role, or platform filter."
                          : "Live platform state will appear here when telemetry connects."
                      }
                    />
                  )}
                  {focused && (
                    <div className="fleet-expanded">
                      <AssetInspector vehicle={focused} />
                      <div className="asset-intent">
                        <h3>Assigned intent</h3>
                        <p>
                          {state.intents?.[focused.vehicle_id] ??
                            "No tasking supplied for this asset."}
                        </p>
                      </div>
                    </div>
                  )}
                </section>
                <section className="panel platform-reference">
                  <div className="panel-heading">
                    <div>
                      <h2>Platform reference</h2>
                      <p className="panel-subtitle">
                        Inspect the models used in the operational scene.
                      </p>
                    </div>
                    <span className="count-badge">Display models</span>
                  </div>
                  <div className="model-viewport">
                    <FleetModelPreview scene={theme.scene} />
                  </div>
                </section>
              </>
            )}
            {section === "cameras" && (
              <section className="panel cameras-page">
                <div className="panel-heading">
                  <h2>Sensor feeds</h2>
                  <span className="count-badge">{source}</span>
                </div>
                <div className="section-note">
                  <Icon name="camera" />
                  <p>
                    Frames are received through the existing camera proxy.
                    Receipt time is shown when a frame arrives; capture
                    freshness is not supplied.
                  </p>
                </div>
                <CameraRail apiUrl={API_URL} adapter={state.adapter} />
                <section className="detection-section">
                  <h2>Reported detections</h2>
                  <DetectionList state={state} />
                </section>
              </section>
            )}
            {section === "activity" && (
              <div className="activity-layout">
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Tasking traffic</h2>
                    <span className="count-badge">
                      Latest received messages
                    </span>
                  </div>
                  <ActivityFeed state={state} limit={24} />
                  <p className="panel-footnote">
                    Tasking records show intent. They do not confirm completed
                    handoffs.
                  </p>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Latest commands</h2>
                    <span className="count-badge">Reported by controller</span>
                  </div>
                  {state.commands?.length ? (
                    <ul className="command-list">
                      {state.commands.map((c, i) => (
                        <li key={`${c.vehicle_id}-${i}`}>
                          <Icon name="route" />
                          <div>
                            <strong>{c.vehicle_id}</strong>
                            <span>{c.type.replaceAll("_", " ")}</span>
                          </div>
                          {c.lat != null && c.lon != null && (
                            <span className="coordinate">
                              {fmt(c.lat, 4)}, {fmt(c.lon, 4)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty
                      icon="route"
                      title="No commands received"
                      description="The controller’s latest tasking will appear here."
                    />
                  )}
                  <p className="panel-footnote">
                    Reported commands are not execution acknowledgements.
                  </p>
                </section>
                <section className="panel advisor-readout">
                  <div className="panel-heading">
                    <h2>Advisor reasoning</h2>
                    <span className="count-badge">Read only</span>
                  </div>
                  {strategy?.rationale ? (
                    <div className="advisor-content">
                      <p>{strategy.rationale}</p>
                      {strategy.assigned_vehicle && (
                        <dl className="facts">
                          <Fact
                            label="Suggested asset"
                            value={strategy.assigned_vehicle}
                          />
                          {strategy.ts && (
                            <Fact label="Reported at" value={strategy.ts} />
                          )}
                        </dl>
                      )}
                    </div>
                  ) : (
                    <Empty
                      icon="pulse"
                      title="No advisor message"
                      description="Advice produced by the mission controller will appear here."
                    />
                  )}
                </section>
              </div>
            )}
            {section === "system" && <TelemetryMonitor telemetry={telemetry} />}
          </div>
          <footer className="mission-footer">
            <span>
              <i className={`footer-dot ${isFresh ? "is-live" : ""}`} />
              {source}
            </span>
            <span>
              {lastReceived
                ? `Last state ${new Date(lastReceived).toLocaleTimeString("en-GB", { timeZone: "UTC" })} UTC`
                : "No state received"}
            </span>
            <span>
              {vehicles.length} assets<span className="footer-divider">/</span>
              {fmt(state.tick_hz, 1)} Hz controller
            </span>
          </footer>
        </div>
      </main>
    </>
  );
}
function Score({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value?: number | null;
  detail: string;
  icon: string;
}) {
  const valid = typeof value === "number" && Number.isFinite(value);
  return (
    <div className="score-tile">
      <Icon name={icon} />
      <div className="score-content">
        <div className="score-top">
          <span>{label}</span>
          {valid ? (
            <strong>
              {Math.round(value * 100)}
              <small>/100</small>
            </strong>
          ) : (
            <strong className="score-unavailable">
              —<small>Unavailable</small>
            </strong>
          )}
        </div>
        <p>{detail}</p>
        <div className="score-rule">
          {valid && (
            <span
              style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
function Layer({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="layer-toggle"
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="layer-check">{active && <Icon name="check" />}</span>
      {children}
    </button>
  );
}
function Role({ value }: { value?: string | null }) {
  return (
    <span className={`role-tag role-${value ?? "reserve"}`}>
      {value ?? "Unassigned"}
    </span>
  );
}
function RosterRow({
  vehicle: v,
  selected,
  onSelect,
  intent,
}: {
  vehicle: TelemetrySample;
  selected: boolean;
  onSelect: () => void;
  intent?: string;
}) {
  return (
    <button
      type="button"
      className={`roster-row ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="platform-icon">
        <Icon name={v.vehicle_class ?? "fleet"} />
      </span>
      <span className="roster-info">
        <span>
          <strong>{v.vehicle_id}</strong>
          <Role value={v.role} />
        </span>
        <small>
          {intent ?? `${fmt(v.alt)} m altitude · ${fmt(v.groundspeed, 1)} m/s`}
        </small>
      </span>
      <Icon name="chevron" />
    </button>
  );
}
function AssetInspector({ vehicle: v }: { vehicle?: TelemetrySample }) {
  return (
    <section className="asset-inspector">
      <div className="inspector-heading">
        <Icon name={v?.vehicle_class ?? "target"} />
        <h3>{v?.vehicle_id ?? "Asset inspector"}</h3>
        {v && <span>{v.vehicle_class}</span>}
      </div>
      {v ? (
        <dl className="facts">
          <Fact label="Position" value={`${fmt(v.lat, 4)}, ${fmt(v.lon, 4)}`} />
          <Fact label="Altitude" value={`${fmt(v.alt, 1)} m`} />
          <Fact label="Speed" value={`${fmt(v.groundspeed, 1)} m/s`} />
          <Fact label="Heading" value={`${fmt(v.heading)}°`} />
          <Fact
            label="Battery"
            value={
              formatBattery(v.battery_remaining)
            }
          />
          <Fact label="Mode" value={v.mode ?? "Unavailable"} />
        </dl>
      ) : (
        <p>
          Select an asset in the roster or 3D scene to inspect its reported
          telemetry.
        </p>
      )}
    </section>
  );
}
function TargetDetails({ track }: { track: TrackState | null }) {
  return (
    <div className="target-content">
      {track ? (
        <>
          <div className="track-identity">
            <Icon name="target" />
            <strong>{track.class_hint ?? "Target"} estimate</strong>
            <span>Freshness unavailable</span>
          </div>
          <dl className="facts">
            <Fact
              label="Position"
              value={`${fmt(track.lat, 4)}, ${fmt(track.lon, 4)}`}
            />
            <Fact
              label="Speed"
              value={
                track.speed_mps == null
                  ? "Unavailable"
                  : `${fmt(track.speed_mps, 1)} m/s`
              }
            />
            <Fact
              label="Scalar uncertainty"
              value={
                track.sigma_m == null
                  ? "Unavailable"
                  : `${fmt(track.sigma_m, 1)} m σ`
              }
            />
            <Fact
              label="Heuristic confidence"
              value={
                track.confidence == null
                  ? "Unavailable"
                  : `${fmt(track.confidence * 100)}%`
              }
            />
            <Fact
              label="Filter age"
              value={
                track.age_s == null ? "Unavailable" : `${fmt(track.age_s, 1)} s`
              }
            />
          </dl>
        </>
      ) : (
        <Empty
          icon="target"
          title="No target estimate"
          description="Position, uncertainty, and detection confidence appear when a track is supplied."
        />
      )}
    </div>
  );
}
function ActivityFeed({ state, limit }: { state: SwarmState; limit: number }) {
  return state.blackboard?.length ? (
    <ol className="activity-feed">
      {state.blackboard
        .slice(-limit)
        .reverse()
        .map((m, i) => (
          <li key={`${m.sender}-${i}`}>
            <span className="activity-mark">
              <Icon name="arrow" />
            </span>
            <div>
              <p>
                <strong>{m.sender}</strong>
                <span>to {m.recipient}</span>
              </p>
              <small>{m.kind.replaceAll("_", " ")}</small>
            </div>
          </li>
        ))}
    </ol>
  ) : (
    <Empty
      icon="route"
      title="No tasking traffic"
      description="Coordination messages will appear as the mission progresses."
    />
  );
}
function DetectionList({ state }: { state: SwarmState }) {
  return state.detections?.length ? (
    <div className="table-scroll">
      <table className="fleet-table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Class</th>
            <th>Confidence</th>
            <th>Range</th>
            <th>Position</th>
          </tr>
        </thead>
        <tbody>
          {state.detections.map((d, i) => (
            <tr key={`${d.source_id}-${i}`}>
              <td>{d.source_id}</td>
              <td>{d.class_hint}</td>
              <td>{fmt(d.confidence * 100)}%</td>
              <td>
                {d.range_m == null ? "Unavailable" : `${fmt(d.range_m)} m`}
              </td>
              <td>
                {fmt(d.lat, 4)}, {fmt(d.lon, 4)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      icon="target"
      title="No detection reports"
      description="An empty report list does not establish that the scene is clear."
    />
  );
}
function Empty({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <Icon name={icon} />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
    </div>
  );
}
function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="view-loading">
      <Icon name="arena" />
      {children}
    </div>
  );
}
function fmt(n: number | null | undefined, d = 0) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(d) : "—";
}
function formatBattery(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${fmt(value)}%`
    : "Unavailable";
}
