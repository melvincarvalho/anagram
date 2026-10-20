// Accounts: remembered signers, login/logout/switch and the teardown that stops every
// part of the store before another account starts.
import { signal, batch } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { beginSession as beginPrefs, load as loadPrefs, reset as resetPrefs, sync as syncPrefs } from './prefs.js';
import { load as loadPeople, reset as resetPeople, resetSignals as resetPeopleSignals, requestProfiles } from './people.js';
import { reset as resetMessages, resetSignals as resetMessageSignals, flushSaves } from './messages.js';
import { start as startInbox, reset as resetDms, resetSignals as resetDmSignals } from './dms.js';
import { load as loadRooms, reset as resetRooms, resetSignals as resetRoomSignals, openRoom } from './rooms.js';
import { beginSession as beginRatchet, load as loadRatchet, reset as resetRatchet, autoStart as autoStartRatchet } from './ratchet.js';
import { go, joinedRooms, me, notify, storage } from './core.js';

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
async function teardown() {
  const ndrClosed = resetRatchet();
  resetDms();
  resetPrefs();
  resetMessages();
  resetRooms();
  // Drop every relay connection (they carry the old account's AUTH) and all paging cursors.
  transport.reset();
  resetPeople();
  batch(() => {
    me.value = null;
    resetPeopleSignals();
    resetMessageSignals();
    resetDmSignals();
    resetRoomSignals();
  });
  await ndrClosed;
}

export async function switchAccount(pubkey) {
  const entry = savedAccounts().find((a) => a.pubkey === pubkey);
  if (!entry || me.value?.pubkey === pubkey) return;
  const signer = await nostr.restoreSigner(entry.saved);
  go('');
  await login(signer, true);
}

export async function login(signer, remember) {
  if (me.value) await teardown();
  addingAccount.value = false;
  beginPrefs();
  beginRatchet();
  me.value = signer;
  nostr.enableAuth(signer);
  if (remember) rememberAccount(signer);
  storage.set('lite:active', signer.pubkey);
  loadPrefs(signer);
  loadRooms(signer);
  requestProfiles([signer.pubkey]);
  for (const room of joinedRooms.value) openRoom(room);
  loadPeople(signer);
  loadRatchet(signer);
  await startInbox(signer);
  autoStartRatchet(signer);
  syncPrefs(signer);
}

export const restoring = signal(true); // true until the saved session has been looked at

export async function restoreSession() {
  try {
    return await restoreSavedSession();
  } finally {
    restoring.value = false;
  }
}

async function restoreSavedSession() {
  const list = savedAccounts();
  refreshAccounts();
  const active = storage.get('lite:active', null);
  const entry = list.find((a) => a.pubkey === active) ?? list[0];
  if (!entry) return false;
  try {
    const signer = await nostr.restoreSigner(entry.saved);
    // Fill in the pubkey for sessions migrated from the old format. Not awaited: the UI
    // renders as soon as the account is known and the inbox fills in behind it.
    login(signer, !entry.pubkey).catch((e) => notify(`Startup problem: ${e.message}`));
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
  await teardown();
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
