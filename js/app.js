import { h, render, Fragment } from 'preact';
import { signal } from '@preact/signals';
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import htm from 'htm';
import * as nostr from './nostr.js';
import * as store from './store.js';
import { EMOJI_GROUPS } from './emoji.js';

const html = htm.bind(h);
const { me, route, profiles, conversations, dms, joinedRooms, roomState, inboxRelays, syncing, toast, reactions } = store;
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎'];

// ---------- Small pieces ----------

function Avatar({ pubkey, size = 36 }) {
  const picture = profiles.value[pubkey]?.picture;
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  return picture
    ? html`<img class="avatar" src=${picture} width=${size} height=${size} loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : html`<span class="avatar" style=${`width:${size}px;height:${size}px;background:hsl(${hue} 45% 45%)`}>
        ${store.displayName(pubkey).replace(/^npub1/, '').slice(0, 1).toUpperCase()}
      </span>`;
}

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

// Profile references: nostr:npub…/nprofile… (NIP-27) and did:nostr:<hex>.
const MENTION_RE = /((?:nostr:)?(?:npub1|nprofile1)[02-9ac-hj-np-z]{20,}|did:nostr:[a-f0-9]{64})/g;

function Mention({ pubkey }) {
  useEffect(() => store.requestProfiles([pubkey]), [pubkey]);
  return html`<a class="mention" href=${nostr.profileUrl(pubkey)} target="_blank" rel="noopener" title=${nostr.did(pubkey)}>@${store.displayName(pubkey)}</a>`;
}

function Mentions({ text }) {
  return text.split(MENTION_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const pubkey = nostr.decodePubkey(part);
    return pubkey ? html`<${Mention} pubkey=${pubkey} />` : part;
  });
}

function Text({ content, links = true }) {
  const parts = content.split(URL_RE);
  return parts.map((part, i) =>
    i % 2 === 0
      ? html`<${Mentions} text=${part} />`
      : links
        ? html`<a href=${part} target="_blank" rel="noopener noreferrer nofollow">${part}</a>`
        : '[link removed]',
  );
}

const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i;
const VIDEO_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;
const viewer = signal(null); // full-screen media url
const infoOpen = signal(false); // chat info panel
const forwarding = signal(null); // message being forwarded

// Theme: 'system' | 'light' | 'dark', per device. index.html applies it before first paint.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const readTheme = () => {
  try {
    return JSON.parse(localStorage.getItem('lite:theme')) ?? 'system';
  } catch {
    return 'system';
  }
};
const theme = signal(readTheme());
const isDark = () => theme.value === 'dark' || (theme.value === 'system' && darkQuery.matches);
function setTheme(value) {
  theme.value = value;
  try {
    if (value === 'system') localStorage.removeItem('lite:theme');
    else localStorage.setItem('lite:theme', JSON.stringify(value));
  } catch {}
  applyTheme();
}
function applyTheme() {
  const root = document.documentElement;
  if (theme.value === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDark() ? '#16191e' : '#ffffff');
}
darkQuery.addEventListener('change', () => theme.value === 'system' && applyTheme());
applyTheme();
const chatSearch = signal(false); // in-chat search bar open
const focusMessage = signal(null); // message id to scroll to and flash once it is rendered

function Highlight({ text, q }) {
  if (!q) return text;
  const lower = text.toLowerCase();
  const out = [];
  let i = 0;
  for (let at = lower.indexOf(q); at !== -1 && out.length < 20; at = lower.indexOf(q, i)) {
    out.push(text.slice(i, at), html`<mark>${text.slice(at, at + q.length)}</mark>`);
    i = at + q.length;
  }
  out.push(text.slice(i));
  return out;
}

// Snippet centred on the first match.
function snippet(content, q) {
  const text = previewText(content).replace(/\s+/g, ' ');
  const at = text.toLowerCase().indexOf(q);
  const start = Math.max(0, at - 30);
  return (start ? '…' : '') + text.slice(start, start + 90);
}

// Media URLs from the text plus NIP-92 imeta attachments.
// Parsing is cached per message object (messages are immutable; edits create new objects).
const mediaCache = new WeakMap();
function mediaOf(message) {
  if (!mediaCache.has(message)) mediaCache.set(message, extractMedia(message));
  return mediaCache.get(message);
}
function extractMedia(message) {
  const urls = new Set((message.content.match(URL_RE) ?? []).filter((u) => IMAGE_RE.test(u) || VIDEO_RE.test(u)));
  for (const t of message.tags ?? [])
    if (t[0] === 'imeta') {
      const url = t.find((v) => v.startsWith('url '))?.slice(4);
      const mime = t.find((v) => v.startsWith('m '))?.slice(2) ?? '';
      if (url?.startsWith('https://') && (/^(image|video)\//.test(mime) || IMAGE_RE.test(url) || VIDEO_RE.test(url))) urls.add(url);
    }
  return [...urls].filter((u) => u.startsWith('https://')).slice(0, 10);
}

function Media({ message, auto }) {
  const urls = mediaOf(message);
  const [shown, setShown] = useState(auto);
  if (!urls.length) return null;
  if (!shown)
    return html`<button class="show-media" onClick=${() => setShown(true)}>
      🖼 Show ${urls.length > 1 ? `${urls.length} media` : 'media'} <small>(reveals your IP to the host)</small>
    </button>`;
  return html`<div class=${`media n${Math.min(urls.length, 3)}`}>
    ${urls.map((url) =>
      VIDEO_RE.test(url)
        ? html`<video src=${url} controls preload="metadata" playsinline />`
        : html`<img src=${url} loading="lazy" referrerpolicy="no-referrer" alt="" onClick=${() => (viewer.value = url)} />`,
    )}
  </div>`;
}

function Viewer() {
  const url = viewer.value;
  useEffect(() => {
    if (!url) return;
    const key = (e) => e.key === 'Escape' && (viewer.value = null);
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [url]);
  if (!url) return null;
  return html`<div class="viewer" onClick=${() => (viewer.value = null)}>
    <img src=${url} referrerpolicy="no-referrer" alt="" />
    <a class="open" href=${url} target="_blank" rel="noopener noreferrer" onClick=${(e) => e.stopPropagation()}>Open original ↗</a>
  </div>`;
}

// Plain-text preview for sidebars and quotes: mentions become @names.
function previewText(content) {
  return content.replace(MENTION_RE, (m) => {
    const pk = nostr.decodePubkey(m);
    return pk ? `@${store.displayName(pk)}` : m;
  });
}

// Telegram gives each sender a stable name colour.
const NAME_COLORS = ['#e17076', '#7bc862', '#e5a64e', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
const nameColor = (pk) => NAME_COLORS[parseInt(pk.slice(-2), 16) % NAME_COLORS.length];

const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const dayKey = (ts) => new Date(ts * 1000).toDateString();
function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const shortTime = (ts) =>
  dayKey(ts) === new Date().toDateString()
    ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

function RoomAvatar({ room, size = 36 }) {
  return room.picture
    ? html`<img class="avatar room" src=${room.picture} width=${size} height=${size} loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : html`<span class="avatar room" style=${`width:${size}px;height:${size}px`}>#</span>`;
}

