// App state as Preact signals. Every update replaces values immutably so components re-render.
import { signal, computed, batch } from '@preact/signals';
import * as nostr from './nostr.js';
import * as db from './db.js';

export const me = signal(null); // signer
export const profiles = signal({}); // pubkey -> profile
export const dms = signal({}); // peer -> messages, oldest first
export const inboxRelays = signal(null); // null = unknown, [] = none published
export const syncing = signal(false);
export const joinedRooms = signal([]); // [{ address, owner, slug, relays, name }]
export const roomState = signal({}); // address -> { room, messages, loading, error, exhausted }
export const route = signal(parseRoute());
export const toast = signal('');
export const reactions = signal({}); // target message id -> [{ id, pubkey, emoji }]
export const contacts = signal([]);
export const chatPrefs = signal({ pinned: [], muted: [] }); // chat keys
export const drafts = signal({}); // chat key -> unsent text
export const readMarks = signal({}); // chat key (peer hex or room address) -> last read created_at
let readSince = 0; // messages before first use of this device count as read // pubkeys from the private contact list
let contactList = null; // { event } once loaded, so we never overwrite a list we haven't read

const storage = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

export function notify(message) {
  toast.value = message;
  setTimeout(() => toast.value === message && (toast.value = ''), 4000);
}

// ---------- Routing ----------

function parseRoute() {
  const page = location.hash.match(/^#\/(settings|new)$/)?.[1];
  if (page) return { kind: page };
  const [, kind, id] = location.hash.match(/^#\/(dm|room|public)\/(.+)$/) ?? [];
  return kind ? { kind: kind === 'public' ? 'room' : kind, id: decodeURIComponent(id) } : { kind: 'home' };
}
window.addEventListener('hashchange', () => (route.value = parseRoute()));
export const go = (hash) => (location.hash = hash);

// ---------- Session ----------

let inboxSub = null;
const roomSubs = new Map();

// ---------- Accounts ----------
// Remembered accounts live in localStorage as serialized signers; one is active.

export const accounts = signal([]); // [{ pubkey, type }]
export const addingAccount = signal(false);

function savedAccounts() {
  const list = storage.get('lite:accounts', null);
  if (list) return list;
  // Migrate the single-session format used before multiple accounts.
  const legacy = storage.get('lite:session', null);
  return legacy?.type ? [{ pubkey: legacy.pubkey ?? null, saved: legacy }] : [];
}

function refreshAccounts() {
  accounts.value = savedAccounts()
    .filter((a) => a.pubkey)
    .map((a) => ({ pubkey: a.pubkey, type: a.saved.type }));
}

function rememberAccount(signer) {
  const list = savedAccounts().filter((a) => a.pubkey && a.pubkey !== signer.pubkey);
  storage.set('lite:accounts', [{ pubkey: signer.pubkey, saved: nostr.serializeSigner(signer) }, ...list]);
  storage.set('lite:session', undefined);
  refreshAccounts();
}

// Stop everything belonging to the current account without forgetting it.
function teardown() {
  clearTimeout(incomingTimer);
  incomingTimer = undefined;
  incoming = { messages: [], reactions: [] };
  flushSaves();
  if (draftTimer) {
    clearTimeout(draftTimer);
    if (me.value) storage.set(`lite:drafts:${me.value.pubkey}`, drafts.value);
  }
  inboxSub?.close();
  inboxSub = null;
  for (const sub of roomSubs.values()) sub.close();
  roomSubs.clear();
  // Drop every relay connection: they carry the old account's NIP-42 auth and would link accounts.
  nostr.pool.close([...nostr.pool.relays.keys()]);
  contactsLoaded = null;
  contactQueue = Promise.resolve();
  dmCursors.clear();
  dmDone.clear();
  roomPaging.clear();
  seenWraps.clear();
  deleted.clear();
  contactList = null;
  batch(() => {
    me.value = null;
    contacts.value = [];
    reactions.value = {};
    dms.value = {};
    roomState.value = {};
    joinedRooms.value = [];
    inboxRelays.value = null;
    syncing.value = false;
    dmHistoryDone.value = false;
  });
}

export async function switchAccount(pubkey) {
  const entry = savedAccounts().find((a) => a.pubkey === pubkey);
  if (!entry || me.value?.pubkey === pubkey) return;
  const signer = await nostr.restoreSigner(entry.saved);
  go('');
  await login(signer, true);
}

export async function login(signer, remember) {
  if (me.value) teardown();
  addingAccount.value = false;
  liveSince = nostr.now() - 10;
  me.value = signer;
  nostr.enableAuth(signer);
  if (remember) rememberAccount(signer);
  storage.set('lite:active', signer.pubkey);
  readMarks.value = storage.get(`lite:read:${signer.pubkey}`, {});
  drafts.value = storage.get(`lite:drafts:${signer.pubkey}`, {});
  chatPrefs.value = { pinned: [], muted: [], ...storage.get(`lite:prefs:${signer.pubkey}`, {}) };
  readSince = storage.get(`lite:read-since:${signer.pubkey}`, 0);
  if (!readSince) storage.set(`lite:read-since:${signer.pubkey}`, (readSince = nostr.now()));
  const starter = nostr.starterRoom();
  const saved = storage.get(`lite:rooms:${signer.pubkey}`, null);
  joinedRooms.value = saved ?? (starter ? [roomEntry(starter)] : []);
  if (starter && !saved) setRoom(starter.address, { room: starter });
  requestProfiles([signer.pubkey]);
  for (const room of joinedRooms.value) openRoom(room);
  loadContacts();
  await startInbox();
}

export async function restoreSession() {
  const list = savedAccounts();
  refreshAccounts();
  const active = storage.get('lite:active', null);
  const entry = list.find((a) => a.pubkey === active) ?? list[0];
  if (!entry) return false;
  try {
    const signer = await nostr.restoreSigner(entry.saved);
    // Fill in the pubkey for sessions migrated from the old format.
    await login(signer, !entry.pubkey);
    return true;
  } catch (e) {
    notify(`Could not restore session: ${e.message}`);
    return false;
  }
}

// Sign out of the current account only; move to the next remembered one if any.
export async function logout() {
  const current = me.value?.pubkey;
  const flushed = flushSaves();
  teardown();
  // Forget this account's data on this device: decrypted DMs and per-account settings.
  if (current) {
    await flushed;
    await db.clearAccount(current).catch(() => {});
    for (const key of Object.keys(localStorage)) if (key.startsWith('lite:') && key.endsWith(`:${current}`)) storage.set(key, undefined);
    if (storage.get('lite:active', null) === current) storage.set('lite:active', undefined);
  }
  storage.set('lite:accounts', savedAccounts().filter((a) => a.pubkey !== current));
  storage.set('lite:session', undefined);
  refreshAccounts();
  go('');
  const next = accounts.value[0];
  if (next) await switchAccount(next.pubkey).catch((e) => notify(`Could not switch: ${e.message}`));
}

// ---------- Pinned & muted chats ----------

export const isPinned = (key) => chatPrefs.value.pinned.includes(key);
export const isMuted = (key) => chatPrefs.value.muted.includes(key);

function togglePref(list, key) {
  const current = chatPrefs.value[list];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  chatPrefs.value = { ...chatPrefs.value, [list]: next };
  storage.set(`lite:prefs:${me.value.pubkey}`, chatPrefs.value);
}
export const togglePinned = (key) => togglePref('pinned', key);
export const toggleMuted = (key) => togglePref('muted', key);

// ---------- Drafts ----------

let draftTimer;
export function setDraft(key, text) {
  if (!me.value || !key || (drafts.value[key] ?? '') === text) return;
  const next = { ...drafts.value };
  if (text.trim()) next[key] = text;
  else delete next[key];
  drafts.value = next;
  // Debounce storage writes while typing.
  clearTimeout(draftTimer);
  const account = me.value.pubkey;
  const snapshot = drafts.value;
  draftTimer = setTimeout(() => storage.set(`lite:drafts:${account}`, snapshot), 300);
}

// ---------- Unread ----------

export function markRead(key, ts) {
  if (!me.value || (readMarks.value[key] ?? 0) >= ts) return;
  readMarks.value = { ...readMarks.value, [key]: ts };
  storage.set(`lite:read:${me.value.pubkey}`, readMarks.value);
}

export function unreadCount(key, messages) {
  const since = Math.max(readMarks.value[key] ?? 0, readSince);
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].created_at > since; i--)
    if (messages[i].pubkey !== me.value?.pubkey) n++;
  return n;
}

