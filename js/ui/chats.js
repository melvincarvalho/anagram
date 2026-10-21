// The two chat views: a direct chat and a public room.
import { useState, useEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, ConfirmButton, RoomAvatar, chatSearch, copy, fail, focusMessage, html, infoOpen, useAction } from './common.js';
import { Text } from './text.js';
import { ChatSearch } from './sidebar.js';
import { MessageList, useChatActions, useMarkRead } from './messages.js';
import { Composer } from './composer.js';
import { InfoPanel, PersonInfo, RoomInfo } from './info.js';
const { me, dms, joinedRooms, roomState } = store;

export function DirectChat({ id }) {
  const peer = nostr.decodePubkey(id);
  const older = useAction();
  const messages = (peer && dms.value[peer]) || [];
  const actions = useChatActions({ peer }, messages);
  // Read position when the chat was opened (before it gets marked read).
  const [unreadAfter] = useState(() => (peer ? store.readPoint(peer) : Infinity));
  useMarkRead(peer, messages);
  useEffect(() => peer && store.requestProfiles([peer]), [peer]);
  useEffect(() => peer ? store.openDirectChat(peer) : undefined, [peer]);
  if (!peer) return html`<section class="main empty"><p class="error">Invalid contact.</p></section>`;
  return html`<section class="main" data-testid="direct-chat" data-protocol=${store.directProtocol(peer)}>
    <header class="bar">
      <a class="back" href="#">‹</a>
      <${Avatar} pubkey=${peer} size=${32} />
      <button class="title" title="Chat info" onClick=${() => (infoOpen.value = !infoOpen.value)}>
        <b>${peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)}</b>
        <small class="mono">${store.verifiedNip05(peer) ? `✓ ${store.verifiedNip05(peer)}` : nostr.shortKey(peer)}</small>
      </button>
      <button class="icon" title="Search (Ctrl+F)" aria-label="Search this chat" onClick=${() => (chatSearch.value = !chatSearch.value)}>🔍</button>
    </header>
    ${chatSearch.value && html`<${ChatSearch} messages=${messages} onClose=${() => (chatSearch.value = false)} />`}
    <${InfoPanel}><${PersonInfo} pubkey=${peer} messages=${messages} /></${InfoPanel}>
    <${MessageList}
      ...${actions.list}
      mediaAuto=${(pk) => store.contacts.value.includes(pk)}
      showNames=${false}
      messages=${messages}
      unreadAfter=${unreadAfter}
      onReachTop=${() => !older.busy && !store.dmHistoryDone.value && older.run(store.loadOlderDirectMessages)}
      header=${html`<div class="older">
        ${store.dmHistoryDone.value
          ? html`<span class="muted small">Start of history</span>`
          : html`<button class="link" disabled=${older.busy} onClick=${() => older.run(store.loadOlderDirectMessages)}>
              ${older.busy ? 'Loading…' : 'Load older messages'}
            </button>`}
      </div>`}
    />
    ${!store.isBlocked(peer) && !store.isKnown(peer) && messages.length > 0 &&
    html`<div class="request-bar">
      <span><b>${store.displayName(peer)}</b> isn't in your contacts. Accept to move this chat to your list.</span>
      <button class="primary" onClick=${() => store.acceptRequest(peer).catch(fail('Accept'))}>Accept</button>
      <${ConfirmButton} label="Block" confirm="Confirm block" onConfirm=${() => store.toggleBlock(peer).catch(fail('Block'))} />
    </div>`}
    ${store.ndrOffer.value === peer && peer !== me.value.pubkey && !store.isBlocked(peer) &&
    html`<div class="request-bar">
      <span><b>${store.displayName(peer)}</b> can receive double-ratchet (Iris) messages. Turning it on applies to every chat where it is available: it registers this browser as a messaging device on your account (a signed event). Devices you register later will not receive earlier messages.</span>
      <button class="primary" onClick=${() => store.acceptNdrOffer(peer)}>Turn on</button>
      <button onClick=${() => store.dismissNdrOffer(peer)}>Not now</button>
    </div>`}
    ${store.isBlocked(peer)
      ? html`<footer class="composer blocked-bar">You blocked this person.
          <button onClick=${() => store.toggleBlock(peer).catch(fail('Unblock'))}>Unblock</button></footer>`
      : html`<${Composer}
      ...${actions.composer}
      placeholder=${store.protocolChecking.value === peer ? 'Checking encryption…' : store.directProtocol(peer) === 'ndr' ? 'Double-ratchet message' : 'Encrypted message'}
      draftKey=${peer}
      mentionables=${[peer]}
      onSend=${async (text, tags) => {
        await store.sendDirectMessage(peer, text, actions.composer.replyTo, null, tags);
        actions.clearReply();
      }}
    />`}
  </section>`;
}