async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    store.notify(label);
  } catch {
    store.notify('Copy failed');
  }
}

// ---------- Login ----------

function Login() {
  const [mode, setMode] = useState(window.nostr ? 'extension' : 'nsec');
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [authUrl, setAuthUrl] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const signer =
        mode === 'nsec'
          ? nostr.nsecSigner(value)
          : mode === 'extension'
            ? await nostr.extensionSigner()
            : mode === 'bunker'
              ? await nostr.bunkerSigner(value, setAuthUrl)
              : nostr.newKeySigner();
      await store.login(signer, remember);
    });
  };

  const tabs = [
    ['extension', 'Extension'],
    ['nsec', 'Private key'],
    ['bunker', 'Bunker'],
    ['new', 'New account'],
  ];
  return html`<main class="login">
    <form class="card" onSubmit=${submit}>
      <h1>nostr.chat</h1>
      <p class="muted">Private Nostr DMs and public chat rooms.</p>
      <div class="tabs">
        ${tabs.map(
          ([id, label]) =>
            html`<button type="button" class=${mode === id ? 'on' : ''} onClick=${() => setMode(id)}>${label}</button>`,
        )}
      </div>
      ${mode === 'nsec' &&
      html`<input type="password" autocomplete="off" placeholder="nsec1…" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'bunker' &&
      html`<input placeholder="bunker://… or name@domain" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'extension' &&
      html`<p class="muted">${window.nostr ? 'Sign in with your browser extension (needs NIP-44).' : 'No extension detected.'}</p>`}
      ${mode === 'new' &&
      html`<p class="muted">Generates a fresh key in this browser. Back it up from Settings afterwards.</p>`}
      ${mode !== 'extension' &&
      html`<label class="check"><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} /> Stay signed in on this device</label>`}
      ${mode === 'nsec' && remember && html`<p class="muted small">Your key will be stored unencrypted in this browser.</p>`}
      ${authUrl && html`<p>Approve in your signer: <a href=${authUrl} target="_blank" rel="noopener">${authUrl}</a></p>`}
      ${error && html`<p class="error">${error}</p>`}
      <button class="primary" disabled=${busy}>${busy ? 'Connecting…' : me.value ? 'Add account' : 'Sign in'}</button>
      ${me.value && html`<button type="button" onClick=${() => (store.addingAccount.value = false)}>Cancel</button>`}
    </form>
  </main>`;
}

// ---------- Sidebar ----------

// Telegram shows "Draft:" in place of the last message for chats you are not in.
function draftPreview(key, open) {
  const draft = store.drafts.value[key];
  return draft && !open ? html`<small><span class="draft">Draft:</span> ${draft.slice(0, 80)}</small>` : null;
}

function RoomItem({ room, active, onMenu }) {
  const messages = roomState.value[room.address]?.messages ?? [];
  const last = messages[messages.length - 1];
  const link = nostr.encodeRoomLink(room);
  return html`<a class=${'item' + (active ? ' on' : '')} href=${`#/room/${link}`} onContextMenu=${onMenu({ room })}>
    <${RoomAvatar} room=${room} />
    <span class="label">
      <span class="line"><b>${room.name}</b><${ChatFlags} chatKey=${room.address} />${last && html`<time>${shortTime(last.created_at)}</time>`}</span>
      <span class="line">
        ${draftPreview(room.address, active) ??
        html`<small>${last ? `${store.displayName(last.pubkey)}: ${previewText(last.content).slice(0, 80)}` : 'Public room'}</small>`}
        <${Unread} count=${store.unreadCount(room.address, messages)} muted=${store.isMuted(room.address)} />
      </span>
    </span>
  </a>`;
}

function ChatItem({ peer, last, active, onMenu }) {
  return html`<a class=${'item' + (active ? ' on' : '')} href=${`#/dm/${nostr.did(peer)}`} onContextMenu=${onMenu({ peer })}>
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
  return html`<div class="menu" ref=${ref} role="menu" style=${`left:${Math.min(menu.x, innerWidth - 200)}px;top:${Math.min(menu.y, innerHeight - 140)}px`}>
    <button role="menuitem" onClick=${act(() => store.togglePinned(key))}>📌 ${store.isPinned(key) ? 'Unpin' : 'Pin'}</button>
    <button role="menuitem" onClick=${act(() => store.toggleMuted(key))}>${store.isMuted(key) ? '🔔 Unmute' : '🔕 Mute'}</button>
    ${store.unreadCount(key, messages) > 0 &&
    html`<button role="menuitem" onClick=${act(() => store.markRead(key, messages[messages.length - 1].created_at))}>✓ Mark as read</button>`}
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
  return html`<div class="menu accounts" ref=${ref} role="menu">
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

function Sidebar() {
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
  const chats = conversations.value.filter(({ peer }) => match(peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)));
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
  const unpinnedRooms = rooms.filter((room) => !pinnedKeys.includes(room.address));
  const unpinnedChats = chats.filter(({ peer }) => !pinnedKeys.includes(peer));
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
      ${pinned.length > 0 && html`<h2>Pinned</h2>${pinned}`}
      <h2>Rooms <a class="add" href="#/new" title="Join or create a room">+</a></h2>
      ${unpinnedRooms.map((room) => html`<${RoomItem} key=${room.address} room=${room} active=${activeRoom(room)} onMenu=${onMenu} />`)}
      <h2>Chats ${syncing.value && html`<span class="spinner" title="Syncing" />`} <a class="add" href="#/new" title="New chat">+</a></h2>
      ${chats.length === 0 && html`<p class="muted small pad">${q ? 'No matches.' : 'No conversations yet.'}</p>`}
      ${unpinnedChats.map((chat) => html`<${ChatItem} key=${chat.peer} ...${chat} active=${activePeer(chat.peer)} onMenu=${onMenu} />`)}
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
function ChatSearch({ messages, onClose }) {
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

// ---------- Messages ----------

const sameRun = (a, b) => a && b && a.pubkey === b.pubkey && dayKey(a.created_at) === dayKey(b.created_at) && Math.abs(b.created_at - a.created_at) < 300;

const react = (context) => (message, emoji) =>
  store.toggleReaction(context, message, emoji).catch((e) => store.notify(`Reaction failed: ${e.message}`));

// Emoji panel used by the composer and for reactions. Recent picks come first.
function recentEmoji() {
  try {
    return JSON.parse(localStorage.getItem('lite:recent-emoji')) ?? [];
  } catch {
    return [];
  }
}
function rememberEmoji(e) {
  try {
    localStorage.setItem('lite:recent-emoji', JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24)));
  } catch {}
}

