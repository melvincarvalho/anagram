// Chat list: rows, pinned section, requests, account menu, search results, in-chat search.
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, ConfirmButton, RoomAvatar, Unread, fail, focusMessage, html, isDark, menuKeys, setTheme, shortTime } from './common.js';
import { Highlight, previewText, snippet } from './text.js';
const { me, route, dms, joinedRooms, roomState, syncing } = store;

// Telegram shows "Draft:" in place of the last message for chats you are not in.
function draftPreview(key, open) {
  const draft = store.drafts.value[key];
  return draft && !open ? html`<small><span class="draft">Draft:</span> ${draft.slice(0, 80)}</small>` : null;
}

// Touch long-press (450 ms, no movement) opens the row's menu; iOS Safari fires no
// contextmenu event. The click that follows a long-press is swallowed.
// State lives on the element: opening the menu re-renders the row with new handlers.
function longPress(open) {
  const st = (e) => (e.currentTarget._press ??= {});
  return {
    ontouchstart: (e) => {
      const t = e.touches[0];
      const p = st(e);
      p.start = { x: t.clientX, y: t.clientY };
      p.fired = false;
      p.timer = setTimeout(() => {
        p.fired = true;
        open({ preventDefault() {}, clientX: p.start.x, clientY: p.start.y });
      }, 450);
    },
    ontouchmove: (e) => {
      const t = e.touches[0];
      const p = st(e);
      if (p.start && (Math.abs(t.clientX - p.start.x) > 8 || Math.abs(t.clientY - p.start.y) > 8)) clearTimeout(p.timer);
    },
    ontouchend: (e) => {
      const p = st(e);
      clearTimeout(p.timer);
      if (p.fired) e.preventDefault();
    },
    ontouchcancel: (e) => clearTimeout(st(e).timer),
  };
}

