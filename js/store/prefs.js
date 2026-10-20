// Per-account preferences: read marks, pinned/muted chats, drafts, hidden messages,
// notification policy, and the encrypted settings event that syncs them across devices.
import { signal, computed } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { chatPrefs, clearedAt, dms, drafts, joinedRooms, me, readMarks, roomState, storage } from './core.js';
import { isBlocked, isKnown } from './people.js';
import { knownIds } from './messages.js';
import { setRoom } from './rooms.js';

let liveSince = Infinity; // only messages newer than login are "new"
let readSince = 0; // messages before first use of this device count as read
let settingsSub = null;

export function beginSession() {
  liveSince = nostr.now() - 10;
}

export function load(signer) {
  readMarks.value = storage.get(`lite:read:${signer.pubkey}`, {});
  drafts.value = storage.get(`lite:drafts:${signer.pubkey}`, {});
  chatPrefs.value = { pinned: [], muted: [], ...storage.get(`lite:prefs:${signer.pubkey}`, {}) };
  prefTimes = storage.get(`lite:preftimes:${signer.pubkey}`, { pinned: {}, muted: {} });
  hidden.value = storage.get(`lite:hidden:${signer.pubkey}`, []);
  clearedAt.value = storage.get(`lite:cleared:${signer.pubkey}`, {});
  readSince = storage.get(`lite:read-since:${signer.pubkey}`, 0);
  if (!readSince) storage.set(`lite:read-since:${signer.pubkey}`, (readSince = nostr.now()));
}

export function reset() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    if (me.value) storage.set(`lite:drafts:${me.value.pubkey}`, drafts.value);
  }
  clearTimeout(settingsTimer);
  settingsTimer = 0;
  settingsLoaded = false;
  settingsSub?.close();
  settingsSub = null;
}

// ---------- Settings sync across devices ----------
// One encrypted kind 30078 (d=nostr.chat) holds read marks (max wins), pinned/muted chats
// (newest change per chat wins) and hidden messages (union). Published a few seconds after
// a change; incoming copies from other devices are merged live.

let prefTimes = { pinned: {}, muted: {} }; // chat key -> time of the last pin/mute change
let settingsEvent = null; // last seen/published event (for created_at ordering)
let settingsTimer = 0;
let settingsLoaded = false;

function settingsDoc() {
  const read = Object.entries(readMarks.value).sort((a, b) => b[1] - a[1]).slice(0, 400);
  const lists = {};
  for (const list of ['pinned', 'muted'])
    lists[list] = Object.fromEntries(Object.entries(prefTimes[list]).map(([key, at]) => [key, { on: chatPrefs.value[list].includes(key), at }]));
  return { v: 1, read: Object.fromEntries(read), ...lists, hidden: hidden.value.slice(-500) };
}

// Merge another device's copy into local state. Returns true if anything changed here.
function mergeSettings(data) {
  let changed = false;
  const read = { ...readMarks.value };
  for (const [key, ts] of Object.entries(data.read ?? {}))
    if (typeof ts === 'number' && ts > (read[key] ?? 0)) (read[key] = ts), (changed = true);
  if (changed) {
    readMarks.value = read;
    storage.set(`lite:read:${me.value.pubkey}`, read);
  }
  const prefs = { ...chatPrefs.value };
  for (const list of ['pinned', 'muted'])
    for (const [key, entry] of Object.entries(data[list] ?? {})) {
      if (!entry || typeof entry.at !== 'number' || entry.at <= (prefTimes[list][key] ?? 0)) continue;
      prefTimes[list][key] = entry.at;
      const has = prefs[list].includes(key);
      if (entry.on && !has) prefs[list] = [...prefs[list], key];
      if (!entry.on && has) prefs[list] = prefs[list].filter((k) => k !== key);
      changed = true;
    }
  if (prefs !== chatPrefs.value) {
    chatPrefs.value = prefs;
    storage.set(`lite:prefs:${me.value.pubkey}`, prefs);
    storage.set(`lite:preftimes:${me.value.pubkey}`, prefTimes);
  }
  const extra = (data.hidden ?? []).filter((id) => typeof id === 'string' && !hidden.value.includes(id));
  if (extra.length) {
    hidden.value = [...hidden.value, ...extra];
    storage.set(`lite:hidden:${me.value.pubkey}`, hidden.value);
    for (const id of extra) dropEverywhere(id);
    changed = true;
  }
  return changed;
}


export async function sync(signer) {
  settingsLoaded = false;
  settingsEvent = null;
  try {
    const found = await nostr.fetchSettings(signer);
    if (me.value !== signer) return;
    if (found) {
      settingsEvent = found.event;
      mergeSettings(found.data);
    }
  } catch {}
  settingsLoaded = true;
  settingsSub = transport.subscribe('self', { kinds: [30078], authors: [signer.pubkey], '#d': [nostr.SETTINGS_D], since: nostr.now() }, {
    onevent: async (event) => {
      if (me.value !== signer || event.created_at <= (settingsEvent?.created_at ?? 0)) return;
      const parsed = await nostr.parseSettings(signer, event);
      if (!parsed || me.value !== signer) return;
      settingsEvent = event;
      mergeSettings(parsed.data);
    },
  });
}

function scheduleSettingsPublish() {
  if (!me.value || !settingsLoaded) return; // never publish over a copy we haven't read yet
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(publishSettingsNow, 4000);
}