function EmojiPanel({ onPick, onClose, style = '' }) {
  const recent = recentEmoji();
  const groups = recent.length ? [{ icon: '🕘', emoji: recent }, ...EMOJI_GROUPS] : EMOJI_GROUPS;
  const [tab, setTab] = useState(0);
  const ref = useRef();
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && !e.target.closest?.('.emoji-toggle') && onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('pointerdown', close, true);
      removeEventListener('keydown', key);
    };
  }, []);
  return html`<div class="emoji-panel" ref=${ref} style=${style}>
    <div class="emoji-tabs">
      ${groups.map((g, i) => html`<button class=${i === tab ? 'on' : ''} onClick=${() => setTab(i)}>${g.icon}</button>`)}
    </div>
    <div class="emoji-grid">
      ${groups[tab].emoji.map(
        (e) => html`<button
          onClick=${() => {
            rememberEmoji(e);
            onPick(e);
          }}
        >${e}</button>`,
      )}
    </div>
  </div>`;
}

function MessageMenu({ menu, onClose, onReply, onReact, onEdit, onDelete, onMoreReactions }) {
  const ref = useRef();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    addEventListener('pointerdown', close, true);
    addEventListener('keydown', key);
    addEventListener('resize', onClose);
    return () => {
      removeEventListener('pointerdown', close, true);
      removeEventListener('keydown', key);
      removeEventListener('resize', onClose);
    };
  }, []);
  useLayoutEffect(() => {
    // Keep the menu on screen.
    const el = ref.current;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - r.height - 8))}px`;
  }, [menu]);
  const m = menu.message;
  const act = (fn) => () => {
    fn();
    onClose();
  };
  return html`<div class="menu" ref=${ref} role="menu">
    ${onReact &&
    html`<div class="quick">
      ${QUICK_REACTIONS.map((e) => html`<button title=${`React ${e}`} onClick=${act(() => onReact(m, e))}>${e}</button>`)}
      <button class="more" title="More reactions" onClick=${act(() => onMoreReactions(m, menu.x, menu.y))}>＋</button>
    </div>`}
    ${onReply && html`<button role="menuitem" onClick=${act(() => onReply(m))}>↩ Reply</button>`}
    <button role="menuitem" onClick=${act(() => (forwarding.value = m))}>↪ Forward</button>
    <button role="menuitem" onClick=${act(() => copy(m.content, 'Text copied'))}>⧉ Copy text</button>
    <button role="menuitem" onClick=${act(() => copy(nostr.did(m.pubkey), 'DID copied'))}>⧉ Copy author DID</button>
    <button role="menuitem" onClick=${act(() => window.open(nostr.profileUrl(m.pubkey), '_blank', 'noopener'))}>👤 View profile</button>
    ${m.pubkey === me.value.pubkey && onEdit && html`<button role="menuitem" onClick=${act(() => onEdit(m))}>✎ Edit</button>`}
    ${m.pubkey === me.value.pubkey &&
    onDelete &&
    (confirming
      ? html`<button role="menuitem" class="danger" onClick=${act(() => onDelete(m))}>🗑 Tap again to delete for everyone</button>`
      : html`<button role="menuitem" class="danger" onClick=${() => setConfirming(true)}>🗑 Delete</button>`)}
  </div>`;
}

function Reactions({ message, onReact }) {
  // Reactions may target any version of an edited message.
  const list = [message.id, ...(message.prev ?? [])].flatMap((id) => reactions.value[id] ?? []);
  if (!list?.length) return null;
  const groups = new Map();
  for (const r of list) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r.pubkey]);
  return html`<div class="reactions">
    ${[...groups].map(([emoji, who]) => {
      const mine = who.includes(me.value.pubkey);
      return html`<button
        class=${mine ? 'on' : ''}
        title=${who.map(store.displayName).join(', ')}
        onClick=${() => onReact?.(message, emoji)}
      >${emoji} ${who.length}</button>`;
    })}
  </div>`;
}

function Tick({ id }) {
  const status = store.sendStatus.value[id];
  if (status === 'sending') return html`<span class="tick" title="Sending">🕓</span>`;
  if (status === 'failed')
    return html`<button class="tick failed" title="Not sent — tap to retry" onClick=${() => store.retrySend(id)}>⚠</button>`;
  return html`<span class="tick" title="Accepted by a relay">✓</span>`;
}

function MessageList({ messages, policy = () => 'trusted', badge = () => '', mediaAuto = () => true, onReply, onReact, onEdit, onDelete, footer, header }) {
  const ref = useRef();
  const stick = useRef(true);
  const touch = useRef(null);
  const lastTop = useRef(0);
  const [menu, setMenu] = useState(null);
  const [reactPicker, setReactPicker] = useState(null); // { message, x, y }
  const [away, setAway] = useState(null); // id of the newest message when the user scrolled up, else null
  // Only the newest PAGE rows are rendered; scrolling near the top reveals more.
  const PAGE = 200;
  const [limit, setLimit] = useState(PAGE);
  const inner = useRef();
  const prev = useRef({ last: null });
  const anchor = useRef(null); // { id, top } of the first visible message while scrolled up
  const saveAnchor = () => {
    const el = ref.current;
    const box = el.getBoundingClientRect();
    const first = [...inner.current.querySelectorAll('.msg')].find((m) => m.getBoundingClientRect().bottom > box.top);
    anchor.current = first ? { id: first.dataset.id, top: first.getBoundingClientRect().top } : null;
  };
  // Keep what you were reading in place when content above it changes (older pages, reactions, images).
  const restoreAnchor = () => {
    const a = anchor.current;
    const node = a && inner.current.querySelector(`[data-id="${a.id}"]`);
    if (node) ref.current.scrollTop += node.getBoundingClientRect().top - a.top;
  };
  const byId = Object.fromEntries(messages.flatMap((m) => [m.id, ...(m.prev ?? [])].map((id) => [id, m])));
  const first = messages[0]?.id;
  const lastMsg = messages[messages.length - 1];
  useLayoutEffect(() => {
    const el = ref.current;
    const p = prev.current;
    // Your own new message always brings you to the bottom, like Telegram.
    if (lastMsg && lastMsg.id !== p.last && p.last && lastMsg.pubkey === me.value.pubkey) stick.current = true;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else restoreAnchor();
    prev.current = { last: lastMsg?.id };
  }, [messages.length, first, lastMsg?.id, limit]);
  // Images and media that load later grow the list; stay pinned to the bottom if you were there.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const el = ref.current;
      if (stick.current) el.scrollTop = el.scrollHeight;
      else restoreAnchor();
    });
    observer.observe(inner.current);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = ref.current;
    // Only scrolling up unsticks; content growing underneath (a burst of messages, images) must not.
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (gap < 80) stick.current = true;
    else if (el.scrollTop < lastTop.current - 2) stick.current = false;
    lastTop.current = el.scrollTop;
    if (!stick.current) saveAnchor();
    if (el.scrollTop < 400 && limit < visibleCount) setLimit((n) => n + PAGE);
    if (stick.current && away !== null) setAway(null);
    else if (!stick.current && away === null) setAway(lastMsg?.id ?? '');
    if (menu) setMenu(null);
  };
  const toBottom = () => {
    stick.current = true;
    ref.current.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
    setAway(null);
  };
  const jumpTo = (id) => {
    const el = ref.current.querySelector(`[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
  };
  const focus = focusMessage.value;
  useEffect(() => {
    if (!focus) return;
    const index = messages.findIndex((m) => m.id === focus || m.prev?.includes(focus));
    if (index < 0) return;
    // Widen the window first if the target is older than what is rendered.
    const needed = messages.length - index + 20;
    if (needed > limit) return setLimit(needed);
    stick.current = false;
    jumpTo(messages[index].id);
    focusMessage.value = null;
  }, [focus, messages.length, limit]);
  const openMenu = (message, x, y) => setMenu({ message, x, y });
  // Touch: long-press opens the menu, swipe right replies (Telegram mobile).
  const touchStart = (m) => (e) => {
    const t = e.touches[0];
    const state = { m, x: t.clientX, y: t.clientY, dx: 0, el: e.currentTarget, swiping: false };
    state.press = setTimeout(() => openMenu(m, t.clientX, t.clientY), 450);
    touch.current = state;
  };
  const touchMove = (e) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(s.press);
    if (!s.swiping && onReply && dx > 12 && Math.abs(dx) > 2 * Math.abs(dy)) s.swiping = true;
    if (s.swiping) {
      s.dx = Math.max(0, Math.min(dx, 90));
      s.el.style.transform = `translateX(${s.dx}px)`;
      s.el.classList.toggle('will-reply', s.dx > 60);
    }
  };
  const touchEnd = () => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    clearTimeout(s.press);
    if (!s.swiping) return;
    s.el.style.transform = '';
    s.el.classList.remove('will-reply');
    if (s.dx > 60) onReply(s.m);
  };
  const allVisible = messages.filter((m) => policy(m.pubkey) !== 'blocked');
  const visibleCount = allVisible.length;
  const visible = allVisible.length > limit ? allVisible.slice(-limit) : allVisible;
  // New messages from others since you scrolled up (older pages loading above don't count).
  const awayIndex = away === null ? -1 : messages.findIndex((m) => m.id === away);
  const below = awayIndex < 0 ? 0 : messages.slice(awayIndex + 1).filter((m) => m.pubkey !== me.value.pubkey).length;
  return html`<div class="thread"><div class="messages" ref=${ref} onScroll=${onScroll}><div class="messages-inner" ref=${inner}>
    ${header}
    ${visible.map((m, i) => {
      const mine = m.pubkey === me.value.pubkey;
      const prev = visible[i - 1];
      const next = visible[i + 1];
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const first = !sameRun(prev, m);
      const last = !sameRun(m, next);
      const quoteId = m.reply ?? m.tags?.find((t) => t[0] === 'q')?.[1];
      const quote = quoteId && byId[quoteId];
      const tag = badge(m.pubkey);
      // Keyed per message, so loading older pages adds nodes instead of rewriting every row.
      return html`<${Fragment} key=${m.id}>${newDay && html`<div class="day"><span>${dayLabel(m.created_at)}</span></div>`}
        <div
          class=${`msg${mine ? ' mine' : ''}${first ? ' first' : ''}${last ? ' last' : ''}`}
          data-id=${m.id}
          onContextMenu=${(e) => {
            e.preventDefault();
            openMenu(m, e.clientX, e.clientY);
          }}
          onDblClick=${() => onReply?.(m)}
          ontouchstart=${touchStart(m)}
          ontouchmove=${touchMove}
          ontouchend=${touchEnd}
          ontouchcancel=${touchEnd}
        >
          <div class="slot">${last && !mine && html`<${Avatar} pubkey=${m.pubkey} size=${32} />`}</div>
          <div class="bubble">
            ${first && !mine && html`<div class="who" style=${`--name-color:${nameColor(m.pubkey)}`}>${store.displayName(m.pubkey)}${tag && html`<span class="badge">${tag}</span>`}</div>`}
            ${quote &&
            html`<button class="quote" onClick=${() => (focusMessage.value = quote.id)}>
              <b>${store.displayName(quote.pubkey)}</b>${previewText(quote.content).slice(0, 140)}
            </button>`}
            ${policy(m.pubkey) === 'trusted' && html`<${Media} message=${m} auto=${mine || mediaAuto(m.pubkey)} />`}
            ${m.kind === 15 && html`<${EncryptedFile} message=${m} />`}
            <div class="body">${m.kind !== 15 && html`<${Text} content=${m.content} links=${policy(m.pubkey) === 'trusted'} />`}<span class="meta">${(m.edited ?? nostr.isEdited(m.tags ?? [])) ? 'edited ' : ''}${clock(m.created_at)}${mine && html`<${Tick} id=${m.id} />`}</span></div>
            <${Reactions} message=${m} onReact=${onReact} />
          </div>
        </div></${Fragment}>`;
    })}
    ${footer}
    </div>
    ${menu && html`<${MessageMenu}
      menu=${menu}
      onReply=${onReply}
      onReact=${onReact}
      onEdit=${onEdit}
      onDelete=${onDelete}
      onMoreReactions=${(message, x, y) => setReactPicker({ message, x, y })}
      onClose=${() => setMenu(null)}
    />`}
    ${reactPicker &&
    html`<${EmojiPanel}
      style=${`position:fixed;bottom:auto;left:${Math.max(8, Math.min(reactPicker.x, innerWidth - 330))}px;top:${Math.max(8, Math.min(reactPicker.y, innerHeight - 330))}px`}
      onPick=${(e) => {
        onReact(reactPicker.message, e);
        setReactPicker(null);
      }}
      onClose=${() => setReactPicker(null)}
    />`}
  </div>
  ${away !== null &&
  html`<button class="to-bottom" title="Jump to latest" onClick=${toBottom}>
    ↓${below > 0 && html`<span class="unread">${below}</span>`}
  </button>`}
  </div>`;
}

