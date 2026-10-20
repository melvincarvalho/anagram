// Public rooms (Anagram public groups): definitions, live subscriptions, history,
// reactions and deletions in rooms, and the owner tools.
import { signal } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { go, joinedRooms, me, roomState, storage } from './core.js';
import { emitIncoming, isHidden } from './prefs.js';
import { isBlocked, requestProfiles } from './people.js';
import { addReactions, applyDeletions, collapseEdits, editTarget, isDeleted, knownIds, reactionTarget, track } from './messages.js';

const roomSubs = new Map();

export function load(signer) {
  const starter = nostr.starterRoom();
  const saved = storage.get(`lite:rooms:${signer.pubkey}`, null);
  joinedRooms.value = saved ?? (starter ? [roomEntry(starter)] : []);
  if (starter && !saved) setRoom(starter.address, { room: starter });
}

export function reset() {
  for (const sub of roomSubs.values()) sub.close();
  roomSubs.clear();
}

export function resetSignals() {
  roomState.value = {};
  joinedRooms.value = [];
}

export function setRoom(address, patch) {
  const current = roomState.value[address] ?? { messages: [] };
  roomState.value = { ...roomState.value, [address]: { ...current, ...patch } };
}

// Blocked authors are dropped at the source so they never reach unread counts,
// notifications, previews or search.
const blockedIn = (address) => {
  const room = roomState.value[address]?.room;
  return (pubkey) => !!room && nostr.roomPolicy(room, pubkey) === 'blocked';
};

// Room messages are cached on the device (public signed events); saves are batched per room.
const roomSaves = new Map(); // address -> events waiting to be written
let roomSaveTimer;
function queueRoomSave(address, events) {
  roomSaves.set(address, [...(roomSaves.get(address) ?? []), ...events]);
  clearTimeout(roomSaveTimer);
  roomSaveTimer = setTimeout(() => {
    for (const [room, list] of roomSaves) db.saveRoomMessages(room, list).catch(() => {});
    roomSaves.clear();
  }, 500);
}

export function addRoomMessages(address, events, { fromCache = false } = {}) {
  const roomBlocks = blockedIn(address);
  events = events.filter((e) => !roomBlocks(e.pubkey) && !isBlocked(e.pubkey));
  const current = roomState.value[address]?.messages ?? [];
  const ids = new Set(current.flatMap(knownIds));
  const fresh = events.filter(
    (e) => !ids.has(e.id) && !isDeleted(e.id, e.pubkey) && !isHidden(e.id) && nostr.validRoomMessage(e, address),
  );
  if (!fresh.length) return;
  setRoom(address, {
    messages: collapseEdits([...current, ...fresh].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))),
  });
  if (!fromCache) queueRoomSave(address, fresh);
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
  // The signed definition is kept so the room can render before (or without) the network.
  return { address: room.address, owner: room.owner, slug: room.slug, relays: room.relays, name: room.name, picture: room.picture, event: room.event };
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
  // Show the remembered room and cached history straight away (and offline); the network fills in after.
  const remembered = joinedRooms.value.find((r) => r.address === address)?.event;
  if (remembered && !roomState.value[address]?.room)
    try {
      setRoom(address, { room: nostr.parseRoom(remembered, address) });
    } catch {}
  db.loadRoomMessages(address)
    .then((cached) => me.value === owner && addRoomMessages(address, cached, { fromCache: true }))
    .catch(() => {});
  let room;
  let stale = '';
  try {
    room = await nostr.fetchRoom(pointer);
  } catch (e) {
    if (me.value !== owner) return;
    // Keep the remembered (signed) definition and still go live; just say it couldn't refresh.
    room = roomState.value[address]?.room;
    if (!room) return setRoom(address, { loading: false, error: e.message });
    stale = e.message;
  }
  if (me.value !== owner) return; // switched account while loading
  // A newer room definition may block people whose messages are already loaded.
  const hidden = (pk) => nostr.roomPolicy(room, pk) === 'blocked' || isBlocked(pk);
  setRoom(address, { room, loading: false, stale, messages: (roomState.value[address]?.messages ?? []).filter((m) => !hidden(m.pubkey)) });
  if (joinedRooms.value.some((r) => r.address === address)) {
    // Refresh name/picture without moving the room in the list.
    const entry = roomEntry(room);
    saveJoined(joinedRooms.value.map((r) => (r.address === address ? entry : r)));
  }
  requestProfiles([room.owner]);
  if (room.pinned)
    nostr
      .fetchEvent({ room }, room.pinned)
      .then((e) => e && nostr.validRoomMessage(e, address) && setRoom(address, { pinnedEvent: e }))
      .catch(() => {});
  roomSubs.set(
    address,
    transport.subscribe(
      { room },
      { kinds: [9], '#a': [address], limit: 100 },
      { onevent: (e) => addRoomMessages(address, [e]) },
    ),
  );
  roomSubs.set(
    `${address}:activity`,
    transport.subscribe(
      { room },
      { kinds: [5, 7], '#h': [address], limit: 500 },
      { onevent: (e) => roomActivity(address, e) },
    ),
  );
}

