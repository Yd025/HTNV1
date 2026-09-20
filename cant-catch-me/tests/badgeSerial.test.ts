import test from 'node:test';
import assert from 'node:assert/strict';
import { BadgeSerialController, BadgeSerialLineDecoder, BADGE_SERIAL_BAUD_RATE, parseBadgeSerialLine, type BadgeSerialPort } from '../lib/badgeSerial';
import { emptyBadgeButtons, type BadgeButtons, type BadgeStatus } from '../lib/badgeControllerTypes';
import { BadgeInput } from '../lib/badgeInput';

const encoder = new TextEncoder();
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fakePort() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let openedAt: number | undefined;
  let closes = 0;
  const port: BadgeSerialPort = {
    readable: new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
    async open(options) { openedAt = options.baudRate; },
    async close() { closes += 1; },
  };
  return {
    port, send: (text: string) => stream.enqueue(encoder.encode(text)),
    eof: () => stream.close(), unplug: () => stream.error(new Error('Device disconnected')),
    get openedAt() { return openedAt; }, get closes() { return closes; },
  };
}

function callbacks() {
  const buttons: BadgeButtons[] = [];
  const statuses: BadgeStatus[] = [];
  return { buttons, statuses, onButtons: (value: BadgeButtons) => { buttons.push(value); }, onStatus: (status: BadgeStatus) => { statuses.push(status); } };
}

test('parses original Lua events, ESP-IDF log prefixes, and optional full snapshots', () => {
  assert.deepEqual(parseBadgeSerialLine('HELLO_GAME'), { kind: 'hello' });
  assert.deepEqual(parseBadgeSerialLine('I (800) lua: GOODBYE_GAME'), { kind: 'goodbye' });
  assert.deepEqual(parseBadgeSerialLine('I (700) lua: HEARTBEAT'), { kind: 'heartbeat' });
  for (const [key, button] of Object.entries({ W: 'up', S: 'down', A: 'left', D: 'right', START: 'start', CAMERA: 'a', LOOK: 'b' })) {
    for (const edge of ['DOWN', 'UP']) {
      assert.deepEqual(parseBadgeSerialLine(`\x1b[0;32mI (901) lua: ${key}_${edge}\x1b[0m`), { kind: 'button', button, pressed: edge === 'DOWN' });
    }
  }
  assert.deepEqual(parseBadgeSerialLine('[lua] STATE:1010101'), {
    kind: 'state', buttons: { up: true, down: false, left: true, right: false, start: true, a: false, b: true },
  });
  for (const unrelated of ['boot successful', 'NOT_W_DOWN', 'W_DOWN junk', 'STATE:101', 'STATE:10101010', 'W_DOWN_UP']) {
    assert.equal(parseBadgeSerialLine(unrelated), null);
  }
});

test('USB chunks split across tokens and bare CR, LF, or CRLF preserve every edge', () => {
  const decoder = new BadgeSerialLineDecoder();
  assert.deepEqual(decoder.push(encoder.encode('I (5) lua: HELLO_GA')), []);
  assert.deepEqual(decoder.push(encoder.encode('ME\rW_DO')), [{ kind: 'hello' }]);
  assert.deepEqual(decoder.push(encoder.encode('WN\r\nA_DOWN\nD_DOWN\rSTART_DOWN\rW_')), [
    { kind: 'button', button: 'up', pressed: true }, { kind: 'button', button: 'left', pressed: true },
    { kind: 'button', button: 'right', pressed: true }, { kind: 'button', button: 'start', pressed: true },
  ]);
  assert.deepEqual(decoder.push(encoder.encode('UP\r')), [{ kind: 'button', button: 'up', pressed: false }]);
});

test('oversized or unrelated log output cannot create input or grow an unbounded partial line', () => {
  const decoder = new BadgeSerialLineDecoder();
  assert.deepEqual(decoder.push(encoder.encode('x'.repeat(9000))), []);
  assert.deepEqual(decoder.push(encoder.encode(' W_DOWN\rboot successful\rHEARTBEAT\r')), [{ kind: 'heartbeat' }]);
});

