import test from 'node:test';
import assert from 'node:assert/strict';
import { BadgeWifiController, type BadgeSocket } from '../lib/badgeWifi';
import { emptyBadgeButtons, type BadgeButtons, type BadgeStatus } from '../lib/badgeControllerTypes';

class FakeSocket implements BadgeSocket {
  readyState = 0;
  onopen: WebSocket['onopen'] = null;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  messages: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.messages.push(JSON.parse(String(data)));
  }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
  }
  receive(data: unknown): void {
    this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(data) } as MessageEvent);
  }
  reply(command: string, data: unknown): void {
    const sent = this.messages.filter(message => message.cmd === command).at(-1);
    assert.ok(sent, `Expected a ${command} command`);
    this.receive({ type: 'reply', id: sent.id, data });
  }
  event(event: string, data: Record<string, unknown> = {}): void {
    this.receive({ type: 'event', data: { event, badgeId: 'xb2b9', ...data } });
  }
  end(code: number): void {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const statuses: { status: BadgeStatus; message: string }[] = [];
  const buttons: BadgeButtons[] = [];
  const notifications: string[] = [];
  let now = 0;
  let timer: (() => void) | null = null;
  const controller = new BadgeWifiController({
    onButtons: value => { buttons.push(value); notifications.push('buttons'); },
    onStatus: (status, message) => { statuses.push({ status, message }); notifications.push(status); },
  }, {
    createSocket: url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    now: () => now,
    setInterval: callback => { timer = callback; return 1; },
    clearInterval: () => { timer = null; },
  });
  return {
    controller, sockets, statuses, buttons, notifications,
    advance: (ms: number) => { now += ms; timer?.(); },
    hasTimer: () => timer !== null,
    connect: () => {
      controller.connect('XB2B9', 'test&key');
      const socket = sockets.at(-1)!;
      socket.open();
      socket.reply('text', { ok: true });
      socket.reply('buttons', { buttons: emptyBadgeButtons() });
      socket.reply('info', { mode: 'canvas' });
      return socket;
    },
  };
}

test('Wi-Fi activates canvas then confirms physical badge state before reporting connected', () => {
  const h = harness();
  h.controller.connect(' XB2B9 ', 'test&key');
  const socket = h.sockets[0];
  assert.equal(socket.url, 'wss://badge.solana-htn.com/v1/badges/xb2b9/ws?key=test%26key');
  socket.open();
  assert.equal(h.statuses.at(-1)?.status, 'waiting');
  assert.deepEqual(socket.messages.map(message => message.cmd), ['text']);
  assert.equal(socket.messages[0].clear, true);
  socket.reply('text', { ok: true });
  assert.deepEqual(socket.messages.map(message => message.cmd), ['text', 'buttons', 'info']);
  socket.reply('buttons', { buttons: { ...emptyBadgeButtons(), up: true } });
  assert.equal(h.statuses.at(-1)?.status, 'waiting');
  socket.reply('info', { mode: 'canvas' });
  assert.equal(h.statuses.at(-1)?.status, 'connected');
  assert.equal(h.buttons.at(-1)?.up, true);
  assert.deepEqual(h.notifications.slice(-2), ['buttons', 'connected']);
});

test('Wi-Fi maps live buttons and polling recovers a missing release without overriding newer events', () => {
  const h = harness();
  const socket = h.connect();
  socket.event('button', { button: 'up', pressed: true });
  socket.event('button', { button: 'left', pressed: true });
  assert.equal(h.buttons.at(-1)?.up, true);
  assert.equal(h.buttons.at(-1)?.left, true);
  h.advance(1500);
  socket.event('button', { button: 'left', pressed: false });
  socket.reply('buttons', { buttons: { ...emptyBadgeButtons(), left: true } });
  assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
  socket.event('button', { badgeId: 'wrong', button: 'right', pressed: true });
  socket.event('button', { button: 'right', pressed: 'true' });
  socket.event('button', { button: '__proto__', pressed: true });
  assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
});

test('an older button poll response cannot undo a newer snapshot', () => {
  const h = harness();
  const socket = h.connect();
  h.advance(1500);
  const older = socket.messages.filter(message => message.cmd === 'buttons').at(-1)!;
  h.advance(1500);
  socket.reply('buttons', { buttons: { ...emptyBadgeButtons(), right: true } });
  socket.receive({ type: 'reply', id: older.id, data: { buttons: emptyBadgeButtons() } });
  assert.equal(h.buttons.at(-1)?.right, true);
});

