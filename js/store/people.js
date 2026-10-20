// People: profiles, did:nostr documents, NIP-05, the private contact list, blocking,
// message requests, and the account's own profile and relay lists.
import { signal, computed } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { blocked, clearedAt, contacts, dms, inboxRelays, me, notify, profiles, roomState, storage } from './core.js';
import { addMessages, isDeleted } from './messages.js';

let muteList = null; // { event, entries } once read
let muteQueue = Promise.resolve();
let contactList = null; // { event } once loaded, so we never overwrite a list we haven't read

export function load(signer) {
  loadContacts();
  loadMuteList();
  loadMyFollows(signer);
}

export function reset() {
  contactsLoaded = null;
  contactQueue = Promise.resolve();
  muteList = null;
  muteQueue = Promise.resolve();
  contactList = null;
}

export function resetSignals() {
  contacts.value = [];
  myFollows.value = [];
  accepted.value = [];
  blocked.value = [];
  clearedAt.value = {};
  inboxRelays.value = null;
}

// ---------- Message requests ----------
// A DM from someone you don't know lands in "Requests" instead of the chat list and makes
// no sound. Known: yourself, contacts, people you follow (kind 3, or nostr.social),
// anyone you have written to, and anyone you accepted.

export const myFollows = signal([]);
export const accepted = signal([]); // accepted request peers (local; Accept also adds a contact)
function loadMyFollows(signer) {
  accepted.value = storage.get(`lite:accepted:${signer.pubkey}`, []);
  followsOf(signer.pubkey).then((list) => me.value === signer && (myFollows.value = list));
}

export function isKnown(peer) {
  const mine = me.value?.pubkey;
  if (!mine || peer === mine) return true;
  if (contacts.value.includes(peer) || myFollows.value.includes(peer) || accepted.value.includes(peer)) return true;
  return (dms.value[peer] ?? []).some((m) => m.pubkey === mine);
}

export async function acceptRequest(peer) {
  accepted.value = nostr.uniq([...accepted.value, peer]);
  storage.set(`lite:accepted:${me.value.pubkey}`, accepted.value);
  await addContact(peer);
}

// ---------- Blocking & deleting chats ----------

export const isBlocked = (pk) => blocked.value.includes(pk);

async function loadMuteList() {
  const signer = me.value;
  try {
    const list = await nostr.fetchMuteList(signer);
    if (me.value !== signer) return;
    muteList = list;
    applyBlocked(nostr.uniq(list.entries.filter((t) => t[0] === 'bp').map((t) => t[1])));
  } catch (e) {
    notify(`Could not read your block list: ${e.message}`);
  }
}

// Drop a blocked person's messages everywhere they are already shown.
function applyBlocked(list) {
  const unblocked = blocked.value.filter((pk) => !list.includes(pk));
  blocked.value = list;
  const gone = new Set(list);
  const next = { ...dms.value };
  for (const pk of list) delete next[pk];
  dms.value = next;
  const rooms = {};
  for (const [address, state] of Object.entries(roomState.value))
    rooms[address] = { ...state, messages: state.messages.filter((m) => !gone.has(m.pubkey)) };
  roomState.value = rooms;
  // Unblocked: their stored conversation comes back without a reload.
  if (unblocked.length && me.value) {
    const account = me.value.pubkey;
    db.loadDirectMessages(account)
      .then((rows) => {
        if (me.value?.pubkey !== account) return;
        addMessages(rows.filter((m) => unblocked.includes(m.peer) && !m.deletedBy && m.kind !== 7 && !isDeleted(m.id, m.pubkey)));
      })
      .catch(() => {});
  }
}

export function toggleBlock(pubkey) {
  const run = muteQueue.then(async () => {
    const signer = me.value;
    // Merge into the newest list so mutes and other entries set elsewhere survive.
    const latest = await nostr.fetchMuteList(signer).catch(() => null);
    const base = latest?.event && latest.event.created_at > (muteList?.event?.created_at ?? 0) ? latest : muteList;
    if (!base && !latest) throw new Error('your block list could not be read, try again');
    const current = nostr.uniq((base?.entries ?? []).filter((t) => t[0] === 'bp').map((t) => t[1]));
    const nextList = current.includes(pubkey) ? current.filter((pk) => pk !== pubkey) : [...current, pubkey];
    muteList = await nostr.publishMuteList(signer, nextList, base ?? { event: null, entries: [] });
    if (me.value === signer) applyBlocked(nextList);
  });
  muteQueue = run.catch(() => {});
  return run;
}

