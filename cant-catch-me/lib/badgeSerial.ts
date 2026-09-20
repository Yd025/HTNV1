import { emptyBadgeButtons, type BadgeButton, type BadgeButtons, type BadgeConnectionCallbacks } from './badgeControllerTypes';

// The existing boat_game.lua script writes these tokens with badge.sys.log.
// A full snapshot is optional: STATE: followed by seven 0/1 digits in
// up, down, left, right, start, a, b order. Legacy scripts need no changes.
export type BadgeSerialMessage =
  | { kind: 'hello' | 'heartbeat' | 'goodbye' }
  | { kind: 'button'; button: BadgeButton; pressed: boolean }
  | { kind: 'state'; buttons: BadgeButtons };

const BUTTON_ORDER: BadgeButton[] = ['up', 'down', 'left', 'right', 'start', 'a', 'b'];
const LEGACY_BUTTONS: Record<string, BadgeButton> = { W: 'up', S: 'down', A: 'left', D: 'right', START: 'start', CAMERA: 'a', LOOK: 'b' };
export const BADGE_SERIAL_BAUD_RATE = 115200;
export const BADGE_SERIAL_HEARTBEAT_TIMEOUT_MS = 4000;

export function parseBadgeSerialLine(line: string): BadgeSerialMessage | null {
  // ESP-IDF may prefix lines with timestamps/tags and ANSI colour sequences.
  const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const match = clean.match(/(?:^|[\s:\]])(HELLO_GAME|GOODBYE_GAME|HEARTBEAT|(?:W|S|A|D|START|CAMERA|LOOK)_(?:DOWN|UP)|STATE:[01]{7})$/);
  if (!match) return null;
  const token = match[1];
  if (token === 'HELLO_GAME') return { kind: 'hello' };
  if (token === 'GOODBYE_GAME') return { kind: 'goodbye' };
  if (token === 'HEARTBEAT') return { kind: 'heartbeat' };
  if (token.startsWith('STATE:')) {
    const buttons = emptyBadgeButtons();
    BUTTON_ORDER.forEach((button, index) => { buttons[button] = token[index + 6] === '1'; });
    return { kind: 'state', buttons };
  }
  const [key, edge] = token.split('_');
  return { kind: 'button', button: LEGACY_BUTTONS[key], pressed: edge === 'DOWN' };
}

/** USB reads can split anywhere; the official console also uses bare CR. */
export class BadgeSerialLineDecoder {
  private decoder = new TextDecoder();
  private pending = '';
  private discarding = false;

  push(bytes: Uint8Array): BadgeSerialMessage[] {
    const messages: BadgeSerialMessage[] = [];
    for (const character of this.decoder.decode(bytes, { stream: true })) {
      if (character === '\r' || character === '\n') {
        if (!this.discarding && this.pending) {
          const message = parseBadgeSerialLine(this.pending);
          if (message) messages.push(message);
        }
        this.pending = '';
        this.discarding = false;
      } else if (!this.discarding) {
        this.pending += character;
        if (this.pending.length > 8192) {
          this.pending = '';
          this.discarding = true;
        }
      }
    }
    return messages;
  }
}

// Local structural types avoid adding a Web Serial package to the game.
export interface BadgeSerialPort {
  readable: ReadableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export interface BadgeSerialApi {
  requestPort(): Promise<BadgeSerialPort>;
}

interface SerialSession {
  port: BadgeSerialPort;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  done: Promise<void>;
  timer: ReturnType<typeof setInterval> | null;
  lastMessage: number;
  live: boolean;
  startKnown: boolean;
  cameraKnown: boolean;
}

interface SerialOptions {
  serial?: BadgeSerialApi;
  heartbeatTimeoutMs?: number;
}

export class BadgeSerialController {
  private buttons = emptyBadgeButtons();
  private session: SerialSession | null = null;
  private generation = 0;
  private connecting = false;
  private opening: Promise<void> | null = null;
  private teardown: Promise<void> = Promise.resolve();

  constructor(private callbacks: BadgeConnectionCallbacks, private options: SerialOptions = {}) {}

  async connect(): Promise<void> {
    if (this.connecting || this.session) return;
    const serial = this.options.serial ?? (typeof navigator === 'undefined'
      ? undefined : (navigator as Navigator & { serial?: BadgeSerialApi }).serial);
    if (!serial) {
      this.callbacks.onStatus('error', 'USB badge control needs Chrome or Edge on a computer, using HTTPS or localhost.');
      return;
    }
    const generation = ++this.generation;
    this.connecting = true;
    this.callbacks.onStatus('connecting', 'Choose your badge in the USB device picker.');
    // Start the picker directly inside the click, before waiting for old cleanup.
    let selection: Promise<BadgeSerialPort>;
    try { selection = serial.requestPort(); } catch (error) { selection = Promise.reject(error); }
    const opening = this.openSelectedPort(selection, generation, this.teardown);
    this.opening = opening;
    await opening;
    if (this.opening === opening) this.opening = null;
    if (generation === this.generation) this.connecting = false;
  }