export const totalUnread = computed(() => {
  if (!me.value) return 0;
  let n = 0;
  // Muted chats keep their own badge but stay out of the total, like Telegram.
  for (const [peer, thread] of Object.entries(dms.value)) if (!isMuted(peer)) n += unreadCount(peer, thread);
  for (const room of joinedRooms.value)
    if (!isMuted(room.address)) n += unreadCount(room.address, roomState.value[room.address]?.messages ?? []);
  return n;
});

// ---------- Incoming-message notifications ----------

let liveSince = Infinity; // only messages newer than login are "new"
const incomingListeners = new Set();
export const onIncoming = (fn) => (incomingListeners.add(fn), () => incomingListeners.delete(fn));

export const notifySettings = signal(storage.get('lite:notify', { dms: true, rooms: 'mentions', sound: true }));
export function setNotifySettings(patch) {
  notifySettings.value = { ...notifySettings.value, ...patch };
  storage.set('lite:notify', notifySettings.value);
}

// True when a room message @mentions us or replies to one of our messages.
function mentionsMe(event) {
  const pk = me.value?.pubkey;
  if (!pk) return false;
  if (event.tags.some((t) => (t[0] === 'p' || t[0] === 'q') && (t[1] === pk || t[3] === pk))) return true;
  if (event.content.includes(nostr.did(pk)) || event.content.includes(nostr.npub(pk))) return true;
  return /nostr:nprofile1/.test(event.content) && (event.content.match(/nprofile1[02-9ac-hj-np-z]+/g) ?? []).some((p) => nostr.decodePubkey(p) === pk);
}

