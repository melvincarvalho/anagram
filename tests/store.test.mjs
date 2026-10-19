import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { AppKeys } from 'nostr-double-ratchet';

// The browser's connection-status poll should not keep this Node test alive.
const setIntervalForTest = globalThis.setInterval;
globalThis.setInterval = (...args) => { const timer = setIntervalForTest(...args); timer.unref?.(); return timer; };
const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem(key, value) { local.set(key, value); this[key] = value; },
  removeItem(key) { local.delete(key); delete this[key]; },
};
globalThis.location = { hash: '' };
globalThis.window = { addEventListener() {} };
globalThis.addEventListener = () => {};
globalThis.fetch = async () => { throw new Error('No directory request in tests'); };
// Web Locks keep the browser's device state single-writer. The test owns one tab.
Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: (_name, _options, callback) => callback({}) } }, configurable: true });
await mkdir('work', { recursive: true });
await build({
  stdin: {
    contents: `export * as store from './js/store.js'; export * as nostr from './js/nostr.js'; export * as db from './js/db.js'; export { clients } from './js/ndr.js';`,
    resolveDir: process.cwd(),
  },
  outfile: 'work/store-test.mjs', bundle: true, format: 'esm', platform: 'browser',
  alias: { preact: './vendor/preact.mjs', 'preact/hooks': './vendor/hooks.mjs', '@preact/signals': './vendor/signals.mjs' },
  plugins: [{ name: 'runtime-test-port', setup(build) {
    build.onResolve({ filter: /\/ndr\.js$/ }, () => ({ path: 'ndr', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      import { AppKeys } from 'nostr-double-ratchet';
      export const hasNdrDevices = (event) => AppKeys.fromEvent(event).getAllDevices().length > 0;
      export const clients = [];
      export function createNdrClient(options) {
        const client = { options, sent: [], closed: false,
          async start() {}, async retry() {}, async close() { this.closed = true; },
          async send(peer, event) { this.sent.push({ peer, event }); }
        }; clients.push(client); return client;
      }
    `, resolveDir: process.cwd() }));
  } }],
});
const { store, nostr, clients, db } = await import('../work/store-test.mjs');
nostr.pool.get = async () => null;
nostr.pool.querySync = async () => [];
nostr.pool.subscribe = (_relays, _filter, callbacks) => { queueMicrotask(() => callbacks.oneose?.()); return { close() {} }; };
nostr.pool.publish = () => [Promise.resolve()];
const signer = nostr.newKeySigner();
const peer = nostr.newKeySigner().pubkey;
localStorage.setItem(`lite:rooms:${signer.pubkey}`, '[]');

test('NIP-17 default; selected NDR survives replies to old messages; mutations keep source transport', async () => {
  await store.login(signer, false);
  assert.equal(store.directProtocol(peer), 'nip17');
  await store.sendDirectMessage(peer, 'Original NIP-17');
  const old = store.dms.value[peer][0];
  assert.equal(clients.length, 0);
  await store.setDirectProtocol(peer, 'ndr');
  await store.sendDirectMessage(peer, 'NDR reply to old NIP-17', old);
  assert.equal(clients[0].sent.length, 1);
  assert.equal(clients[0].sent[0].event.content, 'NDR reply to old NIP-17');
  assert.ok(clients[0].sent[0].event.tags.some((tag) => tag[0] === 'e' && tag[1] === old.id));
  await store.toggleReaction({ peer }, old, '👍');
  assert.equal(clients[0].sent.length, 1); // old NIP-17 reaction stays gift wrapped
  const ndr = store.dms.value[peer].find((message) => message.protocol === 'ndr');
  await store.setDirectProtocol(peer, 'nip17');
  await store.editMessage({ peer }, ndr, 'An Iris edit');
  assert.equal(clients[0].sent.at(-1).event.kind, 1009);
  assert.equal(store.dms.value[peer].find((message) => message.id === ndr.id).content, 'An Iris edit');
  await store.deleteMessage({ peer }, ndr);
  assert.equal(clients[0].sent.at(-1).event.kind, 5);
  assert.ok(!store.dms.value[peer].some((message) => message.id === ndr.id));
});

test('received edits authenticate authors and persist before an out-of-order base message', async () => {
  const base = nostr.makeRumor(peer, 14, 'Original', [['p', signer.pubkey]]);
  const edit = nostr.makeRumor(peer, 1009, 'Edited before original arrived', [['p', signer.pubkey], ['e', base.id], ['k', '14']]);
  await clients[0].options.receive(edit, peer);
  await clients[0].options.receive(base, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, edit.content);
  const forged = nostr.makeRumor(signer.pubkey, 1009, 'Wrong author', [['p', peer], ['e', base.id], ['k', '14']], edit.created_at + 1);
  await clients[0].options.receive(forged, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, edit.content);
  const wrongDeletion = nostr.makeRumor(signer.pubkey, 5, '', [['p', peer], ['e', base.id], ['k', '14']]);
  await clients[0].options.receive(wrongDeletion, peer);
  assert.ok((await db.loadDirectMessages(signer.pubkey)).some((row) => row.id === base.id && row.content === base.content));
  const third = nostr.makeRumor(peer, 1009, 'Still authenticated', [['p', signer.pubkey], ['e', base.id], ['k', '14']], edit.created_at + 2);
  await clients[0].options.receive(third, peer);
  assert.equal(store.dms.value[peer].find((message) => message.id === base.id).content, third.content);
  await store.logout();
  assert.equal(clients[0].closed, true);
  assert.deepEqual(store.dms.value, {});
});


test('upstream NIP-17 optimistic reactions and deletes roll back on relay refusal', async () => {
  await store.login(signer, false);
  await store.setDirectProtocol(peer, 'nip17');
  await store.sendDirectMessage(peer, 'NIP-17 optimistic baseline');
  const message = store.dms.value[peer].find((row) => row.content === 'NIP-17 optimistic baseline');
  const published = nostr.pool.publish;
  nostr.pool.publish = () => [Promise.reject(new Error('Relay refused'))];
  const until = async (predicate) => {
    for (let i = 0; i < 50 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(predicate());
  };
  try {
    await store.toggleReaction({ peer }, message, '👍');
    assert.ok(store.reactions.value[message.id]?.length);
    await until(() => !(store.reactions.value[message.id]?.length));
    await store.deleteMessage({ peer }, message);
    assert.ok(!store.dms.value[peer].some((row) => row.id === message.id));
    await until(() => store.dms.value[peer].some((row) => row.id === message.id));
    assert.equal(clients.length, 1); // no NDR activation or transport fallback
  } finally {
    nostr.pool.publish = published;
    await store.logout();
  }
});

const eventually = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
};

test('Auto discovers delayed support, caches sends, respects overrides and never downgrades chosen NDR', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner(), subscriptions = [];
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const original = nostr.pool.subscribe;
  nostr.pool.subscribe = (relays, filter, callbacks) => {
    if (filter.kinds.includes(37368)) {
      const entry = { filter, callbacks, closed: false };
      subscriptions.push(entry);
      queueMicrotask(() => callbacks.oneose());
      return { close() { entry.closed = true; } };
    }
    return original(relays, filter, callbacks);
  };
  try {
    await store.login(alice, false);
    const count = clients.length;
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    store.openDirectChat(bob.pubkey);
    await store.prepareDirectProtocol(bob.pubkey);
    await store.sendDirectMessage(bob.pubkey, 'Auto initially NIP-17');
    await store.sendDirectMessage(bob.pubkey, 'No per-message network query');
    assert.equal(subscriptions.length, 1);
    assert.equal(clients.length, count);
    assert.equal(store.directPreference(bob.pubkey), 'auto');
    const t = nostr.now();
    const supported = await bob.sign(new AppKeys([{ identityPubkey: nostr.newKeySigner().pubkey, createdAt: t }]).getEvent({ ownerPubkey: bob.pubkey, createdAt: t }));
    subscriptions[0].callbacks.onevent(supported);
    await eventually(() => store.directProtocol(bob.pubkey) === 'ndr');
    await store.sendDirectMessage(bob.pubkey, 'Auto upgraded to NDR');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Auto upgraded to NDR');
    const send = clients.at(-1).send;
    clients.at(-1).send = async () => { throw new Error('Temporary NDR failure'); };
    await assert.rejects(store.sendDirectMessage(bob.pubkey, 'Keep failed NDR queued'), /Temporary NDR failure/);
    const failed = store.dms.value[bob.pubkey].find((message) => message.content === 'Keep failed NDR queued');
    assert.equal(failed.protocol, 'ndr');
    assert.equal(store.sendStatus.value[failed.id], 'failed');
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    clients.at(-1).send = send;
    subscriptions[0].callbacks.onevent(await bob.sign(new AppKeys().getEvent({ ownerPubkey: bob.pubkey, createdAt: t + 1 })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    store.setPreferDoubleRatchet(false);
    assert.equal(store.directProtocol(bob.pubkey), 'ndr');
    assert.equal(subscriptions[0].closed, true);
    await store.setDirectProtocol(bob.pubkey, 'nip17');
    subscriptions[0].callbacks.onevent(supported);
    await store.sendDirectMessage(bob.pubkey, 'Explicit NIP-17 override');
    assert.equal(store.directProtocol(bob.pubkey), 'nip17');
    assert.equal(clients.at(-1).sent.at(-1).event.content, 'Auto upgraded to NDR');
    const unknown = nostr.newKeySigner().pubkey;
    store.openDirectChat(unknown);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 1); // account setting disables Auto discovery
    store.setPreferDoubleRatchet(true);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 2);
    store.closeDirectChat();
    store.openDirectChat(unknown);
    await store.prepareDirectProtocol(unknown);
    assert.equal(subscriptions.length, 3); // a negative cache is rechecked on open
    await store.logout();
    assert.equal(subscriptions.at(-1).closed, true);
  } finally { nostr.pool.subscribe = original; }
});

test('existing NIP-17 history stays selected, settings and Auto selection persist per account', async () => {
  const alice = nostr.newKeySigner(), bob = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${alice.pubkey}`, '[]');
  const old = nostr.makeRumor(bob.pubkey, 14, 'Cached old NIP-17', [['p', alice.pubkey]]);
  await db.saveDirectMessages([{ ...old, account: alice.pubkey, peer: bob.pubkey }]);
  const login = store.login(alice, false);
  // Opening while the cache is still loading must not turn existing history Auto.
  store.openDirectChat(bob.pubkey);
  await login;
  await store.prepareDirectProtocol(bob.pubkey);
  assert.equal(store.directPreference(bob.pubkey), 'nip17');
  store.setPreferDoubleRatchet(false);
  await store.setDirectProtocol(bob.pubkey, 'auto');
  await store.login(alice, false);
  assert.equal(store.preferDoubleRatchet.value, false);
  assert.equal(store.directPreference(bob.pubkey), 'auto');
  await store.setDirectProtocol(bob.pubkey, 'ndr');
  await store.setDirectProtocol(bob.pubkey, 'auto');
  await store.login(alice, false);
  assert.equal(store.directProtocol(bob.pubkey), 'ndr');
  const other = nostr.newKeySigner();
  localStorage.setItem(`lite:rooms:${other.pubkey}`, '[]');
  await store.login(other, false);
  assert.equal(store.preferDoubleRatchet.value, true);
  assert.equal(store.directPreference(bob.pubkey), 'auto');
  assert.equal(store.directProtocol(bob.pubkey), 'nip17');
  await store.logout();
});
