import { CircleMarker, MapContainer, Polyline, Popup, TileLayer, Tooltip } from "react-leaflet";
import type { HeatCell, StrategyPlan, TelemetrySample, TrackState } from "../lib/types";

const ARENA: [number, number] = [74.6973, -94.8297];

const ROLE_COLOR: Record<string, { color: string; fill: string }> = {
  search: { color: "#5eead4", fill: "#14b8a6" },
  track: { color: "#fbbf24", fill: "#f59e0b" },
  confirm: { color: "#fb7185", fill: "#f43f5e" },
  cue: { color: "#c4b5fd", fill: "#8b5cf6" },
  reserve: { color: "#94a3b8", fill: "#64748b" },
};

type Props = {
  fleet: Record<string, TelemetrySample>;
  track: TrackState | null;
  truth: { lat: number; lon: number } | null;
  heatmap: HeatCell[];
  strategy: StrategyPlan | null;
};

export default function TacticalMap({ fleet, track, truth, heatmap, strategy }: Props) {
  const vehicles = Object.values(fleet).filter((v) => v.lat != null && v.lon != null);
  const intercept = strategy?.intercept;

  return (
    <MapContainer center={ARENA} zoom={12} className="h-full w-full" zoomControl attributionControl={false}>
      <TileLayer
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        attribution="&copy; OSM &copy; CARTO"
      />

      {heatmap.map((c, i) => (
        <CircleMarker
          key={`h-${i}`}
          center={[c.lat, c.lon]}
          radius={10}
          pathOptions={{
            color: "transparent",
            fillColor: "#22d3ee",
            fillOpacity: 0.12 + c.heat * 0.35,
            weight: 0,
          }}
        />
      ))}

      <CircleMarker center={ARENA} radius={4} pathOptions={{ color: "#4b5563", fillOpacity: 0.4 }}>
        <Tooltip permanent direction="right" offset={[8, 0]}>
          origin
        </Tooltip>
      </CircleMarker>

      {vehicles.map((v) => {
        const tone = ROLE_COLOR[v.role ?? "reserve"] ?? ROLE_COLOR.reserve;
        return (
          <CircleMarker
            key={v.vehicle_id}
            center={[v.lat as number, v.lon as number]}
            radius={v.vehicle_class === "tower" ? 6 : 9}
            pathOptions={{ color: tone.color, fillColor: tone.fill, fillOpacity: 0.9, weight: 2 }}
          >
            <Popup>
              <div className="text-xs">
                <div className="font-semibold">
                  {v.vehicle_id} · {v.role ?? "—"}
                </div>
                <div>{v.vehicle_class}</div>
                <div>alt {v.alt?.toFixed(1) ?? "—"} m</div>
              </div>
            </Popup>
            <Tooltip>
              {v.vehicle_id} [{v.role}]
            </Tooltip>
          </CircleMarker>
        );
      })}

      {track && (
        <>
          <CircleMarker
            center={[track.lat, track.lon]}
            radius={Math.max(12, Math.min(40, (track.sigma_m ?? 40) / 8))}
            pathOptions={{ color: "#fb7185", fillColor: "#f43f5e", fillOpacity: 0.15, weight: 1 }}
          />
          <CircleMarker
            center={[track.lat, track.lon]}
            radius={8}
            pathOptions={{ color: "#fb7185", fillColor: "#e11d48", fillOpacity: 0.95, weight: 2 }}
          >
            <Tooltip permanent>track {track.class_hint}</Tooltip>
          </CircleMarker>
          {track.history && track.history.length > 1 && (
            <Polyline
              positions={track.history as [number, number][]}
              pathOptions={{ color: "#fb7185", weight: 2, opacity: 0.7 }}
            />
          )}
        </>
      )}

      {truth && (
        <CircleMarker center={[truth.lat, truth.lon]} radius={5} pathOptions={{ color: "#fde047", fillOpacity: 0.9 }}>
          <Tooltip>truth</Tooltip>
        </CircleMarker>
      )}

      {intercept && track && (
        <Polyline
          positions={[
            [track.lat, track.lon],
            [intercept.lat, intercept.lon],
          ]}
          pathOptions={{ color: "#fbbf24", dashArray: "6 8", weight: 1, opacity: 0.6 }}
        />
      )}
    </MapContainer>
  );
}
