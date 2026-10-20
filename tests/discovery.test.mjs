import test from 'node:test';
import assert from 'node:assert/strict';
import { AppKeys } from 'nostr-double-ratchet';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { watchNdrCapability } from '../js/ndr-discovery.js';
import { hasNdrDevices } from '../js/ndr.js';

const sk = generateSecretKey(), peer = getPublicKey(sk), device = getPublicKey(generateSecretKey());
const roster = (devices = [device], created_at = Math.floor(Date.now() / 1000)) => finalizeEvent({
  ...new AppKeys(devices.map((identityPubkey) => ({ identityPubkey, createdAt: created_at }))).getEvent({ ownerPubkey: peer, createdAt: created_at }),
}, sk);
function harness() {
  let callbacks, filter, closed = false, loads = 0;
  const results = [];
  const watcher = watchNdrCapability({ peer, timeoutMs: 30,
    subscribe(f, c) { filter = f; callbacks = c; return () => { closed = true; }; },
    loadParser: async () => { loads++; return hasNdrDevices; },
    onCapability: (supported) => results.push(supported),
  });
  return { watcher, results, get callbacks() { return callbacks; }, get loads() { return loads; }, get filter() { return filter; }, get closed() { return closed; } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('supported owner-signed roster loads parser once; initial EOSE chooses latest snapshot', async () => {
  const h = harness();
  assert.deepEqual(h.filter, { kinds: [37368], authors: [peer], limit: 10 });
  h.callbacks.onevent(roster());
  h.callbacks.oneose();
  assert.equal(await h.watcher.initial, true);
  assert.deepEqual(h.results, [true]);
  assert.equal(h.loads, 1);
  h.watcher.close();
  assert.equal(h.closed, true);
});

test('negative discovery avoids library and a later compatible live event upgrades', async () => {
  const h = harness();
  h.callbacks.oneose();
  assert.equal(await h.watcher.initial, false);
  assert.equal(h.loads, 0);
  h.callbacks.onevent(roster());
  await settle();
  assert.deepEqual(h.results, [false, true]);
  h.watcher.close();
});

test('newer empty roster supersedes older active devices before initial selection', async () => {
  const h = harness(), now = Math.floor(Date.now() / 1000);
  h.callbacks.onevent(roster([], now));
  h.callbacks.onevent(roster([device], now - 1));
  h.callbacks.oneose();
  assert.equal(await h.watcher.initial, false);
  assert.equal(h.loads, 0);
  h.watcher.close();
});

test('forged signature, wrong owner and invalid device cannot enable NDR', async () => {
  const h = harness(), valid = roster();
  h.callbacks.onevent({ ...valid, sig: '0'.repeat(128) });
  h.callbacks.onevent({ ...valid, pubkey: device });
  h.callbacks.onevent(roster(['not-a-device']));
  h.callbacks.oneose();
  assert.equal(await h.watcher.initial, false);
  assert.equal(h.loads, 0);
  h.watcher.close();
});

test('unavailable relays settle promptly, and closing cancels late discovery', async () => {
  const h = harness();
  assert.equal(await h.watcher.initial, false);
  h.watcher.close();
  h.callbacks.onevent(roster());
  await settle();
  assert.deepEqual(h.results, [false]);
  assert.equal(h.loads, 0);
});
