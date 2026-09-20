import { useState } from 'react';
import type { useBadgeController } from '../hooks/useBadgeController';
import type { BadgeButton } from '../lib/badgeControllerTypes';

type Props = { controller: ReturnType<typeof useBadgeController> };
const labels: { button: BadgeButton; label: string; action: string }[] = [
  { button: 'up', label: 'Up', action: 'Accelerate' },
  { button: 'down', label: 'Down', action: 'Brake' },
  { button: 'left', label: 'Left', action: 'Steer left' },
  { button: 'right', label: 'Right', action: 'Steer right' },
  { button: 'start', label: 'Start', action: 'Play / pause' },
  { button: 'a', label: 'A', action: 'Camera' },
  { button: 'b', label: 'B', action: 'Look back' },
];

export default function BadgePanel({ controller }: Props) {
  const [mode, setMode] = useState<'wifi' | 'usb'>(controller.mode);
  const [id, setId] = useState(''), [key, setKey] = useState('');
  const busy = controller.status === 'connecting' || controller.status === 'waiting' || controller.status === 'connected';
  return <div className="badge-panel" id="badge-panel">
    <p className="badge-intro">Your badge is the helm. Connect it, then press a button to check the signal.</p>
    <fieldset className="badge-modes" disabled={busy}>
      <legend className="sr-only">Badge connection</legend>
      <label><input type="radio" name="badge-mode" checked={mode === 'wifi'} onChange={() => setMode('wifi')}/>HTN OS · Wi-Fi</label>
      <label><input type="radio" name="badge-mode" checked={mode === 'usb'} onChange={() => setMode('usb')}/>Lua script · USB</label>
    </fieldset>
    {mode === 'wifi' ? <form className="badge-form" onSubmit={event => { event.preventDefault(); controller.connect('wifi', id, key); }}>
      {!busy && <>
      <p>Use the HTN-ID on your badge’s home screen and the app key from Settings → App key.</p>
      <div className="badge-fields">
        <label>HTN-ID<input name="badge-id" value={id} onChange={e => setId(e.target.value.toLowerCase())} placeholder="5 characters" maxLength={5} minLength={5} pattern="[23456789abcdefghjkmnpqrstuvwxyz]{5}" autoCapitalize="none" autoCorrect="off" spellCheck={false} required disabled={busy}/></label>
        <label>App key<input name="badge-key" type="password" value={key} onChange={e => setKey(e.target.value)} minLength={4} maxLength={32} autoComplete="off" required disabled={busy}/></label>
      </div>
      <p className="badge-note">Your key stays in this tab and goes only to the badge service. Connecting shows the game controls on your badge.</p>
      <button className="primary badge-connect" type="submit">Connect badge</button>
      </>}
      <a href="https://solana-htn.com/badge" target="_blank" rel="noreferrer">Open HTN OS setup<span className="sr-only"> (new tab)</span></a>
    </form> : <div className="badge-usb">
      <ol><li>Plug the badge into your computer with a USB data cable.</li><li>Run <strong>Game Controller</strong> on the badge.</li><li>Disconnect the badge editor’s serial monitor, then connect here.</li></ol>
      {!controller.serialSupported && <p className="badge-note">USB needs desktop Chrome or Edge on HTTPS or localhost. You can still use Wi-Fi here.</p>}
      {!busy && <button className="primary badge-connect" disabled={!controller.serialSupported} onClick={() => controller.connect('usb')}>Choose USB badge</button>}
      <div className="badge-links"><a href="/badge/boat_game.lua" download>Download controller script</a><a href="https://badge.hackthenorth.com" target="_blank" rel="noreferrer">Open badge editor<span className="sr-only"> (new tab)</span></a></div>
      <p className="badge-note">Your original script supports Up, Left, Right and Start. The download also adds Down to brake, A for camera and B to look back. USB uses the original badge firmware; HTN OS replaces it.</p>
    </div>}
    <div className={`badge-status is-${controller.status}`} role="status"><span className="status-light"/><span>{controller.message}</span></div>
    {busy && <button className="text-button badge-disconnect" onClick={controller.disconnect}>{controller.status === 'connected' ? 'Disconnect badge' : 'Cancel connection'}</button>}
    <div className="badge-button-test" aria-label="Live badge button check">
      {labels.map(({ button, label, action }) => <div key={button} className={controller.buttons[button] ? 'pressed' : ''}><span>{label}<span className="sr-only">{controller.buttons[button] ? ' pressed' : ' released'}</span></span><small>{action}</small></div>)}
    </div>
    <p className="badge-note">Start begins or pauses a run. Keyboard and touch still work. If the badge drops out, the game pauses.</p>
  </div>;
}
