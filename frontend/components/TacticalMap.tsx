import {
  Circle,
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  ScaleControl,
  TileLayer,
  Tooltip,
} from "react-leaflet";
import { DEFAULT_ARENA } from "../lib/geo";
import { sceneColors, type ScenePalette } from "../lib/theme";
import type {
  HeatCell,
  StrategyPlan,
  TelemetrySample,
  TrackState,
} from "../lib/types";

type Props = {
  fleet: Record<string, TelemetrySample>;
  track: TrackState | null;
  truth: { lat: number; lon: number } | null;
  heatmap: HeatCell[];
  strategy: StrategyPlan | null;
  arena?: { origin_lat: number; origin_lon: number };
  scene?: ScenePalette;
};

function validPosition(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
  );
}

export default function TacticalMap({
  fleet,
  track,
  truth,
  heatmap,
  strategy,
  arena,
  scene = sceneColors,
}: Props) {
  const vehicles = Object.values(fleet).filter((v) =>
    validPosition(v.lat, v.lon),
  );
  const target = track && validPosition(track.lat, track.lon) ? track : null;
  const evaluationTruth =
    truth && validPosition(truth.lat, truth.lon) ? truth : null;
  const plannedIntercept = strategy?.intercept;
  const intercept =
    plannedIntercept &&
    validPosition(plannedIntercept.lat, plannedIntercept.lon)
      ? plannedIntercept
      : null;
  const history =
    target?.history?.filter(([lat, lon]) => validPosition(lat, lon)) ?? [];
  const roleColors: Record<
    string,
    {
      color: string;
      fillColor: string;
      fillOpacity: number;
      dashArray?: string;
    }
  > = {
    search: { color: scene.chalk, fillColor: scene.muted, fillOpacity: 0.95 },
    track: { color: scene.chalk, fillColor: scene.rust, fillOpacity: 1 },
    confirm: { color: scene.rust, fillColor: scene.chalk, fillOpacity: 0.95 },
    cue: {
      color: scene.chalk,
      fillColor: scene.ink,
      fillOpacity: 0.85,
      dashArray: "2 2",
    },
    reserve: { color: scene.muted, fillColor: scene.ink, fillOpacity: 0.9 },
  };
  const originArena =
    arena && validPosition(arena.origin_lat, arena.origin_lon)
      ? arena
      : DEFAULT_ARENA;
  const origin: [number, number] = [
    originArena.origin_lat,
    originArena.origin_lon,
  ];

  return (
    <MapContainer
      key={`${origin[0]},${origin[1]}`}
      center={origin}
      zoom={12}
      className="h-full w-full"
      style={{ background: scene.void }}
      zoomControl
      attributionControl
    >
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution={
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        }
      />
      <ScaleControl position="bottomleft" imperial={false} />

      {heatmap
        .filter(
          (cell) =>
            validPosition(cell.lat, cell.lon) &&
            Number.isFinite(cell.heat) &&
            cell.heat > 0,
        )
        .map((c, i) => (
          <CircleMarker
            key={`h-${i}`}
            center={[c.lat, c.lon]}
            radius={10}
            interactive={false}
            pathOptions={{
              stroke: false,
              fillColor: scene.muted,
              fillOpacity: 0.12 + Math.min(1, c.heat) * 0.35,
              weight: 0,
            }}
          />
        ))}

      <CircleMarker
        center={origin}
        radius={4}
        pathOptions={{
          color: scene.muted,
          fillColor: scene.chalk,
          fillOpacity: 0.4,
        }}
      >
        <Tooltip permanent direction="right" offset={[8, 0]}>
          Arena origin
        </Tooltip>
      </CircleMarker>

      {vehicles.map((v) => {
        const tone = roleColors[v.role ?? "reserve"] ?? roleColors.reserve;
        return (
          <CircleMarker
            key={v.vehicle_id}
            center={[v.lat as number, v.lon as number]}
            radius={v.vehicle_class === "tower" ? 6 : 9}
            pathOptions={{ ...tone, weight: 2 }}
          >
            <Popup>
              <div className="text-xs">
                <div className="font-semibold">
                  {v.vehicle_id} · {v.role ?? "—"}
                </div>
                <div>{v.vehicle_class}</div>
                <div>
                  Altitude{" "}
                  {typeof v.alt === "number" && Number.isFinite(v.alt)
                    ? `${v.alt.toFixed(1)} m`
                    : "unavailable"}
                </div>
              </div>
            </Popup>
            <Tooltip>
              {v.vehicle_id} · {v.role ?? "Role unavailable"}
            </Tooltip>
          </CircleMarker>
        );
      })}

      {target && (
        <>
          {typeof target.sigma_m === "number" &&
            Number.isFinite(target.sigma_m) &&
            target.sigma_m > 0 && (
              <Circle
                center={[target.lat, target.lon]}
                radius={target.sigma_m}
                pathOptions={{
                  color: scene.rust,
                  fillColor: scene.rust,
                  fillOpacity: 0.12,
                  weight: 1,
                  dashArray: "4 4",
                }}
              >
                <Tooltip>
                  Reported scalar uncertainty · σ {target.sigma_m.toFixed(0)} m
                </Tooltip>
              </Circle>
            )}
          <CircleMarker
            center={[target.lat, target.lon]}
            radius={8}
            pathOptions={{
              color: scene.chalk,
              fillColor: scene.rust,
              fillOpacity: 1,
              weight: 2,
            }}
          >
            <Tooltip permanent>
              Target estimate · {target.class_hint || "Unclassified"}
            </Tooltip>
          </CircleMarker>
          {history.length > 1 && (
            <Polyline
              positions={history}
              pathOptions={{ color: scene.rust, weight: 2, opacity: 0.75 }}
              interactive={false}
            />
          )}
        </>
      )}

      {evaluationTruth && (
        <CircleMarker
          center={[evaluationTruth.lat, evaluationTruth.lon]}
          radius={6}
          pathOptions={{
            color: scene.chalk,
            fill: false,
            weight: 2,
            dashArray: "2 3",
          }}
        >
          <Tooltip>Evaluation truth · local simulation</Tooltip>
        </CircleMarker>
      )}

      {intercept && (
        <>
          {target && (
            <Polyline
              positions={[
                [target.lat, target.lon],
                [intercept.lat, intercept.lon],
              ]}
              pathOptions={{
                color: scene.rust,
                dashArray: "6 8",
                weight: 1.5,
                opacity: 0.8,
              }}
              interactive={false}
            />
          )}
          <CircleMarker
            center={[intercept.lat, intercept.lon]}
            radius={6}
            pathOptions={{
              color: scene.rust,
              fill: false,
              dashArray: "3 3",
              weight: 2,
            }}
          >
            <Tooltip>
              Planned intercept
              {strategy?.assigned_vehicle
                ? ` · ${strategy.assigned_vehicle}`
                : ""}
            </Tooltip>
          </CircleMarker>
        </>
      )}
    </MapContainer>
  );
}
