/** A live sensor warning that leaves the controls and route visible. */
export default function TowerWarning({ towers }: { towers: string[] }) {
  if (!towers.length) return null;
  return <aside className="tower-warning" role="alert" aria-atomic="true">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>
    </svg>
    <div><strong>{towers.length === 1 ? `Tower ${towers[0]} spotted you` : `Towers ${towers.join(' + ')} spotted you`}</strong><p>Drones accelerating. Find cover to break their view.</p></div>
  </aside>;
}