function emitIncoming(chat, message) {
  if (!me.value || message.pubkey === me.value.pubkey || message.created_at < liveSince) return;
  const settings = notifySettings.value;
  if (isMuted(chat.peer ?? chat.room.address)) return;
  if (chat.peer && !settings.dms) return;
  if (chat.room && (settings.rooms === 'off' || (settings.rooms === 'mentions' && !mentionsMe(message)))) return;
  for (const fn of incomingListeners) fn(chat, message);
}

// ---------- Media uploads ----------

export const mediaServer = signal(storage.get('lite:blossom', nostr.DEFAULT_BLOSSOM));
export function setMediaServer(value) {
  const origin = nostr.normalizeBlossomServer(value);
  if (!origin) throw new Error('Enter an https:// server address without a path.');
  mediaServer.value = origin;
  storage.set('lite:blossom', origin);
}
export const uploadMedia = (file) => nostr.uploadBlossom(me.value, file, mediaServer.value);

// ---------- Search ----------

// Newest-first message matches across DMs and joined rooms (what is loaded locally).
export function searchMessages(query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const [peer, thread] of Object.entries(dms.value))
    for (const m of thread) if (m.content.toLowerCase().includes(q)) hits.push({ chat: { peer }, m });
  for (const room of joinedRooms.value)
    for (const m of roomState.value[room.address]?.messages ?? [])
      if (m.content.toLowerCase().includes(q)) hits.push({ chat: { room }, m });
  return hits.sort((a, b) => b.m.created_at - a.m.created_at).slice(0, limit);
}

// ---------- Profiles ----------

const pendingProfiles = new Set();
const requested = new Set();
let profileTimer;

db.loadProfiles()
  .then((rows) => {
    profiles.value = { ...Object.fromEntries(rows.map((p) => [p.pubkey, p])), ...profiles.value };
  })
  .catch(() => {});

export function requestProfiles(pubkeys) {
  for (const pk of pubkeys) if (!requested.has(pk)) pendingProfiles.add(pk);
  clearTimeout(profileTimer);
  profileTimer = setTimeout(async () => {
    const keys = [...pendingProfiles];
    pendingProfiles.clear();
    keys.forEach((k) => requested.add(k));
    for (let i = 0; i < keys.length; i += 100) {
      const found = await nostr.fetchProfiles(keys.slice(i, i + 100)).catch(() => []);
      // Also refresh rows cached before newer fields (about, website) existed.
      const fresh = found.filter((p) => {
        const cached = profiles.value[p.pubkey];
        return !cached || cached.created_at < p.created_at || !('about' in cached);
      });
      if (!fresh.length) continue;
      profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
      db.saveProfiles(fresh).catch(() => {});
    }
  }, 250);
}

export const displayName = (pk) => profiles.value[pk]?.name || nostr.shortKey(pk);

// Verified NIP-05 addresses: pubkey -> address that checked out ('' = failed). Per session.
export const nip05Verified = signal({});
const nip05Checking = new Set();
export function verifiedNip05(pk) {
  const address = profiles.value[pk]?.nip05;
  if (!address) return '';
  const known = nip05Verified.value[pk];
  if (known !== undefined && (known === '' || known === address)) return known;
  const key = `${pk}:${address}`;
  if (!nip05Checking.has(key)) {
    nip05Checking.add(key);
    nostr.verifyNip05(pk, address).then((ok) => (nip05Verified.value = { ...nip05Verified.value, [pk]: ok ? address : '' }));
  }
  return '';
}

// ---------- Direct messages ----------

const seenWraps = new Set();
const deleted = new Map(); // message id -> deleter pubkey
let queue = Promise.resolve();
let pendingRows = [];
let flushTimer;

// ---------- Edits ----------
// Like Anagram, a replacement takes the original's place and remembers every earlier
// id (prev), so reactions, quotes and deletions aimed at any version still match.

export const editTarget = (m) => m.tags?.find((t) => t[0] === 'e' && t[3] === 'edit')?.[1];
export const rootId = (m) => m.prev?.[0] ?? m.id;
const knownIds = (m) => [m.id, ...(m.prev ?? [])];

const removedById = new Map(); // deleted messages, so a later replacement can inherit their ids

function collapseEdits(thread, onMerged) {
  // A replacement whose predecessor was already deleted (the edit flow deletes it first)
  // still inherits the predecessor's id chain.
  thread = thread.map((m) => {
    const target = editTarget(m);
    if (!target || m.prev?.includes(target) || thread.some((x) => x.id === target)) return m;
    const gone = removedById.get(target);
    if (deleted.get(target) !== m.pubkey && !(gone && gone.pubkey === m.pubkey)) return m;
    const merged = { ...m, prev: nostr.uniq([...(gone?.prev ?? []), target, ...(m.prev ?? [])]), reply: m.reply ?? gone?.reply };
    onMerged?.(merged);
    return merged;
  });
  let list = thread;
  for (let pass = 0; pass < 8; pass++) {
    const byId = new Map();
    for (const m of list) for (const id of knownIds(m)) byId.set(id, m);
    const superseded = new Set();
    const replaced = new Map();
    for (const m of list) {
      const target = editTarget(m);
      const old = target && byId.get(target);
      if (!old || old === m || old.pubkey !== m.pubkey || superseded.has(old.id) || replaced.has(old.id)) continue;
      superseded.add(old.id);
      const merged = {
        ...m,
        prev: nostr.uniq([...(old.prev ?? []), old.id, ...(m.prev ?? [])]).filter((id) => id !== m.id),
        reply: m.reply ?? old.reply,
      };
      replaced.set(m.id, merged);
      onMerged?.(merged);
    }
    if (!superseded.size) break;
    list = list.filter((m) => !superseded.has(m.id)).map((m) => replaced.get(m.id) ?? m);
  }
  return list;
}