async function publishSettingsNow() {
  const signer = me.value;
  if (!signer || !settingsLoaded) return;
  try {
    const event = await nostr.publishSettings(signer, settingsDoc(), settingsEvent);
    if (me.value === signer) settingsEvent = event;
  } catch {}
}

// Flush a pending publish when the tab goes to the background.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && settingsTimer) {
    clearTimeout(settingsTimer);
    settingsTimer = 0;
    publishSettingsNow();
  }
});

// ---------- Delete for me ----------
// Hides a message on your devices only (no NIP-09); synced through the settings event.

export const hidden = signal([]);
export const isHidden = (id) => hidden.value.includes(id);

function dropEverywhere(id) {
  const next = {};
  let touched = false;
  for (const [peer, thread] of Object.entries(dms.value)) {
    const kept = thread.filter((m) => m.id !== id && !m.prev?.includes(id));
    if (kept.length !== thread.length) touched = true;
    next[peer] = kept;
  }
  if (touched) dms.value = next;
  for (const [address, state] of Object.entries(roomState.value))
    if (state.messages.some((m) => m.id === id)) setRoom(address, { messages: state.messages.filter((m) => m.id !== id) });
  db.deleteRoomMessages([id]).catch(() => {});
}

export function hideMessage(message) {
  if (!me.value || isHidden(message.id)) return;
  hidden.value = [...hidden.value, ...knownIds(message)];
  storage.set(`lite:hidden:${me.value.pubkey}`, hidden.value);
  for (const id of knownIds(message)) dropEverywhere(id);
  scheduleSettingsPublish();
}

// ---------- Pinned & muted chats ----------

export const isPinned = (key) => chatPrefs.value.pinned.includes(key);
export const isMuted = (key) => chatPrefs.value.muted.includes(key);

function togglePref(list, key) {
  const current = chatPrefs.value[list];
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  chatPrefs.value = { ...chatPrefs.value, [list]: next };
  storage.set(`lite:prefs:${me.value.pubkey}`, chatPrefs.value);
  prefTimes[list][key] = nostr.now();
  storage.set(`lite:preftimes:${me.value.pubkey}`, prefTimes);
  scheduleSettingsPublish();
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
  scheduleSettingsPublish();
}

// Everything after this time counts as unread in a chat.
export const readPoint = (key) => Math.max(readMarks.value[key] ?? 0, readSince);

export function unreadCount(key, messages) {
  const since = readPoint(key);
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].created_at > since; i--)
    if (messages[i].pubkey !== me.value?.pubkey) n++;
  return n;
}

// Unread messages in a chat that @mention you or reply to you (for the @ badge).
export function unreadMentions(key, messages) {
  const since = readPoint(key);
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].created_at > since; i--)
    if (messages[i].pubkey !== me.value?.pubkey && mentionsMe(messages[i])) n++;
  return n;
}

export function markAllRead() {
  const next = { ...readMarks.value };
  for (const [peer, thread] of Object.entries(dms.value)) if (thread.length) next[peer] = thread.at(-1).created_at;
  for (const room of joinedRooms.value) {
    const last = roomState.value[room.address]?.messages.at(-1);
    if (last) next[room.address] = last.created_at;
  }
  readMarks.value = next;
  storage.set(`lite:read:${me.value.pubkey}`, next);
  scheduleSettingsPublish();
}

export const totalUnread = computed(() => {
  if (!me.value) return 0;
  let n = 0;
  // Muted chats keep their own badge but stay out of the total, like Telegram.
  // Requests from strangers don't count either; they have their own section.
  for (const [peer, thread] of Object.entries(dms.value)) if (!isMuted(peer) && isKnown(peer)) n += unreadCount(peer, thread);
  for (const room of joinedRooms.value)
    if (!isMuted(room.address)) n += unreadCount(room.address, roomState.value[room.address]?.messages ?? []);
  return n;
});

// ---------- Incoming-message notifications ----------

const incomingListeners = new Set();
export const onIncoming = (fn) => (incomingListeners.add(fn), () => incomingListeners.delete(fn));

export const notifySettings = signal(storage.get('lite:notify', { dms: true, rooms: 'mentions', sound: true }));
export function setNotifySettings(patch) {
  notifySettings.value = { ...notifySettings.value, ...patch };
  storage.set('lite:notify', notifySettings.value);
}

// True when a room message @mentions us or replies to one of our messages.
export function mentionsMe(event) {
  const pk = me.value?.pubkey;
  if (!pk) return false;
  if (event.tags.some((t) => (t[0] === 'p' || t[0] === 'q') && (t[1] === pk || t[3] === pk))) return true;
  if (event.content.includes(nostr.did(pk)) || event.content.includes(nostr.npub(pk))) return true;
  return /nostr:nprofile1/.test(event.content) && (event.content.match(/nprofile1[02-9ac-hj-np-z]+/g) ?? []).some((p) => nostr.decodePubkey(p) === pk);
}

export function emitIncoming(chat, message) {
  if (!me.value || message.pubkey === me.value.pubkey || message.created_at < liveSince || isBlocked(message.pubkey)) return;
  const settings = notifySettings.value;
  if (isMuted(chat.peer ?? chat.room.address)) return;
  if (chat.peer && (!settings.dms || !isKnown(chat.peer))) return;
  if (chat.room && (settings.rooms === 'off' || (settings.rooms === 'mentions' && !mentionsMe(message)))) return;
  for (const fn of incomingListeners) fn(chat, message);
}