test('expired replies are discarded while regular button snapshots keep the badge connected', () => {
  const h = harness();
  const socket = h.connect();
  h.advance(1500);
  const oldInfo = socket.messages.filter(message => message.cmd === 'info').at(-1)!;
  for (let i = 0; i < 5; i++) {
    socket.reply('buttons', { buttons: emptyBadgeButtons() });
    h.advance(1500);
  }
  socket.receive({ type: 'reply', id: oldInfo.id, data: { mode: 'menu' } });
  assert.equal(h.statuses.at(-1)?.status, 'connected', 'A timed-out stale command cannot override current state');
  socket.reply('info', { mode: 'canvas' });
  assert.equal(h.statuses.at(-1)?.status, 'connected');
});

test('socket errors immediately release buttons and suppress further inputs until reconnect', () => {
  const h = harness();
  const socket = h.connect();
  socket.event('button', { button: 'up', pressed: true });
  socket.onerror?.call(socket as unknown as WebSocket, {} as Event);
  socket.event('button', { button: 'right', pressed: true });
  assert.equal(h.statuses.at(-1)?.status, 'error');
  assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
  assert.equal(socket.closed, true);
  assert.equal(h.hasTimer(), false);
});

test('Wi-Fi releases held controls and stops on offline or menu events', () => {
  for (const event of ['offline', 'mode']) {
    const h = harness();
    const socket = h.connect();
    socket.event('button', { button: 'up', pressed: true });
    socket.event(event, { mode: 'menu' });
    assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
    assert.equal(h.statuses.at(-1)?.status, 'error');
    assert.equal(socket.closed, true);
    assert.equal(h.hasTimer(), false);
    h.advance(30000);
    assert.equal(h.sockets.length, 1, 'Reconnect is a deliberate user action');
  }
});

test('Wi-Fi startup and missing button updates time out even when the service sends ping/info', () => {
  const h = harness();
  h.controller.connect('xb2b9', 'test');
  h.sockets[0].open();
  h.advance(10500);
  assert.equal(h.statuses.at(-1)?.status, 'error');
  assert.equal(h.sockets[0].closed, true);

  const socket = h.connect();
  socket.event('button', { button: 'up', pressed: true });
  h.advance(4500);
  socket.reply('info', { mode: 'canvas' });
  socket.event('ping');
  h.advance(1500);
  assert.equal(h.statuses.at(-1)?.status, 'error');
  assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
});

test('Wi-Fi explains authentication failures and rejects invalid credentials before opening a socket', () => {
  const h = harness();
  for (const [id, key] of [['abc01', 'test'], ['xb2b9', 'abc'], ['xb2b9', 'bad\nkey']]) {
    h.controller.connect(id, key);
    assert.equal(h.statuses.at(-1)?.status, 'error');
  }
  assert.equal(h.sockets.length, 0);
  h.controller.connect('xb2b9', 'test');
  h.sockets[0].end(4403);
  assert.match(h.statuses.at(-1)!.message, /Wrong app key/);
  h.controller.connect('xb2b9', 'test');
  h.sockets[1].end(4404);
  assert.match(h.statuses.at(-1)!.message, /No badge/);
  const socket = h.connect();
  socket.receive({ type: 'error', error: 'badge_offline' });
  assert.match(h.statuses.at(-1)!.message, /offline/);
});

test('disconnect returns the badge home, clears timers/handlers and ignores the replaced connection', () => {
  const h = harness();
  const first = h.connect();
  const staleMessage = first.onmessage;
  h.controller.connect('xb2b9', 'new-key');
  assert.equal(first.closed, true);
  assert.equal(first.onmessage, null);
  staleMessage?.call(first as unknown as WebSocket, {
    data: JSON.stringify({ type: 'event', data: { event: 'offline', badgeId: 'xb2b9' } }),
  } as MessageEvent);
  assert.equal(h.statuses.at(-1)?.status, 'connecting');
  const socket = h.connect();
  h.controller.disconnect();
  assert.equal(socket.messages.at(-1)?.cmd, 'home');
  assert.equal(socket.closed, true);
  assert.equal(h.hasTimer(), false);
  assert.equal(h.statuses.at(-1)?.status, 'disconnected');
  assert.deepEqual(h.buttons.at(-1), emptyBadgeButtons());
});
