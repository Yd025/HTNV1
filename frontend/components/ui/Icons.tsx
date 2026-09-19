import type { ReactNode } from "react";
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 24 16 4l12 20H4Z" stroke="currentColor" strokeWidth="2.4" />
      <path
        d="m9 24 7-12 7 12M16 20v8M12 28h8"
        stroke="currentColor"
        strokeWidth="2"
      />
    </svg>
  );
}
export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    camera: (
      <>
        <rect x="3" y="5" width="12" height="14" rx="2" />
        <path d="m15 9 6-3v12l-6-3M7 9h4" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    layers: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    palette: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    arena: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />,
    coverage: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
        <path d="M8 8h8v8H8z" />
      </>
    ),
    fleet: (
      <>
        <path d="m12 3 4 7h-8l4-7ZM5 14l4 7H1l4-7Zm14 0 4 7h-8l4-7Z" />
        <path d="M12 11v4m-3 2 3-2 3 2" />
      </>
    ),
    route: (
      <>
        <circle cx="5" cy="18" r="2" />
        <circle cx="19" cy="6" r="2" />
        <path d="M7 18h7a4 4 0 0 0 0-8h-4a4 4 0 0 1 0-8h3" />
      </>
    ),
    target: (
      <>
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2" />
        <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
      </>
    ),
    signal: (
      <>
        <path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0m-9 4a4 4 0 0 1 6 0" />
        <circle cx="12" cy="20" r=".7" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    pulse: <path d="M2 12h5l3-8 4 16 3-8h5" />,
    plane: <path d="m12 2 2 7 7 4v2l-7-2v6l3 2h-10l3-2v-6l-7 2v-2l7-4 2-7Z" />,
    copter: (
      <>
        <rect x="9" y="9" width="6" height="6" rx="2" />
        <path d="m9 9-4-4m10 4 4-4m-4 10 4 4m-10-4-4 4M2 5h6m8 0h6M2 19h6m8 0h6" />
      </>
    ),
    rover: (
      <>
        <path d="M4 16V9h13l3 7H4Zm4-7V5h5v4" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
      </>
    ),
    tower: (
      <path d="m12 8-5 13m5-13 5 13M8 18h8m-7-4h6M9 4a4 4 0 0 0 0 6m6-6a4 4 0 0 1 0 6M6 2a7 7 0 0 0 0 10m12-10a7 7 0 0 1 0 10" />
    ),
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.arena}
    </svg>
  );
}
