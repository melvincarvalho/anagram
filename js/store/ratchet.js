// Optional double-ratchet DMs (Iris-compatible): discovery, the ask/on/off modes,
// device registration, and sending/receiving over a session.
import { signal, computed } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { watchNdrCapability } from '../ndr-discovery.js';
import { clearedAt, dms, me, notify, storage } from './core.js';
import { emitIncoming, isHidden } from './prefs.js';
import { addContact, isBlocked, requestProfiles } from './people.js';
import { addMessages, addReactions, applyDeletions, current, isMessageDeleted, markSent, reactionTarget, removeMessage, rootId, setStatus } from './messages.js';

export function beginSession() {
  historyReady = new Promise((resolve) => { resolveHistory = resolve; });
}

export function load(signer) {
  directProtocols.value = storage.get(`lite:protocols:${signer.pubkey}`, {});
  autoProtocols.value = storage.get(`lite:auto-protocols:${signer.pubkey}`, {});
  // Unset = "ask me": discovery runs, but the first compatible peer brings up an offer
  // instead of silently registering this browser as a device.
  const ndrSetting = storage.get(`lite:prefer-ndr:${signer.pubkey}`); // 'ask' | 'on' | 'off'; true/false from earlier builds
  applyDoubleRatchetMode(
    ndrSetting === true ? 'on' : ndrSetting === false ? 'off' : ['ask', 'on', 'off'].includes(ndrSetting) ? ndrSetting
      : storage.get(`lite:ndr:${signer.pubkey}`, false) ? 'on' : 'ask', // already activated before the offer existed
  );
  for (const peer of storage.get(`lite:ndr-dismissed:${signer.pubkey}`, [])) offerDismissed.add(peer);
  ndrActivated.value = storage.get(`lite:ndr:${signer.pubkey}`, false);
}

// After the inbox is up: resume the runtime if this browser registered before.
export function autoStart(signer) {
  if (me.value === signer && ndrActivated.value)
    startNdr().catch((e) => (e.locked ? console.warn(`[ndr] ${e.message}`) : notify(`Encrypted messaging unavailable: ${e.message}`)));
}

// The cached history has been read: discovery for an open chat may begin.
export const historyLoaded = () => resolveHistory?.();

// Stop the runtime and forget every per-account ratchet state; returns when closed.
export function reset() {
  const closing = stopNdr();
  closeDirectChat();
  resolveHistory?.();
  protocolChecks.clear();
  directProtocols.value = {};
  autoProtocols.value = {};
  preferDoubleRatchet.value = true;
  ndrDecided.value = false;
  ndrOffer.value = null;
  ndrActivated.value = false;
  offerDismissed.clear();
  ndrEdits.clear();
  ndrDeletions.clear();
  for (const timer of ndrExpiryTimers.values()) clearTimeout(timer);
  ndrExpiryTimers.clear();
  return closing;
}

export const directProtocols = signal({}); // peer -> Auto or explicit override
export const preferDoubleRatchet = signal(true);
// Until the person has decided (Settings → Messaging, or the in-chat offer), a compatible
// peer only raises an offer: registering a device publishes a signed event in their name.
export const ndrDecided = signal(false);
export const ndrOffer = signal(null); // peer found compatible while undecided
export const ndrActivated = signal(false); // this browser has registered as a device for the account
const offerDismissed = new Set(); // "Not now" peers (persisted per account)
export const doubleRatchetMode = computed(() => (!ndrDecided.value ? 'ask' : preferDoubleRatchet.value ? 'on' : 'off'));
const autoProtocols = signal({}); // Auto can upgrade to NDR, never silently downgrade
export const protocolChecking = signal(null);
export const directPreference = (peer) => directProtocols.value[peer] ?? 'auto';
export const directProtocol = (peer) => directPreference(peer) === 'auto' ? autoProtocols.value[peer] ?? 'nip17' : directPreference(peer);
const protocolChecks = new Map();
let historyReady = Promise.resolve();
let resolveHistory;
let directChatPeer;
let discovery;