export function RoomChat({ id }) {
  let pointer = null;
  let invalid = '';
  try {
    pointer = nostr.decodeRoomLink(id);
  } catch (e) {
    invalid = e.message;
  }
  const older = useAction();
  const state = (pointer && roomState.value[pointer.address]) || { messages: [], loading: true };
  const actions = useChatActions({ room: pointer?.address }, state.messages);
  const [unreadAfter] = useState(() => (pointer ? store.readPoint(pointer.address) : Infinity));
  useMarkRead(pointer?.address, state.messages);
  useEffect(() => {
    if (pointer) store.openRoom(pointer);
  }, [pointer?.address]);
  if (!pointer) return html`<section class="main empty"><p class="error">${invalid}</p></section>`;
  const room = state.room;
  const joined = joinedRooms.value.some((r) => r.address === pointer.address);
  if (!room)
    return html`<section class="main empty">
      ${state.error ? html`<p class="error">${state.error}</p>` : html`<p class="muted">Loading room…</p>`}
    </section>`;
  const policy = (pk) => nostr.roomPolicy(room, pk);
  const isOwner = room.owner === me.value.pubkey;
  const fail = (what) => (e) => store.notify(`${what} failed: ${e.message}`);
  // Load older pages until the message is present, then scroll to it.
  const jumpOlder = (id) =>
    older.run(async () => {
      if (await store.loadUntil(room.address, id)) focusMessage.value = id;
      else store.notify('That message is too far back to load.');
    });
  return html`<section class="main">
    <header class="bar">
      <a class="back" href="#">‹</a>
      <${RoomAvatar} room=${room} size=${32} />
      <button class="title" title="Room info" onClick=${() => (infoOpen.value = !infoOpen.value)}>
        <b>${room.name}</b>
        <small>${room.about || `by ${store.displayName(room.owner)}`}${state.stale && html` · <span title=${state.stale}>couldn't refresh room info</span>`}</small>
      </button>
<button class="icon" title="Search (Ctrl+F)" aria-label="Search this chat" onClick=${() => (chatSearch.value = !chatSearch.value)}>🔍</button>
      <button class="wide-only" onClick=${() => copy(`${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`, 'Room link copied')}>Share</button>
      ${joined
        ? html`<button class="wide-only" onClick=${() => store.leaveRoom(room.address)}>Leave</button>`
        : html`<button class="primary" onClick=${() => store.joinRoom(room)}>Join</button>`}
    </header>
    ${chatSearch.value && html`<${ChatSearch} messages=${state.messages} onClose=${() => (chatSearch.value = false)} />`}
    <${InfoPanel}><${RoomInfo} room=${room} messages=${state.messages} /></${InfoPanel}>
    ${state.pinnedEvent &&
    policy(state.pinnedEvent.pubkey) !== 'blocked' &&
    html`<div class="pinned" role="button" title="Jump to pinned message" onClick=${() => jumpOlder(state.pinnedEvent.id)}>
      <b>Pinned</b> <span><${Text} content=${state.pinnedEvent.content} links=${policy(state.pinnedEvent.pubkey) === 'trusted'} /></span>
      ${isOwner && html`<button class="link" title="Unpin" aria-label="Unpin" onClick=${(e) => { e.stopPropagation(); store.pinMessage(room.address, null).catch(fail('Unpin')); }}>✕</button>`}
    </div>`}
    <${MessageList}
      messages=${state.messages}
      policy=${policy}
      badge=${(pk) => (pk === room.owner ? 'owner' : '')}
      unreadAfter=${unreadAfter}
      onReachTop=${() => !older.busy && !state.exhausted && older.run(() => store.loadOlderRoomMessages(room.address))}
      lookupQuote=${(id) => {
        const q = store.quotes.value[id];
        if (q === undefined) store.fetchQuote(room.address, id);
        return q ?? null;
      }}
      jumpOlder=${jumpOlder}
      onPin=${isOwner ? (m) => store.pinMessage(room.address, m?.id ?? null).catch(fail(m ? 'Pin' : 'Unpin')) : undefined}
      pinnedId=${room.pinned}
      ...${actions.list}
      header=${html`<div class="older">
        ${state.exhausted
          ? html`<span class="muted small">Start of room history</span>`
          : html`<button class="link" disabled=${older.busy} onClick=${() => older.run(() => store.loadOlderRoomMessages(room.address))}>
              ${older.busy ? 'Loading…' : 'Load older messages'}
            </button>`}
      </div>`}
    />
    ${nostr.roomPolicy(room, me.value.pubkey) === 'plain' &&
    html`<p class="composer-note muted small">Links and media you post here show as plain text until the room owner trusts you.</p>`}
    <${Composer}
      ...${actions.composer}
      mentionables=${nostr.uniq(state.messages.map((m) => m.pubkey).reverse())}
      placeholder="Public message — anyone can read this"
      draftKey=${room.address}
      maxLength=${nostr.ROOM_MAX_LENGTH}
      canUpload=${nostr.roomPolicy(room, me.value.pubkey) === 'trusted'}
      onSend=${async (text, tags) => {
        await store.sendRoomMessage(room.address, text, actions.composer.replyTo, tags);
        if (!joined) store.joinRoom(room);
        actions.clearReply();
      }}
    />
  </section>`;
}
