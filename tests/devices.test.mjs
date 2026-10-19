import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { AppKeys } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';

// Bundle the ordinary browser adapter without starting a store or session.
await mkdir('work', { recursive: true });
await build({ entryPoints: ['js/messaging-devices.js'], outfile: 'work/devices-test.mjs', bundle: true, format: 'esm', platform: 'browser',
  external: ['../vendor/nostr-double-ratchet.mjs'],
  alias: { 'nostr-tools': './vendor/nostr-tools.mjs', 'nostr-tools/nip46': './vendor/nip46.mjs' },
});
const { loadMessagingDevices } = await import('../work/devices-test.mjs');
const key = generateSecretKey(), owner = getPublicKey(key), current = getPublicKey(generateSecretKey()), other = getPublicKey(generateSecretKey());
const time = Math.floor(Date.now() / 1000);
const roster = (devices, createdAt = time, signer = key) => finalizeEvent(
  new AppKeys(devices.map((identityPubkey) => ({ identityPubkey, createdAt }))).getEvent({ ownerPubkey: getPublicKey(signer), createdAt }), signer,
);
function ports(events, currentDevice = current) {
  const calls = [];
  return {
    calls,
    async fetchEvents(filter) { calls.push(['fetch', filter]); return events; },
    async readCurrentDevice(account) { calls.push(['read-public-key', account]); return currentDevice; },
    async loadParser() { calls.push(['parser']); return AppKeys; },
  };
}

test('listing authorized devices only reads the requested owner roster and public identity', async () => {
  const io = ports([roster([other, current])]);
  const devices = await loadMessagingDevices(owner, io);
  assert.deepEqual(devices, [{ pubkey: current, current: true }, { pubkey: other, current: false }]);
  assert.deepEqual(io.calls, [
    ['fetch', { kinds: [37368], authors: [owner], limit: 10 }], ['read-public-key', owner], ['parser'],
  ]); // no signer, session, initialization or publication port exists
});

test('no local device is created when opening an empty device list', async () => {
  const io = ports([], null);
  assert.deepEqual(await loadMessagingDevices(owner, io), []);
  assert.equal(io.calls.filter(([kind]) => kind === 'parser').length, 0);
  assert.equal(io.calls.filter(([kind]) => kind === 'read-public-key').length, 1);
});

test('forged, unrelated-owner and malformed rosters cannot advertise a device', async () => {
  const valid = roster([other]);
  const io = ports([
    { ...valid, sig: '0'.repeat(128) }, roster([other], time, generateSecretKey()),
    roster(['not-a-public-key']),
  ]);
  assert.deepEqual(await loadMessagingDevices(owner, io), []);
});

test('newest valid empty snapshot clears old devices and each account is isolated', async () => {
  assert.deepEqual(await loadMessagingDevices(owner, ports([roster([current], time - 1), roster([])])), []);
  const anotherKey = generateSecretKey(), anotherOwner = getPublicKey(anotherKey);
  const io = ports([roster([current]), roster([other], time, anotherKey)], null);
  assert.deepEqual(await loadMessagingDevices(anotherOwner, io), [{ pubkey: other, current: false }]);
  assert.deepEqual(io.calls[1], ['read-public-key', anotherOwner]);
});
