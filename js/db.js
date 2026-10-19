// Local cache: decrypted DMs, processed gift-wrap ids and profiles. Nothing leaves the browser.
let opening;

function open() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('anagram-lite', 2);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      db.createObjectStore('ndr', { keyPath: ['account', 'key'] });
      if (event.oldVersion >= 1) return;
      db.createObjectStore('dms', { keyPath: ['account', 'id'] }).createIndex('account', 'account');
      db.createObjectStore('wraps', { keyPath: ['account', 'id'] });
      db.createObjectStore('profiles', { keyPath: 'pubkey' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

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
