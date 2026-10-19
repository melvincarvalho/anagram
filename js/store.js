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
export const contacts = signal([]); // pubkeys from the private contact list
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

export async function login(signer, remember) {
  me.value = signer;
  nostr.enableAuth(signer);
  if (remember) storage.set('lite:session', nostr.serializeSigner(signer));
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
  const saved = storage.get('lite:session', null);
  if (!saved) return false;
  try {
    await login(await nostr.restoreSigner(saved), false);
    return true;
  } catch (e) {
    notify(`Could not restore session: ${e.message}`);
    return false;
  }
}

export function logout() {
  inboxSub?.close();
  for (const sub of roomSubs.values()) sub.close();
  roomSubs.clear();
  storage.set('lite:session', undefined);
  seenWraps.clear();
  deleted.clear();
  oldestWrap = Infinity;
  contactList = null;
  batch(() => {
    me.value = null;
    contacts.value = [];
    reactions.value = {};
    dms.value = {};
    roomState.value = {};
    joinedRooms.value = [];
    inboxRelays.value = null;
  });
  go('');
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
      const fresh = found.filter((p) => (profiles.value[p.pubkey]?.created_at ?? 0) < p.created_at);
      if (!fresh.length) continue;
      profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
      db.saveProfiles(fresh).catch(() => {});
    }
  }, 250);
}

export const displayName = (pk) => profiles.value[pk]?.name || nostr.shortKey(pk);

// ---------- Direct messages ----------

const seenWraps = new Set();
const deleted = new Map(); // message id -> deleter pubkey
let queue = Promise.resolve();
let pendingRows = [];
let flushTimer;
let oldestWrap = Infinity;

function addMessages(list) {
  if (!list.length) return;
  const next = { ...dms.value };
  for (const m of list) {
    const thread = next[m.peer] ?? [];
    if (thread.some((x) => x.id === m.id)) continue;
    next[m.peer] = [...thread, m].sort((a, b) => a.created_at - b.created_at);
  }
  dms.value = next;
}

function removeMessage(id, author) {
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
    const kept = state.messages.filter((m) => !(gone.has(m.id) && m.pubkey === author));
    if (kept.length !== state.messages.length) setRoom(address, { messages: kept });
  }
}

const reactionTarget = (event) => event.tags.find((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1]))?.[1];

function queueSave(row) {
  pendingRows.push(row);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const rows = pendingRows;
    pendingRows = [];
    db.saveDirectMessages(rows).catch((e) => notify(`Saving messages failed: ${e.message}`));
  }, 300);
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
  oldestWrap = Math.min(oldestWrap, wrap.created_at);
  if (await db.hasWrap(signer.pubkey, wrap.id).catch(() => false)) return;
  let rumor;
  try {
    rumor = await nostr.unwrap(signer, wrap);
  } catch {
    db.markWraps(signer.pubkey, [wrap.id]).catch(() => {});
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
    addReactions([r]);
    queueSave(r);
  } else if (peer && (rumor.kind === 14 || rumor.kind === 15) && rumor.content) {
    if (deleted.get(rumor.id) !== rumor.pubkey) {
      const reply = rumor.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1];
      const m = {
        account: signer.pubkey,
        id: rumor.id,
        peer,
        pubkey: rumor.pubkey,
        created_at: rumor.created_at,
        kind: rumor.kind,
        content: rumor.content,
        reply,
      };
      addMessages([m]);
      queueSave(m);
      requestProfiles([peer]);
    }
  }
  db.markWraps(signer.pubkey, [wrap.id]).catch(() => {});
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
  addMessages(messages.filter((m) => deleted.get(m.id) !== m.pubkey));
  addReactions(saved);
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
          syncing.value = false;
          storage.set(syncKey, nostr.now());
        }),
    },
  );
}