// Delete a chat on this device: hide everything up to now and drop stored messages.
export async function deleteChat(peer) {
  const signer = me.value;
  clearedAt.value = { ...clearedAt.value, [peer]: nostr.now() };
  storage.set(`lite:cleared:${signer.pubkey}`, clearedAt.value);
  const next = { ...dms.value };
  delete next[peer];
  dms.value = next;
  await db.deleteConversation(signer.pubkey, peer).catch(() => {});
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
    // nostr.social answers in ~100 ms with the signed kind 0; relays follow as a fallback.
    for (const k of keys) if (!profiles.value[k]) fetchDirectoryProfile(k);
    for (let i = 0; i < keys.length; i += 100) {
      const found = await nostr.fetchProfiles(keys.slice(i, i + 100)).catch(() => []);
      // Also refresh rows cached before newer fields (about, website) existed.
      const fresh = found.filter((p) => {
        const cached = profiles.value[p.pubkey];
        // Signed relay profiles always replace the unsigned DID-document hint.
        return !cached || cached.source === 'did' || cached.created_at < p.created_at || !('about' in cached);
      });
      if (!fresh.length) continue;
      profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
      db.saveProfiles(fresh).catch(() => {});
    }
  }, 250);
}

export const displayName = (pk) => profiles.value[pk]?.name || nostr.shortKey(pk);

// Verified profiles from elsewhere (e.g. people search) go into the cache too.
export function rememberProfiles(list) {
  const fresh = list.filter((p) => {
    const cached = profiles.value[p.pubkey];
    return !cached || cached.created_at < p.created_at;
  }).map(({ followers: _, ...p }) => p);
  if (!fresh.length) return;
  profiles.value = { ...profiles.value, ...Object.fromEntries(fresh.map((p) => [p.pubkey, p])) };
  db.saveProfiles(fresh).catch(() => {});
}

const followsCache = new Map();
export function followsOf(pk) {
  if (!followsCache.has(pk)) followsCache.set(pk, nostr.fetchFollows(pk).catch(() => []));
  return followsCache.get(pk);
}

// ---------- did:nostr documents (nostr.social resolver) ----------

export const didDocs = signal({}); // pubkey -> resolved document, or { error }
const didInFlight = new Map();
let didActive = 0;
const didWaiting = [];

// Directory profile: a verified signed kind 0, stored like any relay profile.
function fetchDirectoryProfile(pk) {
  return queued(() => nostr.fetchDirectoryProfile(pk))
    .then((p) => {
      if (!p) return;
      const cached = profiles.value[pk];
      if (cached && cached.created_at >= p.created_at && cached.source !== 'did') return;
      profiles.value = { ...profiles.value, [pk]: p };
      db.saveProfiles([p]).catch(() => {});
    })
    .catch(() => {});
}

// HTTP requests to nostr.social run at most 6 at a time.
function queued(fn) {
  const ready = new Promise((resolve) => didWaiting.push(resolve));
  pumpDid();
  return ready
    .then(fn)
    .finally(() => {
      didActive--;
      pumpDid();
    });
}

// Resolve a DID document (cached per session).
export function resolveDid(pk) {
  if (didInFlight.has(pk)) return didInFlight.get(pk);
  const job = queued(() => nostr.resolveDid(pk))
    .then(
      (r) => {
        didDocs.value = { ...didDocs.value, [pk]: r };
        return r;
      },
      (e) => {
        didDocs.value = { ...didDocs.value, [pk]: { error: e.message } };
        return null;
      },
    );
  didInFlight.set(pk, job);
  return job;
}
function pumpDid() {
  while (didActive < 6 && didWaiting.length) {
    didActive++;
    didWaiting.shift()();
  }
}

// Verified NIP-05 addresses: pubkey -> address that checked out ('' = failed). Per session.
export const nip05Verified = signal({});
const nip05Checking = new Set();
// Verifying fetches https://<their domain>/.well-known/nostr.json, which tells that domain
// your IP. So it happens automatically only for people you already deal with (yourself,
// contacts, people you've messaged); for anyone else it waits for an explicit tap.
const trustedForLookup = (pk) => pk === me.value?.pubkey || contacts.value.includes(pk) || (dms.value[pk] ?? []).some((m) => m.pubkey === me.value?.pubkey);

export function verifyNip05Now(pk) {
  const address = profiles.value[pk]?.nip05;
  const key = `${pk}:${address}`;
  if (!address || nip05Checking.has(key)) return;
  nip05Checking.add(key);
  nostr.verifyNip05(pk, address).then((ok) => (nip05Verified.value = { ...nip05Verified.value, [pk]: ok ? address : '' }));
}

// The verified address, or '' (unverified, failed, or not yet checked).
export function verifiedNip05(pk) {
  const address = profiles.value[pk]?.nip05;
  if (!address) return '';
  const known = nip05Verified.value[pk];
  if (known !== undefined && (known === '' || known === address)) return known;
  if (trustedForLookup(pk)) verifyNip05Now(pk);
  return '';
}

