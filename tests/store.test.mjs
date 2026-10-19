import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import 'fake-indexeddb/auto';

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
      export const clients = [];
      export function createNdrClient(options) {
        const client = { options, sent: [], closed: false,
          async start() {}, async retry() {}, async close() { this.closed = true; },
          async send(peer, event) { this.sent.push({ peer, event }); }
        }; clients.push(client); return client;
      }
    ` }));
  } }],
});
const { store, nostr, clients, db } = await import('../work/store-test.mjs');
nostr.pool.get = async () => null;
nostr.pool.querySync = async () => [];
nostr.pool.subscribe = () => ({ close() {} });
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
