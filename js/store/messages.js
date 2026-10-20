// Message plumbing shared by DMs and rooms: edit chains, deletions (author-only),
// reactions, the save queue, send status and retries, and the user actions on a message.
import { signal } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as db from '../db.js';
import { clearedAt, dms, joinedRooms, me, notify, reactions, roomState } from './core.js';
import { isHidden } from './prefs.js';
import { isBlocked } from './people.js';
import { inboxOf, sendDirectMessage } from './dms.js';
import { addRoomMessages, dropRoomMessage, roomActivity, sendRoomMessage, setRoom } from './rooms.js';
import { applyNdrEdit, markNdrQueued, ndrDeletions, ndrExpiresAt, receiveNdr, scheduleNdrExpiry, sendNdrRumor, startNdr } from './ratchet.js';

export function reset() {
  flushSaves();
  retries.clear();
  deleted.clear();
}

export function resetSignals() {
  sendStatus.value = {};
  reactions.value = {};
}

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

// Deletion requests seen, keyed by message id -> the pubkeys that asked. A deletion only
// counts when the asker is the message's author, so a stranger's kind 5 for someone
// else's id can never hide (or later resurrect) that message.
const deleted = new Map();
export const isDeleted = (id, author) => deleted.get(id)?.has(author) ?? false;
export const markDeleted = (id, author) => (deleted.get(id) ?? deleted.set(id, new Set()).get(id)).add(author);
// Tombstone rows live under their own key so they can never overwrite a message row.
export const tombstone = (account, id, author) => ({ account, id: `del:${id}:${author}`, target: id, deletedBy: author });
export const isMessageDeleted = (m) => isDeleted(m.id, m.pubkey) || (ndrDeletions.get(`${m.id}:${m.pubkey}`) ?? -1) >= m.created_at;
let pendingRows = [];
let flushTimer;

// ---------- Edits ----------
// Like Anagram, a replacement takes the original's place and remembers every earlier
// id (prev), so reactions, quotes and deletions aimed at any version still match.

export const editTarget = (m) => m.tags?.find((t) => t[0] === 'e' && t[3] === 'edit')?.[1];
export const rootId = (m) => m.prev?.[0] ?? m.id;
export const knownIds = (m) => [m.id, ...(m.prev ?? [])];

const removedById = new Map(); // deleted messages, so a later replacement can inherit their ids

