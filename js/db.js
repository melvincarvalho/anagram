// Local cache: decrypted DMs, processed gift-wrap ids and profiles. Nothing leaves the browser.
let opening;

function open() {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('anagram-lite', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
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

export const hasWrap = (account, id) =>
  run('wraps', 'readonly', (s) => s.getKey([account, id])).then((k) => k !== undefined);

export const markWraps = (account, ids) =>
  run('wraps', 'readwrite', (s) => ids.forEach((id) => s.put({ account, id })));

export const loadProfiles = () => run('profiles', 'readonly', (s) => s.getAll());

export const saveProfiles = (rows) =>
  run('profiles', 'readwrite', (s) => rows.forEach((r) => s.put(r)));

export async function clearAccount(account) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['dms', 'wraps'], 'readwrite');
    const range = IDBKeyRange.bound([account, ''], [account, '￿']);
    tx.objectStore('dms').delete(range);
    tx.objectStore('wraps').delete(range);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
