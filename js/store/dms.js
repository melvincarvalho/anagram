// NIP-17 direct messages: the gift-wrap inbox, unwrapping, batching, history paging,
// recipient relay lookup and sending.
import { signal, batch } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as transport from '../transport.js';
import * as db from '../db.js';
import { dms, inboxRelays, me, notify, storage, syncing } from './core.js';
import { emitIncoming } from './prefs.js';
import { addContact, displayName, requestProfiles } from './people.js';
import { addMessages, addReactions, applyDeletions, current, flushSaves, isDeleted, isMessageDeleted, markDeleted, markSent, queueSave, reactionTarget, resumePending, rootId, tombstone, track } from './messages.js';
import { directPreference, directProtocol, directProtocols, historyLoaded, ndrDecided, ndrDeletions, prepareDirectProtocol, preserveCachedProtocols, rememberNdrEdit, saveDirectPreference, sendNdrMessage } from './ratchet.js';

let inboxSub = null;
const seenWraps = new Set();
let queue = Promise.resolve();

export function reset() {
  clearTimeout(incomingTimer);
  incomingTimer = undefined;
  incoming = { messages: [], reactions: [] };
  inboxSub?.close();
  inboxSub = null;
  theirInbox.clear();
  seenWraps.clear();
}

export function resetSignals() {
  dms.value = {};
  syncing.value = false;
  dmHistoryDone.value = false;
}

function peerOf(rumor, self) {
  const others = nostr
    .uniq([rumor.pubkey, ...rumor.tags.filter((t) => t[0] === 'p').map((t) => t[1])])
    .filter((pk) => pk !== self);
  if (others.length > 1) return null; // group DMs are out of scope
  return others[0] ?? self;
}

// Group DMs are dropped (3.4), but silently losing a message is worse than a notice:
// say so once per sender per session, for messages newer than this session only, so a
// first sync on a new device does not replay old group chatter as toasts.
let sessionStart = 0;
const groupNoticed = new Set();
function noticeGroupMessage(rumor) {
  if (rumor.created_at < sessionStart || rumor.pubkey === me.value?.pubkey || groupNoticed.has(rumor.pubkey)) return;
  groupNoticed.add(rumor.pubkey);
  requestProfiles([rumor.pubkey]);
  notify(`${displayName(rumor.pubkey)} sent a group message, which nostr.chat does not show yet.`);
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
  if (!peer && (rumor.kind === 14 || rumor.kind === 15)) noticeGroupMessage(rumor);
  if (peer && rumor.kind === 5) {
    const ids = rumor.tags.filter((t) => t[0] === 'e').map((t) => t[1]);
    applyDeletions(ids, rumor.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, rumor.pubkey));
  } else if (peer && rumor.kind === 7 && reactionTarget(rumor)) {
    const r = { account: signer.pubkey, id: rumor.id, peer, pubkey: rumor.pubkey, kind: 7, target: reactionTarget(rumor), emoji: nostr.normalizeEmoji(rumor.content), created_at: rumor.created_at };
    batchIncoming({ reaction: r });
    queueSave(r);
  } else if (peer && (rumor.kind === 14 || rumor.kind === 15) && rumor.content) {
    if (!isDeleted(rumor.id, rumor.pubkey)) {
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
  const live = messages.filter((m) => !isDeleted(m.id, m.pubkey));
  // A newly received conversation stays Auto, even when its first message used
  // NIP-17. Persist that preference before caching it so reload is not migration.
  for (const message of live) if (message.account === me.value?.pubkey && directProtocols.value[message.peer] === undefined)
    saveDirectPreference(message.peer, 'auto');
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

export async function start(signer) {
  sessionStart = nostr.now();
  groupNoticed.clear();
  const rows = await db.loadDirectMessages(signer.pubkey).catch(() => []);
  const messages = [];
  const saved = [];
  for (const r of rows) {
    if (r.deletedId) ndrDeletions.set(`${r.deletedId}:${r.deletedBy}`, r.created_at ?? Infinity);
    else if (r.deletedBy) markDeleted(r.target ?? r.id, r.deletedBy);
    else if (r.kind === 1009) rememberNdrEdit(r);
    else if (r.kind === 7) saved.push(r);
    else messages.push(r);
  }
  if (me.value !== signer) return; // switched account while loading
  preserveCachedProtocols(messages);
  historyLoaded();
  addMessages(messages.filter((m) => !isMessageDeleted(m)));
  addReactions(saved);
  for (const m of messages) if (m.status === 'pending' && m.tags) resumePending(m);
  requestProfiles(Object.keys(dms.value));

  inboxRelays.value = await nostr.fetchInboxRelays(signer.pubkey).catch(() => []);
  if (me.value !== signer) return;
  transport.setOwnRelays(inboxRelays.value);
  const syncKey = `lite:sync:${signer.pubkey}`;
  const lastSync = storage.get(syncKey, 0);
  syncing.value = true;
  inboxSub = transport.subscribe(
    'self',
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

export const dmHistoryDone = signal(false);

export async function loadOlderDirectMessages() {
  const signer = me.value;
  syncing.value = true;
  try {
    const { events, finished } = await transport.pageOlder('self', { kinds: [1059], '#p': [signer.pubkey] }, `dm:${signer.pubkey}`, 500);
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
// Where to deliver to someone: their NIP-17 inbox relays, else (people who never
// published kind 10050) their NIP-65 read relays, else only the shared app relays.
export const inboxOf = (peer) => {
  if (!theirInbox.has(peer))
    theirInbox.set(
      peer,
      nostr
        .fetchInboxRelays(peer)
        .then((list) => (list.length ? list : nostr.fetchReadRelays(peer)))
        .catch(() => []),
    );
  return theirInbox.get(peer);
};

export async function sendDirectMessage(peer, text, reply, edit, extraTags = []) {
  const account = me.value;
  if (!edit && directPreference(peer) === 'auto') {
    // Undecided ('ask'): discovery can only raise an offer, so don't hold the send for it.
    const prepared = prepareDirectProtocol(peer).catch(() => {});
    if (ndrDecided.value) await prepared;
  }
  if (me.value !== account) throw new Error('Account changed');
  if ((edit ? edit.protocol ?? 'nip17' : directProtocol(peer)) === 'ndr')
    return sendNdrMessage(peer, text, reply, extraTags);
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
  const sending = nostr.sendDirectMessage(signer, peer, text, inboxOf(peer), replyId, edit, show, extraTags);
  // A retry re-sends the same rumor, so it can't duplicate the message.
  const retry = () =>
    nostr.sendRumor(signer, peer, 14, text, rumor.tags, inboxOf(peer), rumor.created_at);
  track(rumor.id, sending, retry, () => markSent(saved));
  if (peer !== signer.pubkey) addContact(peer).catch((e) => notify(`Could not update contact list: ${e.message}`));
}
