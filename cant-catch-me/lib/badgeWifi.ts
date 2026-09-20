import {
  BadgeButton, BadgeButtons, BadgeConnectionCallbacks, emptyBadgeButtons,
} from './badgeControllerTypes';

// HTN OS contract: https://solana-htn.com/badge/docs
const BADGE_SERVICE = 'wss://badge.solana-htn.com';
const POLL_MS = 1500;
const STARTUP_TIMEOUT_MS = 10000;
const STALE_TIMEOUT_MS = 6000;
const BUTTON_NAMES = Object.keys(emptyBadgeButtons()) as BadgeButton[];

export type BadgeSocket = Pick<WebSocket,
  'readyState' | 'onopen' | 'onmessage' | 'onerror' | 'onclose' | 'send' | 'close'>;

export interface BadgeWifiDependencies {
  createSocket?: (url: string) => BadgeSocket;
  now?: () => number;
  setInterval?: (callback: () => void, milliseconds: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

type PendingCommand = {
  command: 'text' | 'buttons' | 'info';
  revisions: Record<BadgeButton, number>;
  sequence: number;
  sentAt: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ERROR_MESSAGES: Record<string, string> = {
  bad_key: 'Wrong app key. Check the key in your badge settings.',
  key_not_set: 'Set an app key on your badge before connecting.',
  badge_not_found: 'No badge has this HTN-ID. Check the five characters on its screen.',
  badge_offline: 'Badge went offline. Check its Wi-Fi and reconnect.',
  badge_timeout: 'The badge did not respond. Check its Wi-Fi and reconnect.',
  rate_limited: 'The badge service is busy. Wait a moment and reconnect.',
};

export class BadgeWifiController {
  private readonly createSocket: (url: string) => BadgeSocket;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, milliseconds: number) => unknown;
  private readonly unschedule: (handle: unknown) => void;
  private socket: BadgeSocket | null = null;
  private timer: unknown = null;
  private badgeId = '';
  private buttons = emptyBadgeButtons();
  private revisions = Object.fromEntries(BUTTON_NAMES.map(name => [name, 0])) as Record<BadgeButton, number>;
  private pending = new Map<string, PendingCommand>();
  private sequence = 0;
  private snapshotSequence = 0;
  private startedAt = 0;
  private lastBadgeAt = 0;
  private canvas = false;
  private snapshotReceived = false;
  private infoReceived = false;
  private connected = false;

  constructor(private readonly callbacks: BadgeConnectionCallbacks, dependencies: BadgeWifiDependencies = {}) {
    this.createSocket = dependencies.createSocket ?? (url => new WebSocket(url));
    this.now = dependencies.now ?? Date.now;
    this.schedule = dependencies.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    this.unschedule = dependencies.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  connect(id: string, key: string): void {
    this.cleanup();
    this.badgeId = id.trim().toLowerCase();
    if (!/^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/.test(this.badgeId)) {
      this.callbacks.onStatus('error', 'Enter the five-character HTN-ID shown on your badge.');
      return;
    }
    if (!/^[\x20-\x7e]{4,32}$/.test(key)) {
      this.callbacks.onStatus('error', 'Enter your badge app key (4–32 printable characters).');
      return;
    }

    this.startedAt = this.now();
    this.lastBadgeAt = this.startedAt;
    this.callbacks.onStatus('connecting', 'Connecting to your badge over Wi-Fi…');
    let socket: BadgeSocket;
    try {
      socket = this.createSocket(`${BADGE_SERVICE}/v1/badges/${this.badgeId}/ws?key=${encodeURIComponent(key)}`);
    } catch {
      this.fail('Could not open the badge connection. Check your network and reconnect.');
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.callbacks.onStatus('waiting', 'Connected to the service. Preparing the badge…');
      // A screen command enters canvas mode, which enables physical button events.
      this.send('text', {
        text: 'CANT CATCH ME\n\nUP: accelerate\nLEFT / RIGHT: steer\nDOWN: brake\nA: camera  B: look back\nSTART: launch / pause',
        x: 8, y: 12, size: 2, clear: true, color: '#14f195', background: '#000000',
      });
    };
    socket.onmessage = event => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      this.receive(event.data);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.fail('Badge connection interrupted. Check its Wi-Fi and reconnect.');
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.fail(event.code === 4403 ? ERROR_MESSAGES.bad_key
        : event.code === 4404 ? ERROR_MESSAGES.badge_not_found
        : 'Badge connection closed. Check its Wi-Fi and reconnect.');
    };
    this.timer = this.schedule(() => this.poll(), POLL_MS);
  }

  disconnect(): void {
    if (this.canvas && this.socket?.readyState === 1) {
      try { this.socket.send(JSON.stringify({ cmd: 'home' })); } catch { /* Connection already lost. */ }
    }
    this.cleanup();
    this.callbacks.onStatus('disconnected', 'Badge disconnected. Keyboard controls are available.');
  }

  private send(command: PendingCommand['command'], body: Record<string, unknown> = {}): void {
    if (this.socket?.readyState !== 1) return;
    const id = `game-${++this.sequence}`;
    this.pending.set(id, { command, revisions: { ...this.revisions }, sequence: this.sequence, sentAt: this.now() });
    try {
      this.socket.send(JSON.stringify({ cmd: command, id, ...body }));
    } catch {
      this.fail('Could not reach the badge. Check its Wi-Fi and reconnect.');
    }
  }

  private poll(): void {
    if (!this.socket) return;
    const elapsed = this.now() - (this.connected ? this.lastBadgeAt : this.startedAt);
    if (elapsed >= (this.connected ? STALE_TIMEOUT_MS : STARTUP_TIMEOUT_MS)) {
      this.fail('The badge stopped responding. Controls released; reconnect to continue.');
      return;
    }
    if (this.canvas) {
      for (const [id, pending] of this.pending) {
        if (this.now() - pending.sentAt >= STALE_TIMEOUT_MS) this.pending.delete(id);
      }
      this.send('buttons');
      this.send('info');
    }
  }

  private receive(text: string): void {
    let message: unknown;
    try { message = JSON.parse(text); } catch { return; }
    if (!record(message)) return;
    if (message.type === 'error') {
      this.fail(typeof message.error === 'string' && ERROR_MESSAGES[message.error]
        || 'The badge service rejected the connection. Check the badge and reconnect.');
      return;
    }
    if (message.type === 'event' && record(message.data)) {
      const event = message.data;
      if (event.badgeId !== this.badgeId) return;
      if (event.event === 'offline') {
        this.fail(ERROR_MESSAGES.badge_offline);
      } else if (event.event === 'mode' && event.mode === 'menu' && this.canvas) {
        this.fail('Badge returned to its menu. Reconnect to use it as a controller.');
      } else if (event.event === 'button' && typeof event.button === 'string'
        && BUTTON_NAMES.includes(event.button as BadgeButton) && typeof event.pressed === 'boolean') {
        const button = event.button as BadgeButton;
        this.lastBadgeAt = this.now();
        this.revisions[button] += 1;
        this.buttons[button] = event.pressed;
        if (this.connected) this.callbacks.onButtons({ ...this.buttons });
      }
      return;
    }
    if (message.type !== 'reply' || typeof message.id !== 'string' || !record(message.data)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const data = message.data;
    if (pending.command === 'text' && data.ok === true) {
      this.canvas = true;
      this.lastBadgeAt = this.now();
      this.send('buttons');
      this.send('info');
    } else if (pending.command === 'buttons' && record(data.buttons)
      && BUTTON_NAMES.every(button => typeof (data.buttons as Record<string, unknown>)[button] === 'boolean')) {
      if (pending.sequence <= this.snapshotSequence) return;
      this.snapshotSequence = pending.sequence;
      this.lastBadgeAt = this.now();
      for (const button of BUTTON_NAMES) {
        // A delayed snapshot must not overwrite a newer press/release event.
        if (this.revisions[button] === pending.revisions[button]) {
          this.buttons[button] = data.buttons[button] as boolean;
        }
      }
      this.snapshotReceived = true;
      if (this.connected) this.callbacks.onButtons({ ...this.buttons });
    } else if (pending.command === 'info' && data.mode === 'canvas') {
      this.infoReceived = true;
    } else if (pending.command === 'info' && data.mode === 'menu') {
      this.fail('Badge is in its menu. Reconnect to activate the controller.');
      return;
    }
    if (!this.connected && this.canvas && this.snapshotReceived && this.infoReceived) {
      this.connected = true;
      // Seed held buttons before enabling actions, so reconnecting with START down
      // cannot accidentally launch or pause the game.
      this.callbacks.onButtons({ ...this.buttons });
      this.callbacks.onStatus('connected', 'Badge connected over Wi-Fi. Press a button to test it.');
    }
  }

  private clearButtons(): void {
    this.buttons = emptyBadgeButtons();
    this.callbacks.onButtons({ ...this.buttons });
  }

  private fail(message: string): void {
    this.cleanup();
    this.callbacks.onStatus('error', message);
  }

  private cleanup(): void {
    const socket = this.socket;
    this.socket = null;
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* Already closed. */ }
    }
    this.pending.clear();
    this.canvas = false;
    this.connected = false;
    this.snapshotReceived = false;
    this.snapshotSequence = 0;
    this.infoReceived = false;
    this.revisions = Object.fromEntries(BUTTON_NAMES.map(name => [name, 0])) as Record<BadgeButton, number>;
    this.clearButtons();
  }
}