export function collapseEdits(thread, onMerged) {
  // A replacement whose predecessor was already deleted (the edit flow deletes it first)
  // still inherits the predecessor's id chain.
  thread = thread.map((m) => {
    const target = editTarget(m);
    if (!target || m.prev?.includes(target) || thread.some((x) => x.id === target)) return m;
    const gone = removedById.get(target);
    if (!isDeleted(target, m.pubkey) && !(gone && gone.pubkey === m.pubkey)) return m;
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
export const current = (m) => dms.value[m.peer]?.find((x) => x.id === m.id) ?? m;

export function addMessages(list) {
  if (!list.length) return;
  const next = { ...dms.value };
  const touched = new Set();
  for (const m of list) {
    scheduleNdrExpiry(m);
    if (m.protocol === 'ndr' && m.kind !== 14 || ndrExpiresAt(m) <= nostr.now() || isMessageDeleted(m)) continue;
    if (isBlocked(m.pubkey) || isBlocked(m.peer) || m.created_at <= (clearedAt.value[m.peer] ?? 0) || isHidden(m.id)) continue;
    const thread = next[m.peer] ?? [];
    if (thread.some((x) => knownIds(x).includes(m.id))) continue;
    next[m.peer] = [...thread, applyNdrEdit(m)];
    touched.add(m.peer);
  }
  // Persist merged id chains so reactions to earlier versions still match after reload.
  for (const peer of touched) next[peer] = collapseEdits(next[peer].sort((a, b) => a.created_at - b.created_at), queueSave);
  dms.value = next;
}

export function removeMessage(id, author) {
  for (const thread of Object.values(dms.value))
    for (const m of thread) if (m.id === id && m.pubkey === author) removedById.set(id, m);
  const next = {};
  for (const [peer, thread] of Object.entries(dms.value))
    next[peer] = thread.filter((m) => !(m.id === id && m.pubkey === author));
  dms.value = next;
}

// ---------- Reactions & deletions (shared by DMs and rooms) ----------

export function addReactions(list) {
  const next = { ...reactions.value };
  let changed = false;
  for (const r of list) {
    if (isDeleted(r.id, r.pubkey)) continue;
    const current = next[r.target] ?? [];
    if (current.some((x) => x.id === r.id)) continue;
    next[r.target] = [...current, { id: r.id, pubkey: r.pubkey, emoji: r.emoji }];
    changed = true;
  }
  if (changed) reactions.value = next;
}

// Apply deletion requests; only the original author can delete.
export function applyDeletions(ids, author) {
  for (const id of ids) markDeleted(id, author);
  const gone = new Set(ids);
  const next = {};
  for (const [target, list] of Object.entries(reactions.value))
    next[target] = list.filter((r) => !(gone.has(r.id) && r.pubkey === author));
  reactions.value = next;
  for (const id of ids) removeMessage(id, author);
  for (const [address, state] of Object.entries(roomState.value)) {
    for (const m of state.messages) if (gone.has(m.id) && m.pubkey === author) removedById.set(m.id, m);
    db.deleteRoomMessages(state.messages.filter((m) => gone.has(m.id) && m.pubkey === author).map((m) => m.id)).catch(() => {});
    const kept = state.messages.filter((m) => !(gone.has(m.id) && m.pubkey === author));
    if (kept.length !== state.messages.length) setRoom(address, { messages: kept });
  }
}

export const reactionTarget = (event) => event.tags.find((t) => t[0] === 'e' && /^[a-f0-9]{64}$/.test(t[1]))?.[1];

export function queueSave(row) {
  // Late writes for an account that is no longer active (e.g. just signed out) are dropped.
  if (row.account !== me.value?.pubkey || ndrExpiresAt(row) <= nostr.now()) return;
  pendingRows.push(row);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSaves, 300);
}

export function flushSaves() {
  clearTimeout(flushTimer);
  const rows = pendingRows;
  pendingRows = [];
  return rows.length ? db.saveDirectMessages(rows).catch((e) => notify(`Saving messages failed: ${e.message}`)) : Promise.resolve();
}

// Optimistic sends: id -> 'sending' | 'failed'. No entry means a relay accepted it.
export const sendStatus = signal({});
const retries = new Map(); // failed id -> () => Promise that re-publishes
export function setStatus(id, status) {
  const next = { ...sendStatus.value };
  if (status) next[id] = status;
  else delete next[id];
  sendStatus.value = next;
}
// onSent runs once a relay accepts (e.g. to clear the persisted 'pending' flag).
export async function track(id, sending, retry, onSent) {
  setStatus(id, 'sending');
  try {
    await sending;
    retries.delete(id);
    setStatus(id, null);
    onSent?.();
  } catch (e) {
    retries.set(id, { retry, onSent });
    // partial: it reached shared relays but not the recipient's own; still worth a retry.
    setStatus(id, e.partial ? 'partial' : 'failed');
    notify(e.partial ? e.message : `Not sent: ${e.message}`);
  }
}
export function retrySend(id) {
  const message = Object.values(dms.value).flat().find((m) => m.id === id);
  if (message?.protocol === 'ndr') {
    setStatus(id, 'queued');
    startNdr().then(async (client) => {
      if (!message.ndrQueued) {
        const { id, pubkey, kind, content, tags, created_at } = message;
        await client.send(message.peer, { id, pubkey, kind, content, tags, created_at });
        await markNdrQueued(message);
      }
      await client.retry();
    }).catch((e) => { setStatus(id, 'failed'); notify(e.message); });
    return;
  }
  const entry = retries.get(id);
  if (entry) track(id, entry.retry(), entry.retry, entry.onSent);
}

// A sent DM is stored with status 'pending' until a relay accepts it, so a reload
// mid-send shows ⚠ (with retry) instead of a false ✓.
export function resumePending(m) {
  if (m.protocol === 'ndr') {
    retries.set(m.id, { retry: () => startNdr().then((c) => c.retry()) });
    setStatus(m.id, 'queued');
    return;
  }
  const retry = () =>
    nostr.sendRumor(me.value, m.peer, m.kind ?? 14, m.content, m.tags, inboxOf(m.peer), m.created_at);
  retries.set(m.id, { retry, onSent: () => markSent(m) });
  setStatus(m.id, 'failed');
}
export function markSent(m) {
  const { status: _, ...sent } = current(m);
  dms.value = { ...dms.value, [m.peer]: (dms.value[m.peer] ?? []).map((row) => row.id === m.id ? sent : row) };
  queueSave(sent);
}

// Undo a local deletion (used when publishing it failed).
function undoDeletions(ids, author, restore) {
  for (const id of ids) deleted.get(id)?.delete(author);
  restore();
}

// Telegram-style toggle: same emoji again removes our reaction. The change shows at
// once; publishing happens in the background and is rolled back if every relay refuses.
export async function toggleReaction(context, message, emoji) {
  const signer = me.value;
  const mine = knownIds(message)
    .flatMap((id) => (reactions.value[id] ?? []).map((r) => ({ ...r, target: id })))
    .filter((r) => r.pubkey === signer.pubkey && r.emoji === emoji);
  // React to the original, as Anagram does; earlier ids map to the current version.
  message = { ...message, id: rootId(message) };
  const ids = mine.map((r) => r.id);
  const fail = (what, undo) => (e) => {
    undo();
    notify(`${what} failed: ${e.message}`);
  };
  if (context.room) {
    const room = roomState.value[context.room].room;
    if (mine.length) {
      const event = await nostr.signRoomDeletion(signer, room, ids, 7);
      applyDeletions(ids, signer.pubkey);
      nostr.publish({ room }, event, signer).catch(fail('Removing reaction', () => undoDeletions(ids, signer.pubkey, () => addReactions(mine))));
    } else {
      const event = await nostr.signRoomReaction(signer, room, message, emoji);
      roomActivity(room.address, event);
      nostr.publish({ room }, event, signer).catch(fail('Reaction', () => applyDeletions([event.id], signer.pubkey)));
    }
    return;
  }
  const peer = context.peer;
  const send = (kind, content, tags, onRumor) => message.protocol === 'ndr'
    ? sendNdrRumor(peer, kind, content, [['p', peer], ...tags], onRumor)
    : nostr.sendRumor(signer, peer, kind, content, [['p', peer], ...tags], inboxOf(peer), nostr.now(), onRumor);
  if (mine.length) {
    applyDeletions(ids, signer.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, signer.pubkey));
    send(5, '', [...ids.map((id) => ['e', id]), ['k', '7']]).catch(
      fail('Removing reaction', () =>
        undoDeletions(ids, signer.pubkey, () => {
          addReactions(mine);
          for (const r of mine) queueSave({ account: signer.pubkey, peer, kind: 7, ...r });
        }),
      ),
    );
  } else {
    let added;
    send(7, emoji, [['e', message.id], ['p', message.pubkey], ['k', String(message.kind ?? 14)]], (rumor) => {
      added = { account: signer.pubkey, id: rumor.id, peer, pubkey: signer.pubkey, kind: 7, target: message.id, emoji, created_at: rumor.created_at };
      addReactions([added]);
      queueSave(added);
    }).catch(
      fail('Reaction', () => {
        if (!added) return; // NDR activation can fail before an optimistic rumor exists.
        applyDeletions([added.id], signer.pubkey);
        queueSave(tombstone(signer.pubkey, added.id, signer.pubkey));
      }),
    );
  }
}

// Forward a copy like Anagram does: same text plus its NIP-92 attachments, no attribution.
export function forwardMessage(target, message) {
  const tags = (message.tags ?? []).filter((t) => t[0] === 'imeta');
  return target.room ? sendRoomMessage(target.room, message.content, null, tags) : sendDirectMessage(target.peer, message.content, null, null, tags);
}

// Delete our own message: shown at once, NIP-09 request published in the background
// (restored with a notice if every relay refuses). Honoured by Anagram and most clients.
export async function deleteMessage(context, message, { onlyCurrent = false, background = true } = {}) {
  const signer = me.value;
  if (message.pubkey !== signer.pubkey) throw new Error('You can only delete your own messages.');
  // Deleting removes every version of an edited message; an edit replaces only the current one (Anagram).
  const ids = onlyCurrent ? [message.id] : knownIds(message);
  if (message.protocol === 'ndr') {
    // NDR mutations keep the original rumor ID and use its original transport.
    // The durable local queue returns without waiting for a relay acknowledgment.
    for (const id of ids) await sendNdrRumor(context.peer, 5, '', [['p', context.peer], ['e', id], ['k', String(message.kind ?? 14)]]);
    if (me.value !== signer) return;
    for (const id of ids) queueSave({ account: signer.pubkey, id: `ndr-delete:${signer.pubkey}:${id}`, deletedId: id, deletedBy: signer.pubkey, created_at: nostr.now() });
    applyDeletions(ids, signer.pubkey);
    return;
  }
  let publishing;
  const restore = () =>
    undoDeletions(ids, signer.pubkey, () => {
      if (context.room) addRoomMessages(context.room, [message]);
      else {
        addMessages([message]);
        queueSave(current(message));
      }
    });
  if (context.room) {
    const room = roomState.value[context.room].room;
    const event = await nostr.signRoomDeletion(signer, room, ids, 9);
    applyDeletions(ids, signer.pubkey);
    publishing = nostr.publish({ room }, event, signer);
  } else {
    const peer = context.peer;
    applyDeletions(ids, signer.pubkey);
    for (const id of ids) queueSave(tombstone(signer.pubkey, id, signer.pubkey));
    publishing = nostr.sendRumor(signer, peer, 5, '', [['p', peer], ...ids.map((id) => ['e', id]), ['k', String(message.kind ?? 14)]], inboxOf(peer));
  }
  if (!background) return publishing;
  publishing.catch((e) => {
    restore();
    notify(`Delete failed: ${e.message}`);
  });
}

// Anagram's edit flow: delete the old version, then send a replacement at the same
// timestamp. The new text shows at once with 🕓; the two events publish in order.
export async function editMessage(context, message, text) {
  const signer = me.value;
  if (message.protocol === 'ndr') {
    if (message.pubkey !== signer.pubkey) throw new Error('You can only edit your own messages.');
    const rumor = await sendNdrRumor(context.peer, 1009, text, [['p', context.peer], ['e', rootId(message)], ['k', '14']]);
    if (me.value === signer) await receiveNdr(signer, rumor, context.peer);
    return;
  }
  if (context.room) {
    const room = roomState.value[context.room].room;
    // signRoomMessage copies the edited message's q and imeta tags (Anagram's edit format).
    const replacement = await nostr.signRoomMessage(signer, room, text, null, message);
    const deletion = await nostr.signRoomDeletion(signer, room, [message.id], 9);
    applyDeletions([message.id], signer.pubkey);
    addRoomMessages(context.room, [replacement]);
    setStatus(replacement.id, 'sending');
    const publishReplacement = () => nostr.publish({ room }, replacement, signer);
    try {
      await nostr.publish({ room }, deletion, signer);
    } catch (e) {
      // Nothing changed on the relays, so undo the edit here too; the old text stays.
      dropRoomMessage(context.room, replacement.id);
      setStatus(replacement.id, null);
      undoDeletions([message.id], signer.pubkey, () => addRoomMessages(context.room, [message]));
      throw new Error(`Edit failed: ${e.message}`);
    }
    track(replacement.id, publishReplacement(), publishReplacement);
    return;
  }
  deleteMessage(context, message, { onlyCurrent: true, background: false }).catch((e) => notify(`Edit failed: ${e.message}`));
  sendDirectMessage(context.peer, text, null, message, (message.tags ?? []).filter((t) => t[0] === 'imeta'));
}