export async function loadOlderDirectMessages() {
  const signer = me.value;
  syncing.value = true;
  const events = await nostr.pool.querySync(
    nostr.uniq([...(inboxRelays.value ?? []), ...nostr.APP_RELAYS]),
    {
      kinds: [1059],
      '#p': [signer.pubkey],
      limit: 500,
      ...(Number.isFinite(oldestWrap) ? { until: oldestWrap - 1 } : {}),
    },
  );
  events.forEach(enqueue);
  await queue;
  syncing.value = false;
  return events.length;
}

const theirInbox = new Map();

export async function sendDirectMessage(peer, text, reply) {
  const signer = me.value;
  if (!theirInbox.has(peer)) theirInbox.set(peer, await nostr.fetchInboxRelays(peer).catch(() => []));
  const rumor = await nostr.sendDirectMessage(
    signer,
    peer,
    text,
    theirInbox.get(peer),
    inboxRelays.value ?? [],
    reply?.id,
  );
  const m = { account: signer.pubkey, id: rumor.id, peer, pubkey: signer.pubkey, created_at: rumor.created_at, kind: 14, content: text, reply: reply?.id };
  addMessages([m]);
  queueSave(m);
  addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}

export async function publishDefaultInbox() {
  const relays = nostr.APP_RELAYS.slice(0, 3);
  await nostr.publishInboxRelays(me.value, relays);
  inboxRelays.value = relays;
}

const contactRelays = () => nostr.uniq([...(inboxRelays.value ?? []), ...nostr.APP_RELAYS]);

async function loadContacts() {
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
async function addContact(pubkey) {
  const signer = me.value;
  if (!contactList || contacts.value.includes(pubkey)) return;
  const latest = await nostr.fetchContactList(signer, contactRelays());
  const base = latest.event && latest.event.created_at > (contactList.event?.created_at ?? 0) ? latest : contactList;
  const pubkeys = nostr.uniq([...base.pubkeys, pubkey]);
  const event = await nostr.publishContactList(signer, pubkeys, contactRelays(), base.event);
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

function addRoomMessages(address, events) {
  const current = roomState.value[address]?.messages ?? [];
  const ids = new Set(current.map((m) => m.id));
  const fresh = events.filter(
    (e) => !ids.has(e.id) && deleted.get(e.id) !== e.pubkey && nostr.validRoomMessage(e, address),
  );
  if (!fresh.length) return;
  setRoom(address, {
    messages: [...current, ...fresh].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)),
  });
  requestProfiles(nostr.uniq(fresh.map((e) => e.pubkey)));
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
  let room;
  try {
    room = await nostr.fetchRoom(pointer);
  } catch (e) {
    setRoom(address, { loading: false, error: e.message });
    return;
  }
  setRoom(address, { room, loading: false });
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
  const mine = (reactions.value[message.id] ?? []).filter((r) => r.pubkey === signer.pubkey && r.emoji === emoji);
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
  if (!theirInbox.has(peer)) theirInbox.set(peer, await nostr.fetchInboxRelays(peer).catch(() => []));
  const send = (kind, content, tags) =>
    nostr.sendRumor(signer, peer, kind, content, [['p', peer], ...tags], theirInbox.get(peer), inboxRelays.value ?? []);
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

export async function loadOlderRoomMessages(address) {
  const state = roomState.value[address];
  if (!state?.room) return;
  const oldest = state.messages[0]?.created_at ?? nostr.now();
  const events = await nostr.pool.querySync(nostr.uniq([...state.room.relays, ...nostr.APP_RELAYS]), {
    kinds: [9],
    '#a': [address],
    until: oldest - 1,
    limit: 100,
  });
  addRoomMessages(address, events);
  if (!events.length) setRoom(address, { exhausted: true });
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

export async function sendRoomMessage(address, text, reply) {
  const room = roomState.value[address].room;
  const event = await nostr.sendRoomMessage(me.value, room, text, reply);
  addRoomMessages(address, [event]);
}