function RoomItem({ room, active, onMenu }) {
  const messages = roomState.value[room.address]?.messages ?? [];
  const last = messages[messages.length - 1];
  const link = nostr.encodeRoomLink(room);
  return html`<a class=${'item' + (active ? ' on' : '')} href=${`#/room/${link}`} onContextMenu=${onMenu({ room })} ...${longPress(onMenu({ room }))}>
    <${RoomAvatar} room=${room} />
    <span class="label">
      <span class="line"><b>${room.name}</b><${ChatFlags} chatKey=${room.address} />${last && html`<time>${shortTime(last.created_at)}</time>`}</span>
      <span class="line">
        ${draftPreview(room.address, active) ??
        html`<small>${last ? `${store.displayName(last.pubkey)}: ${previewText(last.content).slice(0, 80)}` : 'Public room'}</small>`}
        ${store.unreadMentions(room.address, messages) > 0 && html`<span class="unread at" title="You were mentioned">@</span>`}
        <${Unread} count=${store.unreadCount(room.address, messages)} muted=${store.isMuted(room.address)} />
      </span>
    </span>
  </a>`;
}

function ChatItem({ peer, last, active, onMenu }) {
  return html`<a class=${'item' + (active ? ' on' : '')} href=${`#/dm/${nostr.did(peer)}`} onContextMenu=${onMenu({ peer })} ...${longPress(onMenu({ peer }))}>
    <${Avatar} pubkey=${peer} />
    <span class="label">
      <span class="line">
        <b>${peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)}</b>
        <${ChatFlags} chatKey=${peer} />
        ${last && html`<time>${shortTime(last.created_at)}</time>`}
      </span>
      <span class="line">
        ${draftPreview(peer, active) ??
        html`<small>${last ? `${last.pubkey === me.value.pubkey ? 'You: ' : ''}${previewText(last.content).slice(0, 80)}` : 'No messages yet'}</small>`}
        <${Unread} count=${store.unreadCount(peer, dms.value[peer] ?? [])} muted=${store.isMuted(peer)} />
      </span>
    </span>
  </a>`;
}

function ChatFlags({ chatKey }) {
  return html`${store.isMuted(chatKey) && html`<span class="flag" title="Muted">🔕</span>`}${store.isPinned(chatKey) &&
    html`<span class="flag" title="Pinned">📌</span>`}`;
}

// Right-click (long-press on phones) menu for a sidebar row.
function ChatMenu({ menu, onClose }) {
  const ref = useRef();
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    addEventListener('pointerdown', close, true);
    return () => removeEventListener('pointerdown', close, true);
  }, []);
  const key = menu.chat.room?.address ?? menu.chat.peer;
  const act = (fn) => () => {
    fn();
    onClose();
  };
  const messages = menu.chat.room ? roomState.value[key]?.messages ?? [] : dms.value[key] ?? [];
  return html`<div class="menu" ref=${ref} role="menu" onKeyDown=${menuKeys} style=${`left:${Math.min(menu.x, innerWidth - 200)}px;top:${Math.min(menu.y, innerHeight - 140)}px`}>
    <button role="menuitem" onClick=${act(() => store.togglePinned(key))}>📌 ${store.isPinned(key) ? 'Unpin' : 'Pin'}</button>
    <button role="menuitem" onClick=${act(() => store.toggleMuted(key))}>${store.isMuted(key) ? '🔔 Unmute' : '🔕 Mute'}</button>
    ${store.unreadCount(key, messages) > 0 &&
    html`<button role="menuitem" onClick=${act(() => store.markRead(key, messages[messages.length - 1].created_at))}>✓ Mark as read</button>`}
    ${menu.chat.peer &&
    menu.chat.peer !== me.value.pubkey &&
    html`<${ConfirmButton} role="menuitem" label="⛔ Block" confirm="Tap again to block" onConfirm=${act(() => store.toggleBlock(key).catch(fail('Block')))} />`}
    ${menu.chat.peer &&
    html`<${ConfirmButton} role="menuitem" label="🗑 Delete chat" confirm="Tap again to delete this chat" onConfirm=${act(() => {
      store.deleteChat(key);
      if (route.value.kind === 'dm' && nostr.decodePubkey(route.value.id) === key) store.go('');
    })} />`}
  </div>`;
}

function AccountMenu({ onClose }) {
  const ref = useRef();
  const list = store.accounts.value;
  useEffect(() => {
    store.requestProfiles(list.map((a) => a.pubkey));
    const close = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.sidebar header .me') && onClose();
    addEventListener('pointerdown', close, true);
    return () => removeEventListener('pointerdown', close, true);
  }, []);
  const act = (fn) => () => {
    onClose();
    fn();
  };
  return html`<div class="menu accounts" ref=${ref} role="menu" onKeyDown=${menuKeys}>
    ${list.map(
      (a) => html`<button role="menuitem" class=${a.pubkey === me.value.pubkey ? 'current' : ''}
        onClick=${act(() => store.switchAccount(a.pubkey).catch((e) => store.notify(`Could not switch: ${e.message}`)))}>
        <${Avatar} pubkey=${a.pubkey} size=${28} />
        <span class="label"><b>${store.displayName(a.pubkey)}</b><small>${a.type === 'nsec' ? 'Private key' : a.type === 'bunker' ? 'Remote signer' : 'Extension'}</small></span>
        ${a.pubkey === me.value.pubkey && html`<span class="tick">✓</span>`}
      </button>`,
    )}
    ${!list.some((a) => a.pubkey === me.value.pubkey) &&
    html`<p class="muted small pad">This account isn't remembered on this device.</p>`}
    <button role="menuitem" onClick=${act(() => (store.addingAccount.value = true))}>＋ Add account</button>
    <button role="menuitem" onClick=${act(() => setTheme(isDark() ? 'light' : 'dark'))}>${isDark() ? '☀️ Day mode' : '🌙 Night mode'}</button>
    <button role="menuitem" onClick=${act(() => store.go('#/settings'))}>⚙ Settings</button>
  </div>`;
}

export function Sidebar() {
  const r = route.value;
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  const onMenu = (chat) => (e) => {
    e.preventDefault();
    setMenu({ chat, x: e.clientX, y: e.clientY });
  };
  const activeRoom = (room) => r.kind === 'room' && r.id === nostr.encodeRoomLink(room);
  const activePeer = (peer) => r.kind === 'dm' && nostr.decodePubkey(r.id) === peer;
  const rooms = joinedRooms.value.filter((room) => match(room.name));
  const chats = store.chatList.value.filter(({ peer }) => match(peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)));
  const requests = store.requests.value.filter(({ peer }) => match(store.displayName(peer)));
  const [requestsOpen, setRequestsOpen] = useState(false);
  const pinnedKeys = store.chatPrefs.value.pinned;
  // Pinned rows keep the order they were pinned in.
  const pinned = pinnedKeys
    .map((key) => {
      const room = rooms.find((x) => x.address === key);
      if (room) return html`<${RoomItem} key=${key} room=${room} active=${activeRoom(room)} onMenu=${onMenu} />`;
      const chat = chats.find((x) => x.peer === key);
      if (chat) return html`<${ChatItem} key=${key} ...${chat} active=${activePeer(chat.peer)} onMenu=${onMenu} />`;
      return null;
    })
    .filter(Boolean);
  // One list like Telegram: rooms and DMs together, most recent activity first.
  const lastOf = (address) => roomState.value[address]?.messages.at(-1)?.created_at ?? 0;
  const rows = [
    ...rooms.filter((room) => !pinnedKeys.includes(room.address)).map((room) => ({ room, at: lastOf(room.address) })),
    ...chats.filter(({ peer }) => !pinnedKeys.includes(peer)).map((chat) => ({ chat, at: chat.last?.created_at ?? 0 })),
  ].sort((a, b) => b.at - a.at);
  return html`<aside class="sidebar">
    <header>
      <button class="me" title="Accounts" onClick=${() => setAccountsOpen(!accountsOpen)}>
        <${Avatar} pubkey=${me.value.pubkey} size=${32} />
        <span>${store.displayName(me.value.pubkey)}</span>
        <span class="caret">▾</span>
      </button>
      <a class="button" href="#/new" title="New chat or room">+</a>
    </header>
    ${accountsOpen && html`<${AccountMenu} onClose=${() => setAccountsOpen(false)} />`}
    <div class="search"><input type="search" placeholder="Search" value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
    <nav>
      ${q.length >= 2 && html`<${MessageResults} q=${q} />`}
      ${requests.length > 0 &&
      html`<h2 class="requests-head" role="button" onClick=${() => setRequestsOpen(!requestsOpen)}>
          <span class="caret">${requestsOpen ? '▾' : '▸'}</span> Requests <span class="unread">${requests.length}</span>
          <small class="muted">from people you don't know</small>
        </h2>
        ${requestsOpen && requests.map((chat) => html`<${ChatItem} key=${chat.peer} ...${chat} active=${activePeer(chat.peer)} onMenu=${onMenu} />`)}`}
      ${pinned.length > 0 && html`<h2>Pinned</h2>${pinned}`}
      <h2>${pinned.length ? 'All chats' : 'Chats'} ${syncing.value && html`<span class="spinner" title="Syncing" />`}
        ${store.totalUnread.value > 0 && html`<button class="link mark-all" title="Mark all chats as read" onClick=${store.markAllRead}>✓ Mark all read</button>`}
        <a class="add" href="#/new" title="New chat or room">+</a></h2>
      ${rows.length === 0 && !pinned.length && html`<p class="muted small pad">${q ? 'No matches.' : 'No conversations yet.'}</p>`}
      ${rows.map(({ room, chat }) =>
        room
          ? html`<${RoomItem} key=${room.address} room=${room} active=${activeRoom(room)} onMenu=${onMenu} />`
          : html`<${ChatItem} key=${chat.peer} ...${chat} active=${activePeer(chat.peer)} onMenu=${onMenu} />`,
      )}
    </nav>
    ${menu && html`<${ChatMenu} menu=${menu} onClose=${() => setMenu(null)} />`}
  </aside>`;
}

function MessageResults({ q }) {
  const hits = store.searchMessages(q);
  return html`<h2>Messages <small class="muted">${hits.length === 50 ? '50+' : hits.length}</small></h2>
    ${hits.length === 0 && html`<p class="muted small pad">No messages match.</p>`}
    ${hits.map(({ chat, m }) => {
      const href = chat.room ? `#/room/${nostr.encodeRoomLink(chat.room)}` : `#/dm/${nostr.did(chat.peer)}`;
      const title = chat.room ? chat.room.name : chat.peer === me.value.pubkey ? 'Note to self' : store.displayName(chat.peer);
      return html`<a class="item result" href=${href} onClick=${() => (focusMessage.value = m.id)}>
        ${chat.room ? html`<${RoomAvatar} room=${chat.room} />` : html`<${Avatar} pubkey=${chat.peer} />`}
        <span class="label">
          <span class="line"><b>${title}</b><time>${shortTime(m.created_at)}</time></span>
          <small>${chat.room || m.pubkey === me.value.pubkey ? `${m.pubkey === me.value.pubkey ? 'You' : store.displayName(m.pubkey)}: ` : ''}<${Highlight} text=${snippet(m.content, q)} q=${q} /></small>
        </span>
      </a>`;
    })}`;
}

// In-chat search bar: ↑/↓ or Enter step through matches, newest first.
export function ChatSearch({ messages, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef();
  useEffect(() => input.current?.focus(), []);
  const q = query.trim().toLowerCase();
  const matches = q.length >= 2 ? messages.filter((m) => m.content.toLowerCase().includes(q)).reverse() : [];
  const go = (i) => {
    if (!matches.length) return;
    const next = (i + matches.length) % matches.length;
    setIndex(next);
    focusMessage.value = matches[next].id;
  };
  useEffect(() => {
    setIndex(0);
    if (matches.length) focusMessage.value = matches[0].id;
  }, [q]);
  return html`<div class="chat-search">
    <input
      ref=${input}
      type="search"
      placeholder="Search this chat"
      value=${query}
      onInput=${(e) => setQuery(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          go(index + (e.shiftKey ? -1 : 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          go(index - 1);
        } else if (e.key === 'Escape') onClose();
      }}
    />
    <span class="muted small">${q.length < 2 ? '' : matches.length ? `${index + 1} of ${matches.length}` : 'No results'}</span>
    <button class="link" title="Older match" disabled=${!matches.length} onClick=${() => go(index + 1)}>↑</button>
    <button class="link" title="Newer match" disabled=${!matches.length} onClick=${() => go(index - 1)}>↓</button>
    <button class="link" title="Close search" onClick=${onClose}>✕</button>
  </div>`;
}