function Composer({ onSend, placeholder, replyTo, onCancelReply, editing, onEdit, onCancelEdit, draftKey }) {
  const [text, setTextState] = useState(() => store.drafts.value[draftKey] ?? '');
  // Keep the per-chat draft in step with what is typed (not while editing a sent message).
  // Drafts reach the store after a pause in typing, so each keystroke doesn't re-render the sidebar.
  const draftTimer = useRef();
  const pendingDraft = useRef(null);
  const setText = (value) => {
    setTextState(value);
    if (editing) return;
    pendingDraft.current = value;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      store.setDraft(draftKey, value);
      pendingDraft.current = null;
    }, 400);
  };
  useEffect(
    () => () => {
      clearTimeout(draftTimer.current);
      if (pendingDraft.current !== null) store.setDraft(draftKey, pendingDraft.current);
    },
    [draftKey],
  );
  const input = useRef();
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (editing) setText(editing.content);
    if (editing || replyTo) input.current?.focus();
  }, [editing?.id, replyTo?.id]);
  const cancel = () => {
    if (editing) {
      onCancelEdit();
      setTextState(store.drafts.value[draftKey] ?? '');
    } else onCancelReply?.();
  };
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    if (editing && value === editing.content.trim()) return cancel();
    // Clear at once like Telegram; put the text back if sending fails outright.
    // After an edit, bring back whatever draft was there before.
    if (editing) setTextState(store.drafts.value[draftKey] ?? '');
    else setText('');
    run(async () => {
      try {
        await (editing ? onEdit(editing, value) : onSend(value));
      } catch (e) {
        setText(value);
        throw e;
      }
    });
  };
  const context = editing ?? replyTo;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const insert = (e) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + e + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + e.length, start + e.length);
    });
  };
  return html`<footer class="composer">
    ${emojiOpen && html`<${EmojiPanel} onPick=${insert} onClose=${() => setEmojiOpen(false)} />`}
    ${context &&
    html`<div class="replying">
      <span class="what">${editing ? '✎ Edit message' : `↩ Reply to ${store.displayName(replyTo.pubkey)}`}</span>
      <span class="snippet">${previewText(context.content).slice(0, 80)}</span>
      <button class="link" title="Cancel" onClick=${cancel}>✕</button>
    </div>`}
    ${error && html`<p class="error">${error}</p>`}
    <div class="row">
      <button class="icon emoji-toggle" title="Emoji" onClick=${() => setEmojiOpen(!emojiOpen)}>🙂</button>
      <textarea
        ref=${input}
        rows="1"
        placeholder=${placeholder}
        value=${text}
        onInput=${(e) => {
          setText(e.target.value);
          autosize(e.target);
        }}
        onKeyDown=${(e) => {
          // On touch keyboards Enter makes a new line (like Telegram mobile); send with the button.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchKeyboard) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape' && context) cancel();
          else if (e.key === 'ArrowUp' && !text && onEdit) onEdit(null);
        }}
      />
      <button class="primary" disabled=${busy || !text.trim()} onClick=${send}>${busy ? '…' : editing ? 'Save' : 'Send'}</button>
    </div>
  </footer>`;
}

