type LoadingStage = 'opening' | 'assets' | 'scene';

const stages = [
  { id: 'opening', label: 'Open the strait' },
  { id: 'assets', label: 'Chart the coast' },
  { id: 'scene', label: 'Set the water in motion' },
] as const;

export default function LoadingScreen({ stage = 'opening', assetsLoaded = 0, error, onRetry }: {
  stage?: LoadingStage;
  assetsLoaded?: number;
  error?: string;
  onRetry?: () => void;
}) {
  const active = stages.findIndex(item => item.id === stage);
  const message = stage === 'opening' ? 'Opening the strait…' : stage === 'assets'
    ? (assetsLoaded === 0 ? 'Charting the coastline…' : 'Bringing the coast and boats together…')
    : 'Preparing the water…';

  return <div className={`loading-screen flow-loading ${error ? 'has-error' : ''}`} aria-busy={!error}>
    <svg className="loading-currents" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g className="current-bands" fill="none" strokeLinecap="round">
        <path d="M-300 810C140 860 125 265 610 360S1180 1120 1750 600" />
        <path d="M-300 695C155 750 175 180 660 280S1200 990 1750 475" />
        <path d="M-300 580C190 645 220 90 705 195S1250 855 1750 355" />
        <path d="M-300 465C230 530 270 10 750 105S1300 735 1750 235" />
        <path d="M-300 350C270 420 320-90 795 15S1350 620 1750 115" />
      </g>
      <g className="current-traces" fill="none" strokeLinecap="round">
        <path d="M-300 735C170 790 160 215 635 315S1200 1040 1750 530" />
        <path d="M-300 615C195 675 205 130 680 230S1230 920 1750 410" />
        <path d="M-300 495C245 565 250 45 735 140S1280 795 1750 290" />
      </g>
    </svg>
    <div className="loading-brand">can’t catch me<span>.</span></div>
    <div className="loading-vessel" aria-hidden="true">
      <svg viewBox="0 0 210 330" fill="none">
        <g className="loading-wake" stroke="#cadfe0" strokeLinecap="round">
          <path d="M79 141C76 203 51 246 24 305M131 141C134 203 159 246 186 305" />
          <path d="M89 155C91 208 75 273 67 326M121 155C119 208 135 273 143 326" />
          <path d="M104 176C99 209 111 242 104 282" />
        </g>
        <g className="loading-boat">
          <path d="M105 37C88 60 77 83 78 105L84 146C96 156 115 156 127 146L133 105C133 83 122 60 105 37Z" fill="#f6a04d" />
          <path d="m105 47-18 38h36L105 47Z" fill="#ffcf97" />
          <path d="M91 96h28v28H91z" fill="#edf4ee" />
          <path d="M95 99h20v8H95zM95 113h20v7H95z" fill="#183d4c" />
          <path d="M105 73v19" stroke="#edf4ee" strokeWidth="3" />
        </g>
      </svg>
    </div>
    <div className="loading-copy">
      <h1>{error ? 'The coast is out of reach.' : 'A little further downriver.'}</h1>
      <p role={error ? 'alert' : 'status'} aria-live="polite">{error || message}</p>
      {error && <button className="primary" onClick={onRetry}>Try loading again</button>}
    </div>
    {!error && <ol className="loading-stages" aria-label="Loading stages">
      {stages.map((item, index) => <li key={item.id} className={index < active ? 'complete' : index === active ? 'current' : ''} aria-current={index === active ? 'step' : undefined}>
        <span className="loading-stage-mark" aria-hidden="true">{index < active && <svg viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" /></svg>}</span>
        <span>{item.label}</span>
        <span className="sr-only">{index < active ? ', complete' : index === active ? ', in progress' : ', waiting'}</span>
      </li>)}
    </ol>}
  </div>;
}