export function saveDirectPreference(peer, preference) {
  directProtocols.value = { ...directProtocols.value, [peer]: preference };
  storage.set(`lite:protocols:${me.value.pubkey}`, directProtocols.value);
}
function chooseAutoNdr(peer) {
  if (autoProtocols.value[peer] === 'ndr') return;
  autoProtocols.value = { ...autoProtocols.value, [peer]: 'ndr' };
  storage.set(`lite:auto-protocols:${me.value.pubkey}`, autoProtocols.value);
}
export function preserveCachedProtocols(messages) {
  // Pre-existing cached history keeps its transport until the person chooses Auto.
  for (const message of messages) if (message.peer && directProtocols.value[message.peer] === undefined)
    saveDirectPreference(message.peer, message.protocol === 'ndr' ? 'ndr' : 'nip17');
}
function stopDiscovery() {
  discovery?.close();
  discovery = null;
  protocolChecking.value = null;
}
export function closeDirectChat() {
  directChatPeer = null;
  stopDiscovery();
}
export function openDirectChat(peer) {
  closeDirectChat();
  directChatPeer = peer;
  protocolChecks.delete(peer); // Reopening can discover newly enabled devices.
  void historyReady.then(() => { if (directChatPeer === peer) return prepareDirectProtocol(peer); });
  return () => { if (directChatPeer === peer) closeDirectChat(); };
}
// 'ask' (default): look for compatible devices, offer before registering this browser.
// 'on': upgrade Auto chats as soon as a compatible device is found. 'off': never look.
function applyDoubleRatchetMode(mode) {
  ndrDecided.value = mode !== 'ask';
  preferDoubleRatchet.value = mode !== 'off';
}
const persistDoubleRatchetMode = () => storage.set(`lite:prefer-ndr:${me.value.pubkey}`, doubleRatchetMode.value);
export function setDoubleRatchetMode(mode) {
  if (!['ask', 'on', 'off'].includes(mode)) throw new Error('Unknown double-ratchet setting');
  applyDoubleRatchetMode(mode);
  persistDoubleRatchetMode();
  ndrOffer.value = null;
  offerDismissed.clear();
  storage.set(`lite:ndr-dismissed:${me.value.pubkey}`, undefined);
  protocolChecks.clear();
  stopDiscovery();
  if (directChatPeer) void prepareDirectProtocol(directChatPeer);
}
export const setPreferDoubleRatchet = (enabled) => setDoubleRatchetMode(enabled ? 'on' : 'off');
// "Not now" is remembered per account, so the bar does not come back every session.
export function dismissNdrOffer(peer) {
  offerDismissed.add(peer);
  storage.set(`lite:ndr-dismissed:${me.value.pubkey}`, [...offerDismissed]);
  if (ndrOffer.value === peer) ndrOffer.value = null;
}
// "Turn on" from the offer bar: account-wide 'on', and this chat upgrades at once
// rather than waiting for a second discovery round.
export function acceptNdrOffer(peer) {
  applyDoubleRatchetMode('on');
  persistDoubleRatchetMode();
  ndrOffer.value = null;
  offerDismissed.clear();
  storage.set(`lite:ndr-dismissed:${me.value.pubkey}`, undefined);
  stopDiscovery();
  if (directPreference(peer) === 'auto') chooseAutoNdr(peer);
  return startNdr().catch((e) => notify(`Encrypted messaging unavailable: ${e.message}`));
}
export async function prepareDirectProtocol(peer) {
  const account = me.value;
  await historyReady;
  if (!account || me.value !== account) return;
  if (directProtocols.value[peer] === undefined) saveDirectPreference(peer, 'auto');
  if (directPreference(peer) !== 'auto' || !preferDoubleRatchet.value || directProtocol(peer) === 'ndr') return Promise.resolve();
  if (protocolChecks.has(peer)) return protocolChecks.get(peer);
  const signer = me.value;
  const active = () => me.value === signer && directPreference(peer) === 'auto' && preferDoubleRatchet.value;
  const live = peer === directChatPeer;
  if (live) protocolChecking.value = peer;
  const watcher = watchNdrCapability({
    peer,
    subscribe: (filter, callbacks) => {
      const sub = transport.subscribe('ndr', filter, callbacks);
      return () => sub.close();
    },
    onCapability: (supported) => {
      if (!active() || !supported) return;
      if (!ndrDecided.value) {
        if (!offerDismissed.has(peer)) ndrOffer.value = peer;
        return;
      }
      chooseAutoNdr(peer);
      startNdr().catch((error) => { if (active()) notify(`Encrypted messaging unavailable: ${error.message}`); });
    },
  });
  if (live) discovery = watcher;
  const checked = watcher.initial.finally(() => {
    if (me.value === signer && discovery === watcher) protocolChecking.value = null;
    if (!live) watcher.close();
  });
  protocolChecks.set(peer, checked);
  return checked;
}
let ndrClient;
let ndrStarting;
let ndrGeneration = 0;
let releaseNdrLock;
const ndrEdits = new Map();
export const ndrDeletions = new Map();
const ndrExpiryTimers = new Map();