  clear(): void {
    this.buttons = emptyBadgeButtons();
    this.callbacks.onButtons({ ...this.buttons });
  }

  disconnect(): void {
    ++this.generation;
    this.connecting = false;
    const session = this.session;
    this.session = null;
    if (session) {
      if (session.timer !== null) clearInterval(session.timer);
      void session.reader.cancel().catch(() => {});
    }
    this.teardown = Promise.all([this.teardown, this.opening, session?.done]).then(() => {});
    this.clear();
    this.callbacks.onStatus('disconnected', 'USB badge disconnected.');
  }

  private async openSelectedPort(selection: Promise<BadgeSerialPort>, generation: number, teardown: Promise<void>): Promise<void> {
    let port: BadgeSerialPort | undefined;
    let opened = false;
    try {
      port = await selection;
      await teardown;
      if (generation !== this.generation) return;
      await port.open({ baudRate: BADGE_SERIAL_BAUD_RATE });
      opened = true;
      if (generation !== this.generation) {
        await port.close().catch(() => {});
        return;
      }
      if (!port.readable) throw new Error('No readable serial stream');
      const session: SerialSession = {
        port, reader: port.readable.getReader(), done: Promise.resolve(), timer: null,
        lastMessage: Date.now(), live: false, startKnown: false, cameraKnown: false,
      };
      this.session = session;
      this.clear();
      this.callbacks.onStatus('waiting', 'USB connected. Open Game Controller on your badge and press a button.');
      const timeout = this.options.heartbeatTimeoutMs ?? BADGE_SERIAL_HEARTBEAT_TIMEOUT_MS;
      session.timer = setInterval(() => {
        if (this.session !== session || !session.live || Date.now() - session.lastMessage < timeout) return;
        session.live = false;
        session.startKnown = false;
        session.cameraKnown = false;
        this.clear();
        this.callbacks.onStatus('waiting', 'Badge signal paused. Open Game Controller on the badge to reconnect.');
      }, Math.min(500, timeout));
      session.done = this.read(session, generation);
    } catch (error) {
      if (opened && port) await port.close().catch(() => {});
      if (generation !== this.generation) return;
      this.clear();
      const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
      if (name === 'NotFoundError' || name === 'AbortError') {
        this.callbacks.onStatus('disconnected', 'USB connection cancelled.');
      } else {
        this.callbacks.onStatus('error', 'Could not open the badge. Close other badge tabs or serial monitors, then reconnect USB.');
      }
    }
  }

  private async read(session: SerialSession, generation: number): Promise<void> {
    const decoder = new BadgeSerialLineDecoder();
    try {
      while (this.session === session && generation === this.generation) {
        const { value, done } = await session.reader.read();
        if (done || this.session !== session || generation !== this.generation) break;
        if (!value) continue;
        for (const message of decoder.push(value)) {
          if (this.session !== session || generation !== this.generation) break;
          session.lastMessage = Date.now();
          if (message.kind === 'goodbye' || message.kind === 'hello') {
            session.live = false;
            session.startKnown = false;
            session.cameraKnown = false;
            this.clear();
            this.callbacks.onStatus('waiting', message.kind === 'goodbye'
              ? 'Controller closed. Open Game Controller on your badge to reconnect.'
              : 'Controller opened. Waiting for button state; press and release a button if needed.');
            continue;
          }
          // A greeting/heartbeat cannot tell us whether Start is already held.
          // Deliver the first real state while consumers still consider the
          // connection waiting, then enable actions. This also applies after
          // a heartbeat timeout so reconnection never generates a Start press.
          if (message.kind === 'heartbeat') continue;
          if (message.kind === 'button') {
            // Legacy scripts send independent edges: an earlier steering event
            // says nothing about whether Start/Camera was already held. Their
            // first explicit edge establishes state, even when already live.
            const baseline = !session.live
              || (message.button === 'start' && !session.startKnown)
              || (message.button === 'a' && !session.cameraKnown);
            if (message.button === 'start') session.startKnown = true;
            if (message.button === 'a') session.cameraKnown = true;
            this.buttons = { ...this.buttons, [message.button]: message.pressed };
            this.callbacks.onButtons({ ...this.buttons }, baseline);
          }
          if (message.kind === 'state') {
            const baseline = !session.live || !session.startKnown || !session.cameraKnown;
            session.startKnown = true;
            session.cameraKnown = true;
            this.buttons = message.buttons;
            this.callbacks.onButtons({ ...this.buttons }, baseline);
          }
          if (!session.live && this.session === session && generation === this.generation) {
            session.live = true;
            this.callbacks.onStatus('connected', 'Badge live. Use the D-pad to steer and Start to play or pause.');
          }
        }
      }
    } catch {
      // An unplugged badge rejects read(). Both errors and EOF release buttons.
    } finally {
      if (session.timer !== null) clearInterval(session.timer);
      if (this.session === session && generation === this.generation) {
        this.session = null;
        this.teardown = session.done;
        this.clear();
        this.callbacks.onStatus('disconnected', 'Badge connection ended. Reconnect USB to continue.');
      }
      session.reader.releaseLock();
      await session.port.close().catch(() => {});
    }
  }
}