test('connect waits for controller traffic, preserves simultaneous buttons, and releases on disconnect', async (t) => {
  const device = fakePort();
  const observed = callbacks();
  const controller = new BadgeSerialController(observed, { serial: { async requestPort() { return device.port; } } });
  t.after(() => controller.disconnect());
  await controller.connect();
  assert.equal(device.openedAt, BADGE_SERIAL_BAUD_RATE);
  assert.equal(observed.statuses.at(-1), 'waiting');
  device.send('unrelated system log\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'waiting');
  device.send('HELLO_GAME\rW_DOWN\rA_DOWN\rSTART_DOWN\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'connected');
  assert.deepEqual(observed.buttons.at(-1), { ...emptyBadgeButtons(), up: true, left: true, start: true });
  device.send('W_UP\r');
  await settle();
  assert.deepEqual(observed.buttons.at(-1), { ...emptyBadgeButtons(), left: true, start: true });
  controller.disconnect();
  await settle();
  assert.deepEqual(observed.buttons.at(-1), emptyBadgeButtons());
  assert.equal(observed.statuses.at(-1), 'disconnected');
  assert.equal(device.closes, 1);
});

test('heartbeat silence releases held buttons and valid traffic restores connection', async (t) => {
  const device = fakePort();
  const observed = callbacks();
  let reportSilence!: () => void;
  const silence = new Promise<void>((resolve) => { reportSilence = resolve; });
  const controller = new BadgeSerialController({
    onButtons: observed.onButtons,
    onStatus(status, message) {
      observed.onStatus(status);
      if (status === 'waiting' && message.includes('paused')) reportSilence();
    },
  }, { serial: { async requestPort() { return device.port; } }, heartbeatTimeoutMs: 20 });
  t.after(() => controller.disconnect());
  await controller.connect();
  device.send('W_DOWN\r');
  await settle();
  assert.equal(observed.buttons.at(-1)?.up, true);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([silence, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('No heartbeat timeout')), 1000); })]);
  } finally { clearTimeout(deadline); }
  assert.deepEqual(observed.buttons.at(-1), emptyBadgeButtons());
  assert.equal(observed.statuses.at(-1), 'waiting');
  device.send('HEARTBEAT\rD_DOWN\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'connected');
  assert.deepEqual(observed.buttons.at(-1), { ...emptyBadgeButtons(), right: true });
});

test('initial and recovered snapshots establish held Start/Camera before becoming live', async (t) => {
  const device = fakePort();
  const input = new BadgeInput();
  const actions: string[] = [];
  const deliveries: Array<{ start: boolean; live: boolean }> = [];
  let live = false;
  let reportSilence!: () => void;
  const silence = new Promise<void>((resolve) => { reportSilence = resolve; });
  const controller = new BadgeSerialController({
    onButtons(buttons, baseline) {
      deliveries.push({ start: buttons.start, live });
      const nextActions = input.update(buttons);
      if (live && !baseline && nextActions.start) actions.push('start');
      if (live && !baseline && nextActions.camera) actions.push('camera');
    },
    onStatus(status, message) {
      if (live && status !== 'connected') input.reset();
      live = status === 'connected';
      if (status === 'waiting' && message.includes('paused')) reportSilence();
    },
  }, { serial: { async requestPort() { return device.port; } }, heartbeatTimeoutMs: 20 });
  t.after(() => controller.disconnect());
  await controller.connect();
  device.send('HELLO_GAME\rHEARTBEAT\r');
  await settle();
  assert.equal(live, false, 'greetings cannot establish whether Start was already held');
  device.send('STATE:0000110\rSTATE:0000110\r');
  await settle();
  assert.equal(live, true);
  assert.deepEqual(actions, [], 'held buttons at connect and repeated snapshots never trigger actions');
  assert.deepEqual(deliveries.filter((delivery) => delivery.start).slice(0, 2), [
    { start: true, live: false }, { start: true, live: true },
  ]);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([silence, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('No heartbeat timeout')), 1000); })]);
  } finally { clearTimeout(deadline); }
  assert.equal(live, false);
  device.send('HEARTBEAT\r');
  await settle();
  assert.equal(live, false, 'recovery also waits for an actual button baseline');
  device.send('STATE:0000110\rSTATE:0000110\r');
  await settle();
  assert.equal(live, true);
  assert.deepEqual(actions, [], 'held Start does not resume automatically after a signal timeout');
  device.send('START_UP\rCAMERA_UP\rSTART_DOWN\rCAMERA_DOWN\rSTATE:0000110\r');
  await settle();
  assert.deepEqual(actions, ['start', 'camera']);
});