function stopNdr() {
  ndrGeneration++;
  const closing = ndrClient?.close();
  const starting = ndrStarting;
  ndrClient = null;
  ndrStarting = null;
  const release = releaseNdrLock;
  releaseNdrLock = null;
  // A signer approval may stay open indefinitely. The closed adapter rejects
  // late callbacks and storage writes; do not hold sign-out hostage to it.
  starting?.catch(() => {});
  return Promise.allSettled([closing]).then(() => release?.());
}

async function lockNdr(account) {
  if (!navigator.locks) throw new Error('This browser cannot safely store encrypted chats. Try an up-to-date browser.');
  return new Promise((resolve, reject) => {
    navigator.locks.request(`anagram-lite:ndr:${account}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(Object.assign(new Error('Encrypted messaging is active in another tab. Close it and try again.'), { locked: true })); return; }
      await new Promise((release) => resolve(release));
    }).catch(reject);
  });
}

export function startNdr() {
  if (ndrStarting) return ndrStarting;
  const signer = me.value;
  const generation = ndrGeneration;
  const active = () => me.value === signer && generation === ndrGeneration;
  ndrStarting = (async () => {
    const release = await lockNdr(signer.pubkey);
    if (!active()) { release(); throw new Error('Account changed'); }
    releaseNdrLock = release;
    const { createNdrClient } = await import('./ndr.js');
    if (!active()) throw new Error('Account changed');
    const client = createNdrClient({
      owner: signer.pubkey,
      storage: db.ndrStorage(signer.pubkey),
      sign: (event) => {
        if (!active()) throw new Error('Account changed');
        return signer.sign(event);
      },
      subscribe: (filter, callback) => {
        const sub = transport.subscribe('ndr', filter, { onevent: callback });
        return () => sub.close();
      },
      fetch: (filter) => transport.queryConfirmed('ndr', filter),
      publish: async (event) => {
        if (!active()) throw new Error('Account changed');
        // Registration and discovery use this same shared set. A private send
        // must not look up a peer's relay list on the account's receiving pool.
        return transport.publish('ndr', event, signer);
      },
      receive: async (event, peer) => {
        if (!active()) throw new Error('Account changed');
        await receiveNdr(signer, event, peer);
      },
      delivery: async (id, status, context) => {
        if (!active() || !id) return;
        const m = Object.values(dms.value).flat().find((m) => m.id === id);
        if (!m || context && context.recipientOwnerPubkey !== m.peer) return;
        setStatus(id, status === 'sent' ? null : 'failed');
        if (status === 'sent') {
          markSent(m);
          await db.saveDirectMessages([current(m)]);
        }
      },
    });
    ndrClient = client;
    try {
      await client.start();
      if (!active()) throw new Error('Account changed');
      storage.set(`lite:ndr:${signer.pubkey}`, true);
      ndrActivated.value = true;
      return client;
    } catch (error) {
      await client.close();
      if (active()) { ndrClient = null; ndrStarting = null; releaseNdrLock?.(); releaseNdrLock = null; }
      throw error;
    }
  })().catch((error) => {
    if (active()) { ndrStarting = null; releaseNdrLock?.(); releaseNdrLock = null; }
    throw error;
  });
  return ndrStarting;
}

window.addEventListener('online', () => ndrClient?.retry().catch(() => {}));

export async function setDirectProtocol(peer, protocol) {
  if (!['auto', 'nip17', 'ndr'].includes(protocol)) throw new Error('Unknown message encryption');
  // A failed device registration must not undo the user's encryption choice.
  saveDirectPreference(peer, protocol);
  if (protocol === 'ndr') chooseAutoNdr(peer);
  if (ndrOffer.value === peer) ndrOffer.value = null;
  protocolChecks.delete(peer);
  if (directChatPeer === peer) stopDiscovery();
  // A per-chat choice is not an account-wide one: pin the current mode so the
  // "already activated" fallback at login can't turn 'ask' into 'on'.
  if (protocol === 'ndr') persistDoubleRatchetMode();
  if (protocol === 'ndr') await startNdr();
  if (protocol === 'auto') await prepareDirectProtocol(peer);
}

export const ndrExpiresAt = (row) => row.protocol === 'ndr' ? Number(row.tags?.find((t) => t[0] === 'expiration')?.[1]) || Infinity : Infinity;
export function scheduleNdrExpiry(row) {
  const remaining = ndrExpiresAt(row) * 1000 - Date.now();
  if (!Number.isFinite(remaining) || ndrExpiryTimers.has(row.id)) return;
  if (remaining <= 0) {
    if (me.value?.pubkey === row.account) removeMessage(row.id, row.pubkey);
    db.deleteDirectMessage(row.account, row.id).catch(() => {});
    return;
  }
  ndrExpiryTimers.set(row.id, setTimeout(() => {
    ndrExpiryTimers.delete(row.id);
    scheduleNdrExpiry(row);
  }, Math.min(remaining, 2147483647)));
}

export function applyNdrEdit(message) {
  const edit = ndrEdits.get(`${message.id}:${message.pubkey}:${message.peer}`);
  return edit && edit.created_at >= message.created_at && message.protocol === 'ndr' && edit.pubkey === message.pubkey && edit.peer === message.peer
    ? { ...message, content: edit.content, edited: true } : message;
}

export function rememberNdrEdit(row) {
  const target = row.tags.find((t) => t[0] === 'e')?.[1];
  const key = `${target}:${row.pubkey}:${row.peer}`;
  const previous = ndrEdits.get(key);
  const order = (r) => `${String(r.created_at).padStart(12, '0')}:${String(r.tags.find((t) => t[0] === 'ms')?.[1] ?? r.created_at * 1000).padStart(16, '0')}:${r.id}`;
  if (!previous || order(row) > order(previous)) ndrEdits.set(key, row);
  return target;
}

export async function receiveNdr(signer, event, peer) {
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > nostr.now() + 300) return;
  if (isBlocked(peer) || event.created_at <= (clearedAt.value[peer] ?? 0)) return;
  const expiration = event.tags.find((t) => t[0] === 'expiration')?.[1];
  if (expiration !== undefined && (!Number.isSafeInteger(Number(expiration)) || Number(expiration) <= nostr.now())) return;
  const base = { ...event, account: signer.pubkey, peer, protocol: 'ndr' };
  if (event.kind === 5) {
    if (event.content !== '') return;
    const ids = event.tags.filter((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1])).map((t) => t[1]);
    // A deletion from another author must not overwrite the original cached row.
    await db.saveDirectMessages(ids.map((id) => ({ account: signer.pubkey, id: `ndr-delete:${event.pubkey}:${id}`, deletedId: id, deletedBy: event.pubkey, created_at: Math.max(event.created_at, ndrDeletions.get(`${id}:${event.pubkey}`) ?? 0) })));
    if (me.value === signer) {
      for (const id of ids) ndrDeletions.set(`${id}:${event.pubkey}`, Math.max(event.created_at, ndrDeletions.get(`${id}:${event.pubkey}`) ?? 0));
      const eligible = ids.filter((id) => !(dms.value[peer] ?? []).some((m) => m.id === id && m.created_at > event.created_at));
      applyDeletions(eligible, event.pubkey);
    }
  } else if (event.kind === 1009) {
    const targets = event.tags.filter((t) => t[0] === 'e');
    const kinds = event.tags.filter((t) => t[0] === 'k');
    const ms = event.tags.filter((t) => t[0] === 'ms');
    if (targets.length !== 1 || !/^[a-f0-9]{64}$/.test(targets[0][1]) || !event.content.trim() ||
        new TextEncoder().encode(event.content).length > 32768 || kinds.length !== 1 || kinds[0][1] !== '14' ||
        ms.length > 1 || ms.length && (!/^\d+$/.test(ms[0][1]) || !Number.isSafeInteger(Number(ms[0][1])) || Math.floor(Number(ms[0][1]) / 1000) !== event.created_at)) return;
    await db.saveDirectMessages([base]);
    if (me.value !== signer) return;
    const target = rememberNdrEdit(base);
    const thread = dms.value[peer] ?? [];
    dms.value = { ...dms.value, [peer]: thread.map((m) => m.id === target ? applyNdrEdit(m) : m) };
  } else if (event.kind === 7 && reactionTarget(event)) {
    const row = { ...base, target: reactionTarget(event), emoji: nostr.normalizeEmoji(event.content) };
    await db.saveDirectMessages([row]);
    if (me.value === signer) addReactions([row]);
  } else if (event.kind === 14 && event.content && !isMessageDeleted(base) && !isHidden(event.id)) {
    const row = { ...base, reply: event.tags.find((t) => t[0] === 'e' && (!t[3] || t[3] === 'reply'))?.[1] };
    await db.saveDirectMessages([row]);
    if (me.value !== signer) return;
    if (directProtocols.value[peer] === undefined) saveDirectPreference(peer, 'auto');
    // Under "Never", an incoming ratchet message is shown but does not pin the chat.
    if (directPreference(peer) === 'auto' && preferDoubleRatchet.value) chooseAutoNdr(peer);
    const seen = dms.value[peer]?.some((m) => m.id === row.id);
    addMessages([row]);
    requestProfiles([peer]);
    if (!seen) emitIncoming({ peer }, row);
  }
}

export async function sendNdrRumor(peer, kind, content, tags, onRumor) {
  const signer = me.value;
  const client = await startNdr();
  if (me.value !== signer) throw new Error('Account changed');
  const nowMs = Date.now();
  const event = nostr.makeRumor(signer.pubkey, kind, content, [...tags, ['ms', String(nowMs)]], Math.floor(nowMs / 1000));
  onRumor?.(event);
  await client.send(peer, event);
  return event;
}

export async function markNdrQueued(message) {
  if (message.account !== me.value?.pubkey) return;
  const row = { ...current(message), ndrQueued: true };
  dms.value = { ...dms.value, [row.peer]: (dms.value[row.peer] ?? []).map((m) => m.id === row.id ? row : m) };
  await db.saveDirectMessages([row]);
}

export async function sendNdrMessage(peer, text, reply, extraTags) {
  const signer = me.value;
  const client = await startNdr();
  if (me.value !== signer) throw new Error('Account changed');
  const nowMs = Date.now();
  const tags = [['p', peer], ['ms', String(nowMs)], ...(reply ? [['e', rootId(reply)]] : []), ...extraTags];
  const event = nostr.makeRumor(signer.pubkey, 14, text, tags, Math.floor(nowMs / 1000));
  const message = { ...event, account: signer.pubkey, peer, protocol: 'ndr', reply: reply && rootId(reply), status: 'pending' };
  // Save plaintext before handing it to the durable ratchet queue.
  await db.saveDirectMessages([message]);
  if (me.value !== signer) throw new Error('Account changed');
  addMessages([message]);
  setStatus(event.id, 'queued');
  try {
    await client.send(peer, event);
    await markNdrQueued(message);
  } catch (error) {
    setStatus(event.id, 'failed');
    throw error;
  }
  addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}