// The stored row should be the merged in-memory version (with its edit id chain).
const current = (m) => dms.value[m.peer]?.find((x) => x.id === m.id) ?? m;

function addMessages(list) {
  if (!list.length) return;
  const next = { ...dms.value };
  const touched = new Set();
  for (const m of list) {
    const thread = next[m.peer] ?? [];
    if (thread.some((x) => knownIds(x).includes(m.id))) continue;
    next[m.peer] = [...thread, m];
    touched.add(m.peer);
  }
  // Persist merged id chains so reactions to earlier versions still match after reload.
  for (const peer of touched) next[peer] = collapseEdits(next[peer].sort((a, b) => a.created_at - b.created_at), queueSave);
  dms.value = next;
}

function removeMessage(id, author) {
  for (const thread of Object.values(dms.value))
    for (const m of thread) if (m.id === id && m.pubkey === author) removedById.set(id, m);
  const next = {};
  for (const [peer, thread] of Object.entries(dms.value))
    next[peer] = thread.filter((m) => !(m.id === id && m.pubkey === author));
  dms.value = next;
}

// ---------- Reactions & deletions (shared by DMs and rooms) ----------

function addReactions(list) {
  const next = { ...reactions.value };
  let changed = false;
  for (const r of list) {
    if (deleted.get(r.id) === r.pubkey) continue;
    const current = next[r.target] ?? [];
    if (current.some((x) => x.id === r.id)) continue;
    next[r.target] = [...current, { id: r.id, pubkey: r.pubkey, emoji: r.emoji }];
    changed = true;
  }
  if (changed) reactions.value = next;
}

// Apply deletion requests; only the original author can delete.
function applyDeletions(ids, author) {
  for (const id of ids) deleted.set(id, author);
  const gone = new Set(ids);
  const next = {};
  for (const [target, list] of Object.entries(reactions.value))
    next[target] = list.filter((r) => !(gone.has(r.id) && r.pubkey === author));
  reactions.value = next;
  for (const id of ids) removeMessage(id, author);
  for (const [address, state] of Object.entries(roomState.value)) {
    for (const m of state.messages) if (gone.has(m.id) && m.pubkey === author) removedById.set(m.id, m);
    const kept = state.messages.filter((m) => !(gone.has(m.id) && m.pubkey === author));
    if (kept.length !== state.messages.length) setRoom(address, { messages: kept });
  }
}

const reactionTarget = (event) => event.tags.find((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1]))?.[1];

function queueSave(row) {
  // Late writes for an account that is no longer active (e.g. just signed out) are dropped.
  if (row.account !== me.value?.pubkey) return;
  pendingRows.push(row);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSaves, 300);
}

function flushSaves() {
  clearTimeout(flushTimer);
  const rows = pendingRows;
  pendingRows = [];
  return rows.length ? db.saveDirectMessages(rows).catch((e) => notify(`Saving messages failed: ${e.message}`)) : Promise.resolve();
}

function peerOf(rumor, self) {
  const others = nostr
    .uniq([rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])])
    .filter((pk) => pk !== self);
  if (others.length > 1) return null; // group DMs are out of scope
  return others[0] ?? self;
}

async function handleWrap(wrap) {
  const signer = me.value;
  if (!signer || seenWraps.has(wrap.id)) return;
  seenWraps.add(wrap.id);
  if (await db.hasWrap(signer.pubkey, wrap.id).catch(() => false)) return;
  let rumor;
  try {
    rumor = await nostr.unwrap(signer, wrap);
  } catch (e) {
    // Bad data is final; signer trouble (locked extension, bunker timeout) retries next session.
    if (e.permanent) markWrapDone(signer.pubkey, wrap.id);
    else db.markWrapFailure(signer.pubkey, wrap.id).catch(() => {});
    return;
  }
  if (me.value !== signer) return;
  const peer = peerOf(rumor, signer.pubkey);
  if (peer && rumor.kind === 5) {
    const ids = rumor.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    applyDeletions(ids, rumor.pubkey);
    for (const id of ids) queueSave({ account: signer.pubkey, id, deletedBy: rumor.pubkey });
  } else if (peer && rumor.kind === 7 && reactionTarget(rumor)) {
    const r = { account: signer.pubkey, id: rumor.id, peer, pubkey: rumor.pubkey, kind: 7, target: reactionTarget(rumor), emoji: nostr.normalizeEmoji(rumor.content), created_at: rumor.created_at };
    batchIncoming({ reaction: r });
    queueSave(r);
  } else if (peer && (rumor.kind === 14 || rumor.kind === 15) && rumor.content) {
    if (deleted.get(rumor.id) !== rumor.pubkey) {
      const reply = rumor.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1];
      const edited = nostr.isEdited(rumor.tags);
      const m = {
        account: signer.pubkey,
        id: rumor.id,
        peer,
        pubkey: rumor.pubkey,
        created_at: rumor.created_at,
        kind: rumor.kind,
        content: rumor.content,
        tags: rumor.tags,
        reply,
        edited,
      };
      batchIncoming({ message: m });
      requestProfiles([peer]);
      if (!edited) emitIncoming({ peer }, m);
    }
  }
  markWrapDone(signer.pubkey, wrap.id);
}