test('legacy steering before held Start/Camera establishes each action baseline independently', async (t) => {
  const device = fakePort();
  const input = new BadgeInput();
  const actions: string[] = [];
  let live = false;
  const controller = new BadgeSerialController({
    onButtons(buttons, baseline) {
      const nextActions = input.update(buttons);
      if (live && !baseline && nextActions.start) actions.push('start');
      if (live && !baseline && nextActions.camera) actions.push('camera');
    },
    onStatus(status) {
      if (live && status !== 'connected') input.reset();
      live = status === 'connected';
    },
  }, { serial: { async requestPort() { return device.port; } } });
  t.after(() => controller.disconnect());
  await controller.connect();
  device.send('HELLO_GAME\rW_DOWN\rA_DOWN\r');
  await settle();
  assert.equal(live, true);
  device.send('START_DOWN\rCAMERA_DOWN\r');
  await settle();
  assert.deepEqual(actions, [], 'an inferred released Start/Camera from steering is not an explicit action baseline');
  assert.equal(input.buttons.start, true, 'the real held state still reaches the input display');
  device.send('START_UP\rSTART_DOWN\rCAMERA_UP\rCAMERA_DOWN\r');
  await settle();
  assert.deepEqual(actions, ['start', 'camera']);
  actions.length = 0;
  device.send('GOODBYE_GAME\rHELLO_GAME\rW_DOWN\rSTATE:1000110\rSTATE:1000110\r');
  await settle();
  assert.deepEqual(actions, [], 'a first full snapshot remains a baseline after partial legacy steering');
  device.send('START_UP\rSTART_DOWN\r');
  await settle();
  assert.deepEqual(actions, ['start']);
});

test('GOODBYE releases every input immediately and waits for a fresh controller state', async (t) => {
  const device = fakePort();
  const observed = callbacks();
  const controller = new BadgeSerialController(observed, { serial: { async requestPort() { return device.port; } } });
  t.after(() => controller.disconnect());
  await controller.connect();
  device.send('STATE:1010111\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'connected');
  device.send('GOODBYE_GAME\r');
  await settle();
  assert.deepEqual(observed.buttons.at(-1), emptyBadgeButtons());
  assert.equal(observed.statuses.at(-1), 'waiting');
  assert.equal(device.closes, 0, 'returning to the controller should reuse USB');
  device.send('unrelated menu log\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'waiting');
  device.send('HELLO_GAME\rSTATE:0000000\rLOOK_DOWN\r');
  await settle();
  assert.equal(observed.statuses.at(-1), 'connected');
  assert.deepEqual(observed.buttons.at(-1), { ...emptyBadgeButtons(), b: true });
});

for (const ending of ['eof', 'unplug'] as const) {
  test(`${ending} clears input, closes the port, and permits reconnecting`, async (t) => {
    const first = fakePort();
    const second = fakePort();
    const observed = callbacks();
    let selections = 0;
    const controller = new BadgeSerialController(observed, { serial: { async requestPort() { return selections++ === 0 ? first.port : second.port; } } });
    t.after(() => controller.disconnect());
    await controller.connect();
    first.send('A_DOWN\r');
    await settle();
    assert.equal(observed.buttons.at(-1)?.left, true);
    first[ending]();
    await settle();
    assert.deepEqual(observed.buttons.at(-1), emptyBadgeButtons());
    assert.equal(observed.statuses.at(-1), 'disconnected');
    assert.equal(first.closes, 1);
    await controller.connect();
    second.send('D_DOWN\r');
    await settle();
    assert.equal(observed.statuses.at(-1), 'connected');
    assert.equal(observed.buttons.at(-1)?.right, true);
  });
}

test('cancelled USB picker returns to disconnected without an error', async () => {
  const observed = callbacks();
  const controller = new BadgeSerialController(observed, { serial: { async requestPort() { throw Object.assign(new Error('No device selected'), { name: 'NotFoundError' }); } } });
  await controller.connect();
  assert.deepEqual(observed.statuses, ['connecting', 'disconnected']);
});

test('disconnect during the picker prevents a late result from opening the badge', async () => {
  const device = fakePort();
  const observed = callbacks();
  let select!: (port: BadgeSerialPort) => void;
  const controller = new BadgeSerialController(observed, { serial: { requestPort() { return new Promise((resolve) => { select = resolve; }); } } });
  const connecting = controller.connect();
  controller.disconnect();
  select(device.port);
  await connecting;
  assert.equal(device.openedAt, undefined);
  assert.equal(observed.statuses.at(-1), 'disconnected');
});

test('disconnect during port opening closes the stale connection before a new one opens', async (t) => {
  const first = fakePort();
  const second = fakePort();
  const observed = callbacks();
  let finishOpen!: () => void;
  first.port.open = () => new Promise<void>((resolve) => { finishOpen = resolve; });
  let selections = 0;
  const controller = new BadgeSerialController(observed, { serial: { async requestPort() { return selections++ === 0 ? first.port : second.port; } } });
  t.after(() => controller.disconnect());
  const stale = controller.connect();
  await settle();
  controller.disconnect();
  const next = controller.connect();
  await settle();
  assert.equal(second.openedAt, undefined);
  finishOpen();
  await Promise.all([stale, next]);
  assert.equal(first.closes, 1);
  assert.equal(second.openedAt, BADGE_SERIAL_BAUD_RATE);
  assert.equal(observed.statuses.at(-1), 'waiting');
});