// Mark a chat read while it is on screen and the tab is visible.
function useMarkRead(key, messages) {
  const last = messages[messages.length - 1]?.created_at ?? 0;
  useEffect(() => {
    const mark = () => key && last && document.visibilityState === 'visible' && store.markRead(key, last);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [key, last]);
}

function Unread({ count, muted }) {
  return count ? html`<span class=${`unread${muted ? ' muted' : ''}`}>${count > 999 ? '999+' : count}</span>` : null;
}

// Reply / edit / delete / react state shared by DM and room views.
function useChatActions(context, messages) {
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const fail = (what) => (e) => store.notify(`${what} failed: ${e.message}`);
  const startEdit = (m) => {
    setReplyTo(null);
    setEditing(m);
  };
  return {
    list: {
      onReply: (m) => {
        setEditing(null);
        setReplyTo(m);
      },
      onReact: react(context),
      onEdit: startEdit,
      onDelete: (m) => store.deleteMessage(context, m).catch(fail('Delete')),
    },
    composer: {
      replyTo,
      onCancelReply: () => setReplyTo(null),
      editing,
      onCancelEdit: () => setEditing(null),
      // Telegram: arrow-up in an empty composer edits your last message.
      onEdit: async (m, text) => {
        if (!m) {
          const last = [...messages].reverse().find((x) => x.pubkey === me.value.pubkey);
          if (last) startEdit(last);
          return;
        }
        await store.editMessage(context, m, text);
        setEditing(null);
      },
    },
    clearReply: () => setReplyTo(null),
  };
}

// ---------- Chat info panel ----------

function SharedMedia({ messages, allowed }) {
  const urls = messages
    .filter((m) => allowed(m.pubkey))
    .flatMap(mediaOf)
    .filter((u) => IMAGE_RE.test(u) || !VIDEO_RE.test(u))
    .reverse()
    .slice(0, 30);
  if (!urls.length) return null;
  return html`<section>
    <h4>Shared media</h4>
    <div class="shared">
      ${urls.map((u) => html`<img src=${u} loading="lazy" referrerpolicy="no-referrer" alt="" onClick=${() => (viewer.value = u)} />`)}
    </div>
  </section>`;
}

function Field({ label, value, onCopy, href }) {
  return html`<div class="field">
    <small>${label}</small>
    ${href
      ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${value}</a>`
      : html`<span class=${onCopy ? 'copyable mono' : ''} title=${onCopy ? 'Copy' : ''} onClick=${onCopy}>${value}</span>`}
  </div>`;
}

function ChatToggles({ chatKey }) {
  return html`<section class="toggles">
    <label class="check"><input type="checkbox" checked=${store.isPinned(chatKey)} onChange=${() => store.togglePinned(chatKey)} /> 📌 Pin to top</label>
    <label class="check"><input type="checkbox" checked=${store.isMuted(chatKey)} onChange=${() => store.toggleMuted(chatKey)} /> 🔕 Mute notifications</label>
  </section>`;
}

function PersonInfo({ pubkey, messages }) {
  const p = profiles.value[pubkey] ?? {};
  return html`<div class="hero">
      <${Avatar} pubkey=${pubkey} size=${96} />
      <h3>${pubkey === me.value.pubkey ? 'Note to self' : store.displayName(pubkey)}</h3>
      ${store.verifiedNip05(pubkey) && html`<small class="muted" title="Verified NIP-05 address">✓ ${store.verifiedNip05(pubkey)}</small>`}
    </div>
    ${p.about && html`<section><p class="about">${p.about}</p></section>`}
    <section>
      <${Field} label="DID" value=${nostr.did(pubkey)} onCopy=${() => copy(nostr.did(pubkey), 'DID copied')} />
      <${Field} label="npub" value=${nostr.shortKey(pubkey)} onCopy=${() => copy(nostr.npub(pubkey), 'npub copied')} />
      ${p.website && html`<${Field} label="Website" value=${p.website.replace(/^https:\/\//, '')} href=${p.website} />`}
      <${Field} label="Profile" value="nostr.social ↗" href=${nostr.profileUrl(pubkey)} />
    </section>
    <${ChatToggles} chatKey=${pubkey} />
    <${SharedMedia} messages=${messages} allowed=${() => true} />`;
}

function RoomInfo({ room, messages }) {
  const authors = [...new Set(messages.map((m) => m.pubkey))].filter((pk) => nostr.roomPolicy(room, pk) !== 'blocked');
  const order = { owner: 0, trusted: 1, plain: 2 };
  const role = (pk) => (pk === room.owner ? 'owner' : nostr.roomPolicy(room, pk));
  authors.sort((a, b) => order[role(a)] - order[role(b)] || store.displayName(a).localeCompare(store.displayName(b)));
  const link = `${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`;
  return html`<div class="hero">
      <${RoomAvatar} room=${room} size=${96} />
      <h3>${room.name}</h3>
      <small class="muted">Public room · ${authors.length} recent ${authors.length === 1 ? 'poster' : 'posters'}</small>
    </div>
    ${room.about && html`<section><p class="about">${room.about}</p></section>`}
    <section>
      <${Field} label="Invite link" value="Copy link" onCopy=${() => copy(link, 'Room link copied')} />
      <${Field} label="Owner" value=${store.displayName(room.owner)} href=${nostr.profileUrl(room.owner)} />
      <${Field} label="Relays" value=${room.relays.map((r) => r.replace(/^wss:\/\//, '')).join(', ')} />
    </section>
    <${ChatToggles} chatKey=${room.address} />
    <${SharedMedia} messages=${messages} allowed=${(pk) => nostr.roomPolicy(room, pk) === 'trusted'} />
    ${joinedRooms.value.some((r) => r.address === room.address) &&
    html`<section><button class="danger wide" onClick=${() => store.leaveRoom(room.address)}>Leave room</button></section>`}
    <section>
      <h4>Members</h4>
      ${authors.map(
        (pk) => html`<a class="item" href=${`#/dm/${nostr.did(pk)}`}>
          <${Avatar} pubkey=${pk} size=${32} />
          <span class="label"><b>${store.displayName(pk)}</b></span>
          ${role(pk) !== 'plain' && html`<span class="badge">${role(pk)}</span>`}
        </a>`,
      )}
    </section>`;
}

function InfoPanel({ children }) {
  if (!infoOpen.value) return null;
  return html`<aside class="info">
    <header class="bar">
      <div class="title"><b>Info</b></div>
      <button class="link close" title="Close" onClick=${() => (infoOpen.value = false)}>✕</button>
    </header>
    <div class="info-body">${children}</div>
  </aside>`;
}

// Touch devices without a hardware keyboard: Enter inserts a newline.
const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)').matches;

// Grow the composer with its text (field-sizing isn't available everywhere, e.g. Firefox).
function autosize(el) {
  if (!el || CSS.supports('field-sizing', 'content')) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`;
}

// NIP-17 kind 15: an AES-GCM encrypted file. Decrypt it locally when asked.
function EncryptedFile({ message }) {
  const tag = (name) => message.tags?.find((t) => t[0] === name)?.[1];
  const type = tag('file-type') || 'application/octet-stream';
  const [state, setState] = useState({ busy: false, url: '', error: '' });
  const open = async () => {
    setState({ busy: true, url: '', error: '' });
    try {
      if ((tag('encryption-algorithm') || 'aes-gcm') !== 'aes-gcm') throw new Error('Unsupported encryption');
      const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
      const res = await fetch(message.content, { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      const key = await crypto.subtle.importKey('raw', hex(tag('decryption-key')), 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hex(tag('decryption-nonce')) }, key, await res.arrayBuffer());
      const url = URL.createObjectURL(new Blob([plain], { type }));
      setState({ busy: false, url, error: '' });
      if (!type.startsWith('image/')) {
        const a = Object.assign(document.createElement('a'), { href: url, download: 'file' });
        a.click();
      }
    } catch (e) {
      setState({ busy: false, url: '', error: e.message });
    }
  };
  if (state.url && type.startsWith('image/'))
    return html`<div class="media n1"><img src=${state.url} alt="" onClick=${() => (viewer.value = state.url)} /></div>`;
  return html`<button class="file-card" disabled=${state.busy} onClick=${open}>
    <span class="file-icon">${type.startsWith('image/') ? '🖼' : type.startsWith('video/') ? '🎞' : '📎'}</span>
    <span class="label"><b>Encrypted ${type.split('/')[0] === 'application' ? 'file' : type.split('/')[0]}</b>
      <small>${state.error || (state.busy ? 'Decrypting…' : `${type} · tap to open (reveals your IP to the host)`)}</small></span>
  </button>`;
}

// ---------- Views ----------

function DirectChat({ id }) {
  const peer = nostr.decodePubkey(id);
  const older = useAction();
  const messages = (peer && dms.value[peer]) || [];
  const actions = useChatActions({ peer }, messages);
  useMarkRead(peer, messages);
  useEffect(() => peer && store.requestProfiles([peer]), [peer]);
  if (!peer) return html`<section class="main empty"><p class="error">Invalid contact.</p></section>`;
  return html`<section class="main">
    <header class="bar">
      <a class="back" href="#">‹</a>
      <${Avatar} pubkey=${peer} size=${32} />
      <button class="title" title="Chat info" onClick=${() => (infoOpen.value = !infoOpen.value)}>
        <b>${peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)}</b>
        <small class="mono">${store.verifiedNip05(peer) ? `✓ ${store.verifiedNip05(peer)}` : nostr.shortKey(peer)}</small>
      </button>
      <button class="icon" title="Search (Ctrl+F)" onClick=${() => (chatSearch.value = !chatSearch.value)}>🔍</button>
    </header>
    ${chatSearch.value && html`<${ChatSearch} messages=${messages} onClose=${() => (chatSearch.value = false)} />`}
    <${InfoPanel}><${PersonInfo} pubkey=${peer} messages=${messages} /></${InfoPanel}>
    <${MessageList}
      ...${actions.list}
      mediaAuto=${(pk) => store.contacts.value.includes(pk)}
      messages=${messages}
      header=${html`<div class="older">
        ${store.dmHistoryDone.value
          ? html`<span class="muted small">Start of history</span>`
          : html`<button class="link" disabled=${older.busy} onClick=${() => older.run(store.loadOlderDirectMessages)}>
              ${older.busy ? 'Loading…' : 'Load older messages'}
            </button>`}
      </div>`}
    />
    <${Composer}
      ...${actions.composer}
      placeholder="Encrypted message"
      draftKey=${peer}
      onSend=${async (text) => {
        await store.sendDirectMessage(peer, text, actions.composer.replyTo);
        actions.clearReply();
      }}
    />
  </section>`;
}

function RoomChat({ id }) {
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
  return html`<section class="main">
    <header class="bar">
      <a class="back" href="#">‹</a>
      <${RoomAvatar} room=${room} size=${32} />
      <button class="title" title="Room info" onClick=${() => (infoOpen.value = !infoOpen.value)}>
        <b>${room.name}</b>
        <small>${room.about || `by ${store.displayName(room.owner)}`}</small>
      </button>
<button class="icon" title="Search (Ctrl+F)" onClick=${() => (chatSearch.value = !chatSearch.value)}>🔍</button>
      <button class="wide-only" onClick=${() => copy(`${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`, 'Room link copied')}>Share</button>
      ${joined
        ? html`<button class="wide-only" onClick=${() => store.leaveRoom(room.address)}>Leave</button>`
        : html`<button class="primary" onClick=${() => store.joinRoom(room)}>Join</button>`}
    </header>
    ${chatSearch.value && html`<${ChatSearch} messages=${state.messages} onClose=${() => (chatSearch.value = false)} />`}
    <${InfoPanel}><${RoomInfo} room=${room} messages=${state.messages} /></${InfoPanel}>
    ${state.pinnedEvent &&
    policy(state.pinnedEvent.pubkey) !== 'blocked' &&
    html`<div class="pinned" title="Pinned message">
      <b>Pinned</b> <span><${Text} content=${state.pinnedEvent.content} links=${policy(state.pinnedEvent.pubkey) === 'trusted'} /></span>
    </div>`}
    <${MessageList}
      messages=${state.messages}
      policy=${policy}
      badge=${(pk) => (pk === room.owner ? 'owner' : '')}
      ...${actions.list}
      header=${html`<div class="older">
        ${state.exhausted
          ? html`<span class="muted small">Start of room history</span>`
          : html`<button class="link" disabled=${older.busy} onClick=${() => older.run(() => store.loadOlderRoomMessages(room.address))}>
              ${older.busy ? 'Loading…' : 'Load older messages'}
            </button>`}
      </div>`}
    />
    <${Composer}
      ...${actions.composer}
      placeholder="Public message — anyone can read this"
      draftKey=${room.address}
      onSend=${async (text) => {
        await store.sendRoomMessage(room.address, text, actions.composer.replyTo);
        if (!joined) store.joinRoom(room);
        actions.clearReply();
      }}
    />
  </section>`;
}

function NewThing() {
  const [contact, setContact] = useState('');
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const dm = useAction();
  const join = useAction();
  const create = useAction();
  return html`<section class="main scroll">
    <header class="bar"><a class="back" href="#">‹</a><div class="title"><b>New</b></div></header>
    <div class="forms">
      <form class="card" onSubmit=${(e) => {
        e.preventDefault();
        dm.run(async () => {
          const { pubkey } = await nostr.resolvePubkey(contact);
          store.go(`#/dm/${nostr.did(pubkey)}`);
        });
      }}>
        <h3>Direct message</h3>
        <input placeholder="did:nostr:…, name@domain or npub" value=${contact} onInput=${(e) => setContact(e.target.value)} />
        ${dm.error && html`<p class="error">${dm.error}</p>`}
        <button class="primary" disabled=${dm.busy}>Open chat</button>
      </form>
      <form class="card" onSubmit=${(e) => {
        e.preventDefault();
        join.run(async () => {
          const pointer = nostr.decodeRoomLink(link);
          store.go(`#/room/${nostr.encodeRoomLink(pointer)}`);
        });
      }}>
        <h3>Join a room</h3>
        <input placeholder="Room link or naddr1…" value=${link} onInput=${(e) => setLink(e.target.value)} />
        ${join.error && html`<p class="error">${join.error}</p>`}
        <button class="primary" disabled=${join.busy}>Open room</button>
      </form>
      <form class="card" onSubmit=${(e) => {
        e.preventDefault();
        create.run(async () => {
          if (!name.trim()) throw new Error('Give the room a name.');
          const room = await store.createRoom({ name, about, relays: nostr.APP_RELAYS.slice(0, 3) });
          store.go(`#/room/${nostr.encodeRoomLink(room)}`);
        });
      }}>
        <h3>Create a public room</h3>
        <input placeholder="Name" maxlength="100" value=${name} onInput=${(e) => setName(e.target.value)} />
        <input placeholder="Description (optional)" value=${about} onInput=${(e) => setAbout(e.target.value)} />
        <p class="muted small">Anyone with the link can read and post. Compatible with Anagram.</p>
        ${create.error && html`<p class="error">${create.error}</p>`}
        <button class="primary" disabled=${create.busy}>${create.busy ? 'Publishing…' : 'Create room'}</button>
      </form>
    </div>
  </section>`;
}

function Settings() {
  const signer = me.value;
  const [showKey, setShowKey] = useState(false);
  const inbox = useAction();
  const relays = inboxRelays.value;
  return html`<section class="main scroll">
    <header class="bar"><a class="back" href="#">‹</a><div class="title"><b>Settings</b></div></header>
    <div class="forms">
      <div class="card">
        <h3>Account</h3>
        <p class="mono wrap">${nostr.did(signer.pubkey)}</p>
        <div class="buttons">
          <button onClick=${() => copy(nostr.did(signer.pubkey), 'DID copied')}>Copy DID</button>
          <button onClick=${() => copy(nostr.npub(signer.pubkey), 'npub copied')}>Copy npub</button>
          <a class="button" href=${nostr.profileUrl(signer.pubkey)} target="_blank" rel="noopener">View profile</a>
        </div>
        <p class="muted small">Signed in with ${signer.type === 'nsec' ? 'a private key' : signer.type === 'bunker' ? 'a remote signer' : 'a browser extension'}.</p>
        ${signer.type === 'nsec' &&
        html`<div>
          ${showKey
            ? html`<p class="mono wrap secret">${nostr.exportNsec(signer)}</p>`
            : html`<button onClick=${() => setShowKey(true)}>Reveal private key (nsec)</button>`}
        </div>`}
      </div>
      <div class="card">
        <h3>DM inbox relays</h3>
        ${relays === null
          ? html`<p class="muted">Checking…</p>`
          : relays.length
            ? html`<ul>${relays.map((r) => html`<li class="mono">${r}</li>`)}</ul>`
            : html`<p class="muted">You have no NIP-17 inbox relays published, so some clients can't reach you.</p>
                <button disabled=${inbox.busy} onClick=${() => inbox.run(store.publishDefaultInbox)}>Publish default inbox relays</button>`}
        ${inbox.error && html`<p class="error">${inbox.error}</p>`}
      </div>
      <div class="card">
        <h3>Appearance</h3>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          ${[
            ['system', 'System'],
            ['light', '☀️ Light'],
            ['dark', '🌙 Dark'],
          ].map(
            ([value, label]) => html`<button role="radio" aria-checked=${theme.value === value} class=${theme.value === value ? 'on' : ''} onClick=${() => setTheme(value)}>${label}</button>`,
          )}
        </div>
      </div>
      <${NotificationSettings} />
      <div class="card">
        <button class="danger" onClick=${store.logout}>Sign out of this account</button>
      </div>
    </div>
  </section>`;
}

function NotificationSettings() {
  const n = store.notifySettings.value;
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return html`<div class="card">
    <h3>Notifications</h3>
    <p class="muted small">While this tab is open. There is no push server, so nothing arrives when it's closed.</p>
    <label class="check"><input type="checkbox" checked=${n.dms} onChange=${(e) => store.setNotifySettings({ dms: e.target.checked })} /> Direct messages</label>
    <label class="check">Rooms
      <select value=${n.rooms} onChange=${(e) => store.setNotifySettings({ rooms: e.target.value })}>
        <option value="mentions">Mentions and replies</option>
        <option value="all">All messages</option>
        <option value="off">Off</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" checked=${n.sound} onChange=${(e) => store.setNotifySettings({ sound: e.target.checked })} /> Sound</label>
    ${permission === 'granted'
      ? html`<p class="muted small">Desktop notifications are on (shown when the tab is in the background).</p>`
      : permission === 'denied'
        ? html`<p class="muted small">Desktop notifications are blocked in your browser's site settings.</p>`
        : permission === 'unsupported'
          ? html`<p class="muted small">This browser doesn't support desktop notifications.</p>`
          : html`<button onClick=${() => Notification.requestPermission().then(setPermission)}>Enable desktop notifications</button>`}
  </div>`;
}

// ---------- In-tab notifications ----------

let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.setValueAtTime(1320, audio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.26);
  } catch {}
}

const chatHash = (chat) => (chat.room ? `#/room/${nostr.encodeRoomLink(chat.room)}` : `#/dm/${nostr.did(chat.peer)}`);
const viewing = (chat) => {
  const r = route.value;
  if (document.visibilityState !== 'visible') return false;
  if (chat.room) {
    try {
      return r.kind === 'room' && nostr.decodeRoomLink(r.id).address === chat.room.address;
    } catch {
      return false; // malformed room link in the URL
    }
  }
  return r.kind === 'dm' && nostr.decodePubkey(r.id) === chat.peer;
};

let lastBeep = 0;
store.onIncoming((chat, m) => {
  if (viewing(chat)) return;
  if (store.notifySettings.value.sound && Date.now() - lastBeep > 1500) {
    lastBeep = Date.now();
    beep();
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const who = store.displayName(m.pubkey);
  const note = new Notification(chat.room ? `${who} in ${chat.room.name}` : who, {
    body: previewText(m.content).slice(0, 200),
    icon: chat.room?.picture || profiles.value[m.pubkey]?.picture || 'icon.svg',
    tag: chat.room?.address ?? chat.peer, // one notification per chat, replaced by newer ones
  });
  note.onclick = () => {
    window.focus();
    location.hash = chatHash(chat);
    note.close();
  };
});

function ForwardPicker() {
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

function Home() {
  return html`<section class="main empty">
    <div>
      <h2>nostr.chat</h2>
      <p class="muted">Pick a conversation, or <a href="#/new">start a new one</a>.</p>
    </div>
  </section>`;
}

function App() {
  const unread = store.totalUnread.value;
  const routeKey = `${route.value.kind}:${route.value.id ?? ''}`;
  useEffect(() => {
    infoOpen.value = false;
    chatSearch.value = false;
  }, [routeKey]);
  useEffect(() => {
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && ['dm', 'room'].includes(route.value.kind)) {
        e.preventDefault();
        chatSearch.value = true;
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    document.title = unread ? `(${unread}) nostr.chat` : 'nostr.chat';
  }, [unread]);
  if (!me.value || store.addingAccount.value) return html`<${Login} />`;
  const r = route.value;
  const view =
    r.kind === 'dm'
      ? html`<${DirectChat} id=${r.id} key=${r.id} />`
      : r.kind === 'room'
        ? html`<${RoomChat} id=${r.id} key=${r.id} />`
        : r.kind === 'new'
          ? html`<${NewThing} />`
          : r.kind === 'settings'
            ? html`<${Settings} />`
            : html`<${Home} />`;
  return html`<div class=${`layout ${r.kind === 'home' ? 'at-home' : 'in-view'}`}>
    <${Sidebar} />
    ${view}
    ${toast.value && html`<div class="toast">${toast.value}</div>`}
    <${Viewer} />
    <${ForwardPicker} />
  </div>`;
}

const root = document.getElementById('app');
render(html`<p class="boot muted">Loading…</p>`, root);
store.restoreSession().finally(() => render(html`<${App} />`, root));

if ('serviceWorker' in navigator) {
  // When an updated worker takes over an already-controlled page, reload once to run the new code.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) {
      reloaded = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