// Decrypted gift wraps are applied in batches: one state update (copy, sort, edit merge)
// per burst instead of per message, which matters when syncing thousands of DMs.
let incoming = { messages: [], reactions: [] };
let incomingTimer;
function batchIncoming({ message, reaction }) {
  if (message) incoming.messages.push(message);
  if (reaction) incoming.reactions.push(reaction);
  incomingTimer ??= setTimeout(flushIncoming, 30);
}
function flushIncoming() {
  incomingTimer = undefined;
  const { messages, reactions: rs } = incoming;
  incoming = { messages: [], reactions: [] };
  const live = messages.filter((m) => deleted.get(m.id) !== m.pubkey);
  batch(() => {
    addMessages(live);
    addReactions(rs);
  });
  for (const m of live) queueSave(current(m));
}

let doneWraps = [];
let doneTimer;
function markWrapDone(account, id) {
  doneWraps.push(id);
  // Only mark wraps done after their messages are on disk, or a reload in between loses them.
  doneTimer ??= setTimeout(() => {
    doneTimer = undefined;
    const ids = doneWraps;
    doneWraps = [];
    flushIncoming();
    flushSaves().then(() => db.markWraps(account, ids).catch(() => {}));
  }, 300);
}

const enqueue = (wrap) => (queue = queue.then(() => handleWrap(wrap)).catch(() => {}));

async function startInbox() {
  const signer = me.value;
  const rows = await db.loadDirectMessages(signer.pubkey).catch(() => []);
  const messages = [];
  const saved = [];
  for (const r of rows) {
    if (r.deletedBy) deleted.set(r.id, r.deletedBy);
    else if (r.kind === 7) saved.push(r);
    else messages.push(r);
  }
  if (me.value !== signer) return; // switched account while loading
  addMessages(messages.filter((m) => deleted.get(m.id) !== m.pubkey));
  addReactions(saved);
  for (const m of messages) if (m.status === 'pending' && m.tags) resumePending(m);
  requestProfiles(Object.keys(dms.value));

  inboxRelays.value = await nostr.fetchInboxRelays(signer.pubkey).catch(() => []);
  if (me.value !== signer) return;
  const syncKey = `lite:sync:${signer.pubkey}`;
  const lastSync = storage.get(syncKey, 0);
  syncing.value = true;
  inboxSub = nostr.pool.subscribe(
    nostr.uniq([...inboxRelays.value, ...nostr.APP_RELAYS]),
    {
      kinds: [1059],
      '#p': [signer.pubkey],
      // Wraps are back-dated up to two days, so overlap generously.
      ...(lastSync ? { since: lastSync - 3 * 86400 } : { limit: 1000 }),
    },
    {
      onevent: enqueue,
      oneose: () =>
        queue.then(() => {
          if (me.value !== signer) return;
          flushIncoming();
          syncing.value = false;
          storage.set(syncKey, nostr.now());
        }),
    },
  );
}

// Page history from each relay on its own, with its own cursor, so a slow or sparse
// relay can't make us skip events another relay has (Anagram pages per relay too).
async function pagePerRelay(relays, filter, cursors, done, limit) {
  const pages = await Promise.all(
    relays
      .filter((r) => !done.has(r))
      .map(async (relay) => {
        const until = cursors.get(relay);
        const events = await nostr.pool
          .querySync([relay], { ...filter, limit, ...(until ? { until: until - 1 } : {}) })
          .catch(() => null);
        if (!events) return []; // relay failed: try it again next time
        if (!events.length) done.add(relay);
        else cursors.set(relay, Math.min(...events.map((e) => e.created_at)));
        return events;
      }),
  );
  return { events: pages.flat(), finished: relays.every((r) => done.has(r)) };
}

const dmCursors = new Map();
const dmDone = new Set();
export const dmHistoryDone = signal(false);

export async function loadOlderDirectMessages() {
  const signer = me.value;
  syncing.value = true;
  try {
    const relays = nostr.uniq([...(inboxRelays.value ?? []), ...nostr.APP_RELAYS]);
    const { events, finished } = await pagePerRelay(relays, { kinds: [1059], '#p': [signer.pubkey] }, dmCursors, dmDone, 500);
    if (me.value !== signer) return;
    events.forEach(enqueue);
    await queue;
    flushIncoming();
    dmHistoryDone.value = finished;
  } finally {
    syncing.value = false;
  }
}