export function roomActivity(address, event) {
  if (!event.tags.some((t) => t[0] === 'h' && t[1] === address)) return;
  if (event.kind === 7 && reactionTarget(event))
    addReactions([{ id: event.id, pubkey: event.pubkey, target: reactionTarget(event), emoji: nostr.normalizeEmoji(event.content) }]);
  else if (event.kind === 5)
    applyDeletions(event.tags.filter((t) => t[0] === 'e').map((t) => t[1]), event.pubkey);
}

export function dropRoomMessage(address, id) {
  const state = roomState.value[address];
  if (state) setRoom(address, { messages: state.messages.filter((m) => m.id !== id) });
  db.deleteRoomMessages([id]).catch(() => {});
}

// Reply targets that aren't loaded yet: fetch just that message so the quote can show.
export const quotes = signal({}); // id -> event | null (not found)
const quoteFetches = new Set();
export function fetchQuote(address, id) {
  if (quoteFetches.has(id)) return;
  quoteFetches.add(id);
  const room = roomState.value[address]?.room;
  if (!room) return;
  nostr
    .fetchEvent({ room }, id)
    .then((e) => (quotes.value = { ...quotes.value, [id]: e && nostr.validRoomMessage(e, address) ? e : null }))
    .catch(() => {});
}

// Page back through a room's history until a message is loaded (for jumping to it).
export async function loadUntil(address, id, maxPages = 10) {
  const has = () => roomState.value[address]?.messages.some((m) => m.id === id || m.prev?.includes(id));
  for (let i = 0; i < maxPages && !has() && !roomState.value[address]?.exhausted; i++) await loadOlderRoomMessages(address);
  return has();
}


export async function loadOlderRoomMessages(address) {
  const state = roomState.value[address];
  if (!state?.room) return;
  const room = state.room;
  const oldest = state.messages[0]?.created_at;
  const { events, finished } = await transport.pageOlder({ room }, { kinds: [9], '#a': [address] }, `room:${address}`, 100, oldest);
  addRoomMessages(address, events);
  // Reactions and deletions for the older messages too, or deleted ones would reappear.
  const ids = nostr.uniq(events.map((e) => e.id));
  for (let i = 0; i < ids.length; i += 100) {
    const activity = await transport.query({ room }, { kinds: [5, 7], '#e': ids.slice(i, i + 100) }).catch(() => []);
    for (const e of activity) roomActivity(address, e);
  }
  if (finished) setRoom(address, { exhausted: true });
}

export function joinRoom(room) {
  remember(room);
}

// ---------- Room owner tools ----------

// Re-sign the definition with changes and apply it locally (newest definition wins).
export async function updateRoom(address, changes) {
  const room = roomState.value[address]?.room;
  if (!room) throw new Error('Room not loaded.');
  const next = await nostr.updateRoom(me.value, room, changes);
  const hidden = (pk) => nostr.roomPolicy(next, pk) === 'blocked' || isBlocked(pk);
  const patch = { room: next, messages: (roomState.value[address]?.messages ?? []).filter((m) => !hidden(m.pubkey)) };
  if (changes.pinned !== undefined)
    patch.pinnedEvent = changes.pinned ? (roomState.value[address].messages.find((m) => m.id === changes.pinned) ?? roomState.value[address].pinnedEvent ?? null) : null;
  setRoom(address, patch);
  if (joinedRooms.value.some((r) => r.address === address)) saveJoined(joinedRooms.value.map((r) => (r.address === address ? roomEntry(next) : r)));
  return next;
}

// 'trusted' | 'blocked' | 'plain' for a member; blocking wins over trust (Anagram).
export function setMemberPolicy(address, pubkey, policy) {
  const room = roomState.value[address]?.room;
  if (!room) throw new Error('Room not loaded.');
  const trusted = room.trusted.filter((k) => k !== pubkey);
  const blocked = room.blocked.filter((k) => k !== pubkey);
  if (policy === 'trusted') trusted.push(pubkey);
  if (policy === 'blocked') blocked.push(pubkey);
  return updateRoom(address, { trusted, blocked });
}

export const pinMessage = (address, id) => updateRoom(address, { pinned: id ?? '' });

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
  sending.catch(() => {}); // publish failures are reported by track()
  const event = await Promise.race([signed, sending.then(() => signed)]);
  track(event.id, sending, () => nostr.publish({ room }, event, me.value));
}
