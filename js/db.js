// Local cache: decrypted DMs, processed gift-wrap ids, profiles and public room messages.
// Nothing leaves the browser.
let opening;

function open() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('anagram-lite', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Version 2 existed with room history upstream and with NDR in early PR
      // builds. Preserve either layout and add only its missing stores.
      if (!db.objectStoreNames.contains('dms'))
        db.createObjectStore('dms', { keyPath: ['account', 'id'] }).createIndex('account', 'account');
      if (!db.objectStoreNames.contains('wraps')) db.createObjectStore('wraps', { keyPath: ['account', 'id'] });
      if (!db.objectStoreNames.contains('profiles')) db.createObjectStore('profiles', { keyPath: 'pubkey' });
      if (!db.objectStoreNames.contains('roomMessages'))
        db.createObjectStore('roomMessages', { keyPath: 'id' }).createIndex('room', ['room', 'created_at']);
      if (!db.objectStoreNames.contains('ndr')) db.createObjectStore('ndr', { keyPath: ['account', 'key'] });
    };
    // Another tab still holds an older version open; its upgrade can't proceed until it closes.
    req.onblocked = () => blockedListeners.forEach((fn) => fn());
    req.onsuccess = () => {
      const db = req.result;
      // A newer version is opening in another tab: close so it can upgrade, then reload into it.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
        location.reload();
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
  }));
}

const blockedListeners = new Set();
export const onOpenBlocked = (fn) => blockedListeners.add(fn);

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const loadDirectMessages = (account) =>
  run('dms', 'readonly', (s) => s.index('account').getAll(account));

export const saveDirectMessages = (rows) =>
  run('dms', 'readwrite', (s) => rows.forEach((r) => s.put(r)));

// A wrap is done once processed, or after 3 sessions of transient (signer) failures.
export const hasWrap = (account, id) =>
  run('wraps', 'readonly', (s) => s.get([account, id])).then((row) => !!row && (row.failures ?? 3) >= 3);

export async function markWrapFailure(account, id) {
  const row = await run('wraps', 'readonly', (s) => s.get([account, id]));
  return run('wraps', 'readwrite', (s) => s.put({ account, id, failures: (row?.failures ?? 0) + 1 }));
}

export const markWraps = (account, ids) =>
  run('wraps', 'readwrite', (s) => ids.forEach((id) => s.put({ account, id })));

export const deleteDirectMessage = (account, id) =>
  run('dms', 'readwrite', (s) => s.delete([account, id]));

export const loadProfiles = () => run('profiles', 'readonly', (s) => s.getAll());

export const saveProfiles = (rows) =>
  run('profiles', 'readwrite', (s) => rows.forEach((r) => s.put(r)));

// Remove one conversation's stored messages (Delete chat).
export async function deleteConversation(account, peer) {
  const rows = await loadDirectMessages(account);
  const ids = rows.filter((r) => r.peer === peer).map((r) => r.id);
  return run('dms', 'readwrite', (s) => ids.forEach((id) => s.delete([account, id])));
}

const ROOM_KEEP = 300;

// Newest cached messages of a room, oldest first.
export async function loadRoomMessages(address, limit = 200) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const rows = [];
    const range = IDBKeyRange.bound([address, 0], [address, Infinity]);
    const cursor = db.transaction('roomMessages').objectStore('roomMessages').index('room').openCursor(range, 'prev');
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c || rows.length >= limit) return resolve(rows.reverse().map(({ room: _, ...e }) => e));
      rows.push(c.value);
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  });
}

// Store events, then trim the room to its newest ROOM_KEEP.
export async function saveRoomMessages(address, events) {
  if (!events.length) return;
  await run('roomMessages', 'readwrite', (s) => events.forEach((e) => s.put({ ...e, room: address })));
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('roomMessages', 'readwrite');
    const range = IDBKeyRange.bound([address, 0], [address, Infinity]);
    let seen = 0;
    const cursor = tx.objectStore('roomMessages').index('room').openCursor(range, 'prev');
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      if (++seen > ROOM_KEEP) c.delete();
      c.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export const deleteRoomMessages = (ids) => run('roomMessages', 'readwrite', (s) => ids.forEach((id) => s.delete(id)));

export async function clearAccount(account) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['dms', 'wraps', 'ndr'], 'readwrite');
    const range = IDBKeyRange.bound([account, ''], [account, '￿']);
    tx.objectStore('dms').delete(range);
    tx.objectStore('wraps').delete(range);
    tx.objectStore('ndr').delete(range);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Account-scoped keys, sessions and signed outbox envelopes. IndexedDB preserves
// Uint8Array keys without a lossy JSON conversion.
export const ndrStorage = (account) => ({
  get: (key) => run('ndr', 'readonly', (s) => s.get([account, key])).then((r) => r?.value),
  put: (key, value) => run('ndr', 'readwrite', (s) => s.put({ account, key, value })).then(() => {}),
  del: (key) => run('ndr', 'readwrite', (s) => s.delete([account, key])),
  list: (prefix = '') => run('ndr', 'readonly', (s) => s.getAllKeys(
    IDBKeyRange.bound([account, prefix], [account, `${prefix}￿`]),
  )).then((keys) => keys.map((key) => key[1])),
});