const theirInbox = new Map(); // peer -> Promise<relays>, cached per session
const inboxOf = (peer) => {
  if (!theirInbox.has(peer)) theirInbox.set(peer, nostr.fetchInboxRelays(peer).catch(() => []));
  return theirInbox.get(peer);
};

// Optimistic sends: id -> 'sending' | 'failed'. No entry means a relay accepted it.
export const sendStatus = signal({});
const retries = new Map(); // failed id -> () => Promise that re-publishes
function setStatus(id, status) {
  const next = { ...sendStatus.value };
  if (status) next[id] = status;
  else delete next[id];
  sendStatus.value = next;
}
// onSent runs once a relay accepts (e.g. to clear the persisted 'pending' flag).
async function track(id, sending, retry, onSent) {
  setStatus(id, 'sending');
  try {
    await sending;
    retries.delete(id);
    setStatus(id, null);
    onSent?.();
  } catch (e) {
    retries.set(id, { retry, onSent });
    setStatus(id, 'failed');
    notify(`Not sent: ${e.message}`);
  }
}
export function retrySend(id) {
  const entry = retries.get(id);
  if (entry) track(id, entry.retry(), entry.retry, entry.onSent);
}

// A sent DM is stored with status 'pending' until a relay accepts it, so a reload
// mid-send shows ⚠ (with retry) instead of a false ✓.
function resumePending(m) {
  const retry = () =>
    nostr.sendRumor(me.value, m.peer, m.kind ?? 14, m.content, m.tags, inboxOf(m.peer), inboxRelays.value ?? [], m.created_at);
  retries.set(m.id, { retry, onSent: () => markSent(m) });
  setStatus(m.id, 'failed');
}
function markSent(m) {
  const { status: _, ...sent } = current(m);
  queueSave(sent);
}

export function sendDirectMessage(peer, text, reply, edit, extraTags = []) {
  const signer = me.value;
  const replyId = edit ? edit.reply : reply && rootId(reply);
  let rumor;
  // Called synchronously by sendRumor before any await, so the bubble appears instantly.
  const show = (r) => {
    rumor = r;
    const m = {
      account: signer.pubkey,
      id: r.id,
      peer,
      pubkey: signer.pubkey,
      created_at: r.created_at,
      kind: 14,
      content: text,
      reply: replyId,
      edited: !!edit,
      tags: r.tags,
    };
    addMessages([m]);
    saved = current(m);
    queueSave({ ...saved, status: 'pending' });
  };
  let saved;
  const sending = nostr.sendDirectMessage(signer, peer, text, inboxOf(peer), inboxRelays.value ?? [], replyId, edit, show, extraTags);
  // A retry re-sends the same rumor, so it can't duplicate the message.
  const retry = () =>
    nostr.sendRumor(signer, peer, 14, text, rumor.tags, inboxOf(peer), inboxRelays.value ?? [], rumor.created_at);
  track(rumor.id, sending, retry, () => markSent(saved));
  addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}

export async function publishDefaultInbox() {
  const relays = nostr.APP_RELAYS.slice(0, 3);
  await nostr.publishInboxRelays(me.value, relays);
  inboxRelays.value = relays;
}

const contactRelays = () => nostr.uniq([...(inboxRelays.value ?? []), ...nostr.APP_RELAYS]);

let contactsLoaded = null; // resolves once the contact list has been read (or failed)
let contactQueue = Promise.resolve(); // serialises list updates so concurrent adds can't overwrite each other

function loadContacts() {
  return (contactsLoaded = readContacts());
}

async function readContacts() {
  const signer = me.value;
  try {
    const list = await nostr.fetchContactList(signer, nostr.uniq([...nostr.APP_RELAYS, ...nostr.INDEXERS]));
    if (me.value !== signer) return;
    contactList = list;
    contacts.value = list.pubkeys;
    requestProfiles(list.pubkeys);
  } catch (e) {
    notify(`Could not read your contact list: ${e.message}`);
  }
}

// Anagram adds people you message to your private contact list; do the same.
function addContact(pubkey) {
  const run = contactQueue.then(() => addContactNow(pubkey));
  contactQueue = run.catch(() => {});
  return run;
}

async function addContactNow(pubkey) {
  const signer = me.value;
  await contactsLoaded;
  if (me.value !== signer || contacts.value.includes(pubkey)) return;
  // Never publish over a list we could not read: that would wipe the user's contacts.
  if (!contactList) throw new Error('your contact list has not loaded yet');
  const latest = await nostr.fetchContactList(signer, contactRelays());
  const base = latest.event && latest.event.created_at > (contactList.event?.created_at ?? 0) ? latest : contactList;
  const pubkeys = nostr.uniq([...base.pubkeys, pubkey]);
  const event = await nostr.publishContactList(signer, pubkeys, contactRelays(), base.event);
  if (me.value !== signer) return;
  contactList = { event, pubkeys };
  contacts.value = pubkeys;
}

export const conversations = computed(() => {
  const rows = Object.entries(dms.value)
    .filter(([, thread]) => thread.length)
    .map(([peer, thread]) => ({ peer, last: thread[thread.length - 1] }));
  const known = new Set(rows.map((r) => r.peer));
  for (const pk of contacts.value) if (!known.has(pk)) rows.push({ peer: pk, last: null });
  return rows.sort((a, b) => (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0));
});

