import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import type { MissionTelemetry } from "../hooks/useMissionTelemetry";

/** Observe state transitions, never log or serialize the 10 Hz state stream. */
export default function MissionObservability({ telemetry }: { telemetry: MissionTelemetry }) {
  const { connection, isFresh, state } = telemetry;
  const runId = state.run?.run_id;
  const mode = state.run?.mode;
  useEffect(() => {
    Sentry.setTag("run.id", runId ?? "awaiting");
    Sentry.setTag("run.mode", mode ?? "unknown");
    Sentry.setContext("mission", { run_id: runId, mode, connection, fresh: isFresh, backend_status: state.status });
    const log = connection === "down" || state.status === "failed" ? Sentry.logger.warn : Sentry.logger.info;
    log("Mission telemetry state changed", {
      "event.name": "dashboard.telemetry", "run.id": runId ?? "awaiting",
      "run.mode": mode ?? "unknown", connection, fresh: isFresh, "backend.status": state.status ?? "unknown",
    });
  }, [runId, mode, connection, isFresh, state.status]);
  return null;
}