// 'verified' | 'failed' | 'checking' | 'unchecked' | 'none' for the claimed address.
export function nip05State(pk) {
  const address = profiles.value[pk]?.nip05;
  if (!address) return { state: 'none', address: '' };
  const known = nip05Verified.value[pk];
  if (known === address) return { state: 'verified', address };
  if (known === '') return { state: 'failed', address };
  return { state: nip05Checking.has(`${pk}:${address}`) ? 'checking' : 'unchecked', address };
}

// Edit our kind 0. Fields: name, about, picture, website, nip05.
export async function saveProfile(fields, { fresh = false } = {}) {
  const signer = me.value;
  // A brand-new key has no profile yet, so skip the lookup. Otherwise never publish over a
  // profile we could not read: that would wipe fields other clients set (lud16, banner, ...).
  const previous = fresh ? null : await nostr.fetchOwnProfile(signer.pubkey);
  if (!fresh && !previous.event && Object.keys(profiles.value[signer.pubkey] ?? {}).length)
    throw new Error("Couldn't read your current profile from the network. Try again in a moment.");
  const { event, data } = await nostr.publishProfile(signer, fields, previous);
  const p = {
    pubkey: signer.pubkey,
    created_at: event.created_at,
    name: String(data.display_name || data.name || '').slice(0, 80),
    picture: /^https:\/\//.test(data.picture ?? '') ? data.picture : '',
    nip05: data.nip05 ?? '',
    about: data.about ?? '',
    website: /^https:\/\//.test(data.website ?? '') ? data.website : '',
  };
  profiles.value = { ...profiles.value, [signer.pubkey]: p };
  db.saveProfiles([p]).catch(() => {});
}

// A brand-new key: publish a name and NIP-17 inbox relays so people can find and reach it.
export async function setUpNewAccount(name) {
  await Promise.all([publishDefaultInbox(), name.trim() ? saveProfile({ name: name.trim() }, { fresh: true }) : null]);
}

export function publishDefaultInbox() {
  return saveInboxRelays(nostr.APP_RELAYS.slice(0, 3));
}

// Publish the NIP-17 inbox list (kind 10050) and, with the same relays, the NIP-65 list
// (kind 10002) so other clients and the did:nostr document see where to find us.
export async function saveInboxRelays(list) {
  const relays = nostr.uniq(list.map((r) => nostr.normalizeRelay(r)).filter(Boolean));
  if (!relays.length) throw new Error('Add at least one wss:// relay.');
  if (relays.length > 8) throw new Error('Up to 8 inbox relays.');
  const signer = me.value;
  await nostr.publishInboxRelays(signer, relays);
  nostr.publishRelayList(signer, relays).catch(() => {}); // best effort; the inbox list is what matters
  if (me.value === signer) {
    inboxRelays.value = relays;
    transport.setOwnRelays(relays);
  }
  return relays;
}

export const relayDirectory = signal(null); // suggestions from nostr.social, loaded on demand
export function loadRelayDirectory() {
  if (relayDirectory.value) return;
  nostr
    .fetchRelayDirectory()
    .then((list) => (relayDirectory.value = list))
    .catch(() => (relayDirectory.value = []));
}

let contactsLoaded = null; // resolves once the contact list has been read (or failed)
let contactQueue = Promise.resolve(); // serialises list updates so concurrent adds can't overwrite each other

function loadContacts() {
  return (contactsLoaded = readContacts());
}

async function readContacts() {
  const signer = me.value;
  try {
    const list = await nostr.fetchContactList(signer);
    if (me.value !== signer) return;
    contactList = list;
    contacts.value = list.pubkeys;
    requestProfiles(list.pubkeys);
  } catch (e) {
    notify(`Could not read your contact list: ${e.message}`);
  }
}

// Anagram adds people you message to your private contact list; do the same.
export function addContact(pubkey) {
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
  const latest = await nostr.fetchContactList(signer);
  const base = latest.event && latest.event.created_at > (contactList.event?.created_at ?? 0) ? latest : contactList;
  const pubkeys = nostr.uniq([...base.pubkeys, pubkey]);
  const event = await nostr.publishContactList(signer, pubkeys, base.event);
  if (me.value !== signer) return;
  contactList = { event, pubkeys };
  contacts.value = pubkeys;
}

export const conversations = computed(() => {
  const rows = Object.entries(dms.value)
    .filter(([, thread]) => thread.length)
    .map(([peer, thread]) => ({ peer, last: thread[thread.length - 1] }));
  const known = new Set(rows.map((r) => r.peer));
  for (const pk of contacts.value)
    if (!known.has(pk) && !isBlocked(pk) && !clearedAt.value[pk]) rows.push({ peer: pk, last: null });
  return rows.sort((a, b) => (b.last?.created_at ?? 0) - (a.last?.created_at ?? 0));
});
export const chatList = computed(() => conversations.value.filter(({ peer }) => isKnown(peer)));
export const requests = computed(() => conversations.value.filter(({ peer, last }) => last && !isKnown(peer)));