// ---------- Public rooms ----------

function setRoom(address, patch) {
  const current = roomState.value[address] ?? { messages: [] };
  roomState.value = { ...roomState.value, [address]: { ...current, ...patch } };
}

// Blocked authors are dropped at the source so they never reach unread counts,
// notifications, previews or search.
const blockedIn = (address) => {
  const room = roomState.value[address]?.room;
  return (pubkey) => !!room && nostr.roomPolicy(room, pubkey) === 'blocked';
};

function addRoomMessages(address, events) {
  const isBlocked = blockedIn(address);
  events = events.filter((e) => !isBlocked(e.pubkey));
  const current = roomState.value[address]?.messages ?? [];
  const ids = new Set(current.flatMap(knownIds));
  const fresh = events.filter(
    (e) => !ids.has(e.id) && deleted.get(e.id) !== e.pubkey && nostr.validRoomMessage(e, address),
  );
  if (!fresh.length) return;
  setRoom(address, {
    messages: collapseEdits([...current, ...fresh].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))),
  });
  requestProfiles(nostr.uniq(fresh.map((e) => e.pubkey)));
  const room = roomState.value[address]?.room;
  if (room && joinedRooms.value.some((r) => r.address === address))
    for (const e of fresh) if (!editTarget(e)) emitIncoming({ room }, e);
}

function saveJoined(list) {
  joinedRooms.value = list;
  storage.set(`lite:rooms:${me.value.pubkey}`, list);
}

function roomEntry(room) {
  return { address: room.address, owner: room.owner, slug: room.slug, relays: room.relays, name: room.name, picture: room.picture };
}

function remember(room) {
  const entry = roomEntry(room);
  saveJoined([entry, ...joinedRooms.value.filter((r) => r.address !== room.address)]);
}

export async function openRoom(pointer) {
  const { address } = pointer;
  if (roomSubs.has(address) || roomState.value[address]?.loading) return;
  if (!me.value) return;
  setRoom(address, { loading: true, error: '' });
  const owner = me.value;
  let room;
  try {
    room = await nostr.fetchRoom(pointer);
  } catch (e) {
    if (me.value === owner) setRoom(address, { loading: false, error: e.message });
    return;
  }
  if (me.value !== owner) return; // switched account while loading
  // A newer room definition may block people whose messages are already loaded.
  const isBlocked = (pk) => nostr.roomPolicy(room, pk) === 'blocked';
  setRoom(address, { room, loading: false, messages: (roomState.value[address]?.messages ?? []).filter((m) => !isBlocked(m.pubkey)) });
  if (joinedRooms.value.some((r) => r.address === address)) {
    // Refresh name/picture without moving the room in the list.
    const entry = roomEntry(room);
    saveJoined(joinedRooms.value.map((r) => (r.address === address ? entry : r)));
  }
  requestProfiles([room.owner]);
  if (room.pinned)
    nostr
      .fetchEvent(nostr.uniq([...room.relays, ...nostr.APP_RELAYS]), room.pinned)
      .then((e) => e && nostr.validRoomMessage(e, address) && setRoom(address, { pinnedEvent: e }))
      .catch(() => {});
  roomSubs.set(
    address,
    nostr.pool.subscribe(
      nostr.uniq([...room.relays, ...nostr.APP_RELAYS]),
      { kinds: [9], '#a': [address], limit: 100 },
      { onevent: (e) => addRoomMessages(address, [e]) },
    ),
  );
  roomSubs.set(
    `${address}:activity`,
    nostr.pool.subscribe(
      nostr.uniq([...room.relays, ...nostr.APP_RELAYS]),
      { kinds: [5, 7], '#h': [address], limit: 500 },
      { onevent: (e) => roomActivity(address, e) },
    ),
  );
}

function roomActivity(address, event) {
  if (!event.tags.some((t) => t[0] === 'h' && t[1] === address)) return;
  if (event.kind === 7 && reactionTarget(event))
    addReactions([{ id: event.id, pubkey: event.pubkey, target: reactionTarget(event), emoji: nostr.normalizeEmoji(event.content) }]);
  else if (event.kind === 5)
    applyDeletions(event.tags.filter((t) => t[0] === 'e').map((t) => t[1]), event.pubkey);
}

