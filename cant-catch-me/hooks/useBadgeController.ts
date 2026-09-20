import { useEffect, useRef, useState } from 'react';
import { BadgeSerialController } from '../lib/badgeSerial';
import { BadgeWifiController } from '../lib/badgeWifi';
import { emptyBadgeButtons, type BadgeButtons, type BadgeConnectionCallbacks, type BadgeStatus } from '../lib/badgeControllerTypes';

export function useBadgeController(onButtons: (buttons: BadgeButtons, connected: boolean) => void, onLost: () => void) {
  const [status, setStatus] = useState<BadgeStatus>('disconnected');
  const [message, setMessage] = useState('Choose how your badge connects.');
  const [buttons, setButtons] = useState(emptyBadgeButtons);
  const [serialSupported, setSerialSupported] = useState(false);
  const [mode, setMode] = useState<'wifi' | 'usb'>('wifi');
  const client = useRef<BadgeSerialController | BadgeWifiController | null>(null);
  const serialClient = useRef<BadgeSerialController | null>(null);
  const serialHandlers = useRef<BadgeConnectionCallbacks | null>(null);
  const callbacks = useRef({ onButtons, onLost });
  callbacks.current = { onButtons, onLost };
  const generation = useRef(0), live = useRef(false);

  useEffect(() => {
    setSerialSupported(window.isSecureContext && 'serial' in navigator);
    return () => { generation.current++; client.current?.disconnect(); client.current = null; };
  }, []);

  const disconnect = () => {
    generation.current++;
    client.current?.disconnect(); client.current = null;
    if (live.current) callbacks.current.onLost();
    live.current = false;
    const empty = emptyBadgeButtons(); setButtons(empty); callbacks.current.onButtons(empty, false);
    setStatus('disconnected'); setMessage('Badge disconnected. Keyboard and touch controls are ready.');
  };

  const start = (mode: 'wifi' | 'usb', id = '', key = '') => {
    disconnect();
    setMode(mode);
    const current = generation.current;
    const handlers: BadgeConnectionCallbacks = {
      onButtons(next, baseline) {
        if (current !== generation.current) return;
        setButtons(next); callbacks.current.onButtons(next, live.current && !baseline);
      },
      onStatus(next, detail) {
        if (current !== generation.current) return;
        if (live.current && next !== 'connected') callbacks.current.onLost();
        live.current = next === 'connected';
        setStatus(next); setMessage(detail);
      },
    };
    if (mode === 'usb') {
      serialHandlers.current = handlers;
      // Reuse this instance so a quick reconnect waits for the old USB port to close.
      const transport = serialClient.current ?? new BadgeSerialController({
        onButtons: (next, baseline) => serialHandlers.current?.onButtons(next, baseline),
        onStatus: (next, detail) => serialHandlers.current?.onStatus(next, detail),
      });
      serialClient.current = transport; client.current = transport;
      void transport.connect();
    } else {
      const transport = new BadgeWifiController(handlers); client.current = transport;
      transport.connect(id, key);
    }
  };

  return { status, message, buttons, serialSupported, mode, connect: start, disconnect };
}
