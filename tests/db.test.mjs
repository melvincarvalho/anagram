import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
const legacy = await new Promise((resolve, reject) => {
  const request = indexedDB.open('anagram-lite', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('dms', { keyPath: ['account', 'id'] }).createIndex('account', 'account');
    request.result.createObjectStore('wraps', { keyPath: ['account', 'id'] });
    request.result.createObjectStore('profiles', { keyPath: 'pubkey' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
await new Promise((resolve) => {
  const tx = legacy.transaction('dms', 'readwrite');
  tx.objectStore('dms').put({ account: 'existing', id: 'old', content: 'Existing NIP-17 history' });
  tx.oncomplete = resolve;
});
legacy.close();
const db = await import('../js/db.js');

test('schema upgrade retains existing NIP-17 history', async () => {
  assert.equal((await db.loadDirectMessages('existing'))[0].content, 'Existing NIP-17 history');
});

test('runtime storage preserves bytes and isolates account data and deletion', async () => {
  const alice = db.ndrStorage('alice');
  const bob = db.ndrStorage('bob');
  await alice.put('device/key', new Uint8Array([1, 2, 3]));
  await alice.put('outbox/event', { id: 'signed' });
  await bob.put('device/key', new Uint8Array([4, 5, 6]));
  await db.saveDirectMessages([{ account: 'alice', id: 'message', content: 'NIP-17 stays' }]);
  assert.deepEqual(await alice.get('device/key'), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await alice.list('outbox/'), ['outbox/event']);
  await db.clearAccount('alice');
  assert.deepEqual(await alice.list(), []);
  assert.deepEqual(await db.loadDirectMessages('alice'), []);
  assert.deepEqual(await bob.get('device/key'), new Uint8Array([4, 5, 6]));
});