// Telegram-style toggle: same emoji again removes our reaction.
export async function toggleReaction(context, message, emoji) {
  const signer = me.value;
  const mine = knownIds(message)
    .flatMap((id) => reactions.value[id] ?? [])
    .filter((r) => r.pubkey === signer.pubkey && r.emoji === emoji);
  // React to the original, as Anagram does; earlier ids map to the current version.
  message = { ...message, id: rootId(message) };
  if (context.room) {
    const room = roomState.value[context.room].room;
    if (mine.length) {
      await nostr.sendRoomDeletion(signer, room, mine.map((r) => r.id), 7);
      applyDeletions(mine.map((r) => r.id), signer.pubkey);
    } else {
      const event = await nostr.sendRoomReaction(signer, room, message, emoji);
      roomActivity(room.address, event);
    }
    return;
  }
  const peer = context.peer;
  const send = (kind, content, tags) =>
    nostr.sendRumor(signer, peer, kind, content, [['p', peer], ...tags], inboxOf(peer), inboxRelays.value ?? []);
  if (mine.length) {
    const ids = mine.map((r) => r.id);
    await send(5, '', [...ids.map((id) => ['e', id]), ['k', '7']]);
    applyDeletions(ids, signer.pubkey);
    for (const id of ids) queueSave({ account: signer.pubkey, id, deletedBy: signer.pubkey });
  } else {
    const rumor = await send(7, emoji, [['e', message.id], ['p', message.pubkey], ['k', String(message.kind ?? 14)]]);
    const r = { account: signer.pubkey, id: rumor.id, peer, pubkey: signer.pubkey, kind: 7, target: message.id, emoji, created_at: rumor.created_at };
    addReactions([r]);
    queueSave(r);
  }
}

const roomPaging = new Map(); // address -> { cursors, done }

export async function loadOlderRoomMessages(address) {
  const state = roomState.value[address];
  if (!state?.room) return;
  if (!roomPaging.has(address)) roomPaging.set(address, { cursors: new Map(), done: new Set() });
  const { cursors, done } = roomPaging.get(address);
  const relays = nostr.uniq([...state.room.relays, ...nostr.APP_RELAYS]);
  const { events, finished } = await pagePerRelay(relays, { kinds: [9], '#a': [address] }, cursors, done, 100);
  addRoomMessages(address, events);
  // Reactions and deletions for the older messages too, or deleted ones would reappear.
  const ids = nostr.uniq(events.map((e) => e.id));
  for (let i = 0; i < ids.length; i += 100) {
    const activity = await nostr.pool.querySync(relays, { kinds: [5, 7], '#e': ids.slice(i, i + 100) }).catch(() => []);
    for (const e of activity) roomActivity(address, e);
  }
  if (finished) setRoom(address, { exhausted: true });
}

export function joinRoom(room) {
  remember(room);
}

export function leaveRoom(address) {
  saveJoined(joinedRooms.value.filter((r) => r.address !== address));
  for (const key of [address, `${address}:activity`]) {
    roomSubs.get(key)?.close();
    roomSubs.delete(key);
  }
  const next = { ...roomState.value };
  delete next[address];
  roomState.value = next;
  go('');
}

export async function createRoom(input) {
  const room = await nostr.createRoom(me.value, input);
  remember(room);
  return room;
}

export async function sendRoomMessage(address, text, reply, extraTags = []) {
  const room = roomState.value[address].room;
  let onSigned;
  const signed = new Promise((resolve) => (onSigned = resolve));
  const sending = nostr.sendRoomMessage(me.value, room, text, reply, null, (e) => {
    // Signed: show it now; publishing continues in the background.
    addRoomMessages(address, [e]);
    onSigned(e);
  }, extraTags);
  // Signing is the only wait (instant for local keys). A signing error rejects here.
  const event = await Promise.race([signed, sending.then(() => signed)]);
  const relays = nostr.uniq([...room.relays, ...nostr.APP_RELAYS]);
  track(event.id, sending, () => nostr.publish(relays, event, me.value));
}

// Forward a copy like Anagram does: same text plus its NIP-92 attachments, no attribution.
export function forwardMessage(target, message) {
  const tags = (message.tags ?? []).filter((t) => t[0] === 'imeta');
  return target.room ? sendRoomMessage(target.room, message.content, null, tags) : sendDirectMessage(target.peer, message.content, null, null, tags);
}

// Delete our own message: NIP-09 request, honoured by Anagram and most clients.
export async function deleteMessage(context, message, { onlyCurrent = false } = {}) {
  const signer = me.value;
  if (message.pubkey !== signer.pubkey) throw new Error('You can only delete your own messages.');
  // Deleting removes every version of an edited message; an edit replaces only the current one (Anagram).
  const ids = onlyCurrent ? [message.id] : knownIds(message);
  if (context.room) {
    await nostr.sendRoomDeletion(signer, roomState.value[context.room].room, ids, 9);
  } else {
    const peer = context.peer;
    await nostr.sendRumor(
      signer,
      peer,
      5,
      '',
      [['p', peer], ...ids.map((id) => ['e', id]), ['k', String(message.kind ?? 14)]],
      inboxOf(peer),
      inboxRelays.value ?? [],
    );
    for (const id of ids) queueSave({ account: signer.pubkey, id, deletedBy: signer.pubkey });
  }
  applyDeletions(ids, signer.pubkey);
}

// Anagram's edit flow: delete the old version, then send a replacement at the same timestamp.
export async function editMessage(context, message, text) {
  await deleteMessage(context, message, { onlyCurrent: true });
  if (context.room) {
    const room = roomState.value[context.room].room;
    const event = await nostr.sendRoomMessage(me.value, room, text, null, message);
    addRoomMessages(context.room, [event]);
  } else {
    await sendDirectMessage(context.peer, text, null, message, (message.tags ?? []).filter((t) => t[0] === 'imeta'));
  }
}
