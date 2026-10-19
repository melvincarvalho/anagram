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

// Both version-2 layouts were used before this integration merged upstream.
for (const layout of ['fresh', 'upstream-v2', 'ndr-v2']) {
  test(`version-3 migration preserves ${layout} data and supports both caches`, async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    globalThis.indexedDB = new IDBFactory();
    if (layout !== 'fresh') {
      const previous = await new Promise((resolve, reject) => {
        const request = indexedDB.open('anagram-lite', 2);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('dms', { keyPath: ['account', 'id'] }).createIndex('account', 'account');
          request.result.createObjectStore('wraps', { keyPath: ['account', 'id'] });
          request.result.createObjectStore('profiles', { keyPath: 'pubkey' });
          if (layout === 'upstream-v2') request.result.createObjectStore('roomMessages', { keyPath: 'id' }).createIndex('room', ['room', 'created_at']);
          else request.result.createObjectStore('ndr', { keyPath: ['account', 'key'] });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve) => {
        const tx = previous.transaction([...previous.objectStoreNames], 'readwrite');
        tx.objectStore('dms').put({ account: 'existing', id: 'old-dm', content: 'Keep NIP-17 history' });
        tx.objectStore('profiles').put({ pubkey: 'profile', name: 'Keep profile' });
        tx.objectStore('wraps').put({ account: 'existing', id: 'wrap' });
        if (layout === 'upstream-v2') tx.objectStore('roomMessages').put({ id: 'old-room', room: 'room', created_at: 1, content: 'Keep room history' });
        else tx.objectStore('ndr').put({ account: 'existing', key: 'device/key', value: new Uint8Array([7, 8, 9]) });
        tx.oncomplete = resolve;
      });
      previous.close();
    }
    const migrated = await import(`../js/db.js?migration=${layout}`);
    await migrated.ndrStorage('other').put('key', new Uint8Array([4]));
    await migrated.saveRoomMessages('room', [{ id: 'new-room', created_at: 2, content: 'New room history' }]);
    assert.deepEqual(await migrated.ndrStorage('other').get('key'), new Uint8Array([4]));
    assert.ok((await migrated.loadRoomMessages('room')).some((row) => row.id === 'new-room'));
    if (layout !== 'fresh') {
      assert.equal((await migrated.loadDirectMessages('existing'))[0].content, 'Keep NIP-17 history');
      assert.equal((await migrated.loadProfiles())[0].name, 'Keep profile');
      assert.equal(await migrated.hasWrap('existing', 'wrap'), true);
      if (layout === 'upstream-v2') assert.equal((await migrated.loadRoomMessages('room'))[0].content, 'Keep room history');
      else assert.deepEqual(await migrated.ndrStorage('existing').get('device/key'), new Uint8Array([7, 8, 9]));
    }
    await migrated.clearAccount('existing');
    assert.ok((await migrated.loadRoomMessages('room')).some((row) => row.id === 'new-room'));
    assert.deepEqual(await migrated.ndrStorage('other').get('key'), new Uint8Array([4]));
  });
}
