// Forward a message to another chat.
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, RoomAvatar, forwarding, html } from './common.js';
import { previewText } from './text.js';
const { me, joinedRooms } = store;

export function ForwardPicker() {
  const message = forwarding.value;
  const [query, setQuery] = useState('');
  const input = useRef();
  useEffect(() => {
    if (!message) return;
    setQuery('');
    input.current?.focus();
    const key = (e) => e.key === 'Escape' && (forwarding.value = null);
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [message]);
  if (!message) return null;
  const q = query.trim().toLowerCase();
  const name = (peer) => (peer === me.value.pubkey ? 'Note to self' : store.displayName(peer));
  const targets = [
    ...joinedRooms.value.map((room) => ({ room: room.address, label: room.name, avatar: html`<${RoomAvatar} room=${room} />`, public: true })),
    ...conversations.value.map(({ peer }) => ({ peer, label: name(peer), avatar: html`<${Avatar} pubkey=${peer} />` })),
  ].filter((t) => !q || t.label.toLowerCase().includes(q));
  const send = (t) => {
    forwarding.value = null;
    store.forwardMessage(t, message).catch((e) => store.notify(`Forward failed: ${e.message}`));
    const room = t.room && joinedRooms.value.find((r) => r.address === t.room);
    store.go(room ? `#/room/${nostr.encodeRoomLink(room)}` : `#/dm/${nostr.did(t.peer)}`);
  };
  return html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && (forwarding.value = null)}>
    <div class="card picker" role="dialog" aria-label="Forward message">
      <h3>Forward to…</h3>
      <p class="quote static">${previewText(message.content).slice(0, 120)}</p>
      <input ref=${input} type="search" placeholder="Search chats" value=${query} onInput=${(e) => setQuery(e.target.value)} />
      <div class="targets">
        ${targets.length === 0 && html`<p class="muted small">No chats match.</p>`}
        ${targets.map(
          (t) => html`<button class="item" onClick=${() => send(t)}>
            ${t.avatar}
            <span class="label"><b>${t.label}</b>${t.public && html`<small>Public room — anyone can read</small>`}</span>
          </button>`,
        )}
      </div>
    </div>
  </div>`;
}
