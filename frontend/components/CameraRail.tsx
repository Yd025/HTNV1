import { useEffect, useRef, useState } from "react";

type Camera = { vehicle_id: string; label: string; snapshot: string };
type CatalogState = "loading" | "ready" | "error";
type FrameState = "waiting" | "ready" | "unavailable" | "paused";
type Frame = { url: string; receivedAt: Date };

const REFRESH_MS = 1400;
const REQUEST_TIMEOUT_MS = 5000;

/** Camera imagery is supplied by the adapter, independently of mission telemetry. */
export default function CameraRail({
  apiUrl,
  adapter,
}: {
  apiUrl: string;
  adapter?: string;
}) {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [attempt, setAttempt] = useState(0);
  const railRef = useRef<HTMLElement>(null);
  const [inViewport, setInViewport] = useState(false);
  const [pageVisible, setPageVisible] = useState(false);
  const apiBase = apiUrl.replace(/\/$/, "");

  useEffect(() => {
    const updateVisibility = () => setPageVisible(!document.hidden);
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    const element = railRef.current;
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            setInViewport(entry.isIntersecting);
          });
    if (observer && element) observer.observe(element);
    else setInViewport(true);
    return () => {
      document.removeEventListener("visibilitychange", updateVisibility);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );
    setCatalogState("loading");
    setCameras([]);

    const discover = async () => {
      try {
        const response = await fetch(`${apiBase}/cameras`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Camera catalog unavailable");
        const catalog: unknown = await response.json();
        if (!Array.isArray(catalog)) throw new Error("Invalid camera catalog");
        const discovered = catalog.flatMap((value): Camera[] => {
          if (!value || typeof value !== "object") return [];
          const candidate = value as Record<string, unknown>;
          if (
            typeof candidate.vehicle_id !== "string" ||
            typeof candidate.snapshot !== "string"
          )
            return [];
          // The backend proxy is the only camera transport used by the HUD.
          if (
            !candidate.snapshot.startsWith("/cameras/") ||
            !candidate.snapshot.endsWith("/snapshot.jpg")
          )
            return [];
          return [
            {
              vehicle_id: candidate.vehicle_id,
              label:
                typeof candidate.label === "string"
                  ? candidate.label
                  : candidate.vehicle_id,
              snapshot: candidate.snapshot,
            },
          ];
        });
        if (stopped) return;
        setCameras(
          discovered.filter(
            (camera, index, all) =>
              all.findIndex((item) => item.vehicle_id === camera.vehicle_id) ===
              index,
          ),
        );
        setCatalogState("ready");
      } catch {
        if (!stopped) setCatalogState("error");
      } finally {
        window.clearTimeout(timeout);
      }
    };

    void discover();
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [apiBase, adapter, attempt]);

  const enabled = pageVisible && inViewport;

  return (
    <section
      ref={railRef}
      className="camera-rail"
      aria-label="Camera feeds"
      aria-busy={catalogState === "loading"}
    >
      {catalogState === "loading" && (
        <CameraEmpty
          title="Discovering cameras"
          description="Checking the adapter for available feeds."
        />
      )}
      {catalogState === "error" && (
        <CameraEmpty
          title="Camera catalog unavailable"
          description="Check the telemetry service, then try again."
        >
          <button
            className="camera-retry"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry cameras
          </button>
        </CameraEmpty>
      )}
      {catalogState === "ready" && cameras.length === 0 && (
        <CameraEmpty
          title="No camera feeds"
          description={
            adapter === "local"
              ? "The local adapter supplies simulated telemetry without camera imagery."
              : "This adapter has no cameras registered."
          }
        >
          <button
            className="camera-retry"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh cameras
          </button>
        </CameraEmpty>
      )}
      {catalogState === "ready" &&
        cameras.map((camera) => (
          <CameraFeed
            key={camera.vehicle_id}
            camera={camera}
            endpoint={`${apiBase}${camera.snapshot}`}
            enabled={enabled}
          />
        ))}
    </section>
  );
}

function CameraFeed({
  camera,
  endpoint,
  enabled,
}: {
  camera: Camera;
  endpoint: string;
  enabled: boolean;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [status, setStatus] = useState<FrameState>("waiting");
  const currentUrl = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let next: number | undefined;
    let timeout: number | undefined;
    let controller: AbortController | undefined;

    const clearFrame = () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null;
      setFrame(null);
    };

    clearFrame();
    setStatus(enabled ? "waiting" : "paused");
    if (!enabled) return;

    const refresh = async () => {
      controller = new AbortController();
      timeout = window.setTimeout(
        () => controller?.abort(),
        REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(endpoint, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (response.status === 204 || !response.ok)
          throw new Error("No frame available");
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith("image/"))
          throw new Error("Invalid camera image");
        if (stopped) return;
        const url = URL.createObjectURL(blob);
        if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
        currentUrl.current = url;
        setFrame({ url, receivedAt: new Date() });
        setStatus("ready");
      } catch {
        if (!stopped) {
          clearFrame();
          setStatus("unavailable");
        }
      } finally {
        window.clearTimeout(timeout);
        // Serial polling prevents overlapping requests when the camera is slow.
        if (!stopped) next = window.setTimeout(refresh, REFRESH_MS);
      }
    };

    void refresh();
    return () => {
      stopped = true;
      window.clearTimeout(next);
      window.clearTimeout(timeout);
      controller?.abort();
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null;
    };
  }, [endpoint, enabled]);

  const rejectImage = (url: string) => {
    if (currentUrl.current !== url) return;
    URL.revokeObjectURL(url);
    currentUrl.current = null;
    setFrame(null);
    setStatus("unavailable");
  };

  return (
    <figure className="camera-feed">
      <div className="camera-image">
        {frame ? (
          <img
            src={frame.url}
            alt={`${camera.label} camera snapshot`}
            onError={() => rejectImage(frame.url)}
          />
        ) : (
          <div className="camera-placeholder">
            <CameraIcon />
            <span>
              {status === "paused"
                ? "Camera paused"
                : status === "waiting"
                  ? "Waiting for a frame"
                  : "Frame unavailable"}
            </span>
            {status === "unavailable" && <small>Retrying automatically</small>}
          </div>
        )}
      </div>
      <figcaption className="camera-caption">
        <span>{camera.label}</span>
        <span className="camera-status">
          {frame
            ? `Received ${frame.receivedAt.toLocaleTimeString([], { hour12: false })}`
            : camera.vehicle_id}
        </span>
      </figcaption>
    </figure>
  );
}

function CameraEmpty({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="camera-empty" role="status">
      <CameraIcon />
      <strong>{title}</strong>
      <p>{description}</p>
      {children}
    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="5" width="12" height="14" rx="2" />
      <path d="m15 9 6-3v12l-6-3M7 9h4" />
    </svg>
  );
}
