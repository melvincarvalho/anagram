// Shared state: the signals every part of the store writes, plus storage, the toast and
// routing. Nothing here talks to the network.
import { signal } from '@preact/signals';
import * as transport from '../transport.js';
import * as db from '../db.js';

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
export const blocked = signal([]); // pubkeys blocked via the NIP-51 mute list ('bp', Anagram)
export const clearedAt = signal({}); // peer -> time the chat was deleted on this device
export const drafts = signal({}); // chat key -> unsent text
export const readMarks = signal({}); // chat key (peer hex or room address) -> last read created_at

export const storage = {
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
  try {
    return kind ? { kind: kind === 'public' ? 'room' : kind, id: decodeURIComponent(id) } : { kind: 'home' };
  } catch {
    return { kind: 'home' }; // malformed percent-encoding in the hash
  }
}
window.addEventListener('hashchange', () => (route.value = parseRoute()));
export const go = (hash) => (location.hash = hash);

db.onOpenBlocked(() => notify('Close other nostr.chat tabs so this one can finish updating.'));

// ---------- Connection status ----------

// 'offline' (no network) | 'connecting' (no relay up) | 'updating' (syncing) | 'ok'
export const connection = signal('ok');
function updateConnection() {
  if (!me.value) return (connection.value = 'ok');
  if (!navigator.onLine) return (connection.value = 'offline');
  connection.value = !transport.up() ? 'connecting' : syncing.value ? 'updating' : 'ok';
}
addEventListener('online', updateConnection);
addEventListener('offline', updateConnection);
setInterval(updateConnection, 2000);
