import { h, render } from 'preact';
import { signal } from '@preact/signals';
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import htm from 'htm';
import * as nostr from './nostr.js';
import * as store from './store.js';

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

// Media URLs from the text plus NIP-92 imeta attachments.
function mediaOf(message) {
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
      <h1>Anagram <small>lite</small></h1>
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
      <button class="primary" disabled=${busy}>${busy ? 'Connecting…' : 'Sign in'}</button>
    </form>
  </main>`;
}

// ---------- Sidebar ----------

function Sidebar() {
  const r = route.value;
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  const rooms = joinedRooms.value
    .map((room) => {
      const messages = roomState.value[room.address]?.messages ?? [];
      return { room, last: messages[messages.length - 1] };
    })
    .filter(({ room }) => match(room.name));
  const chats = conversations.value.filter(({ peer }) =>
    match(peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)),
  );
  return html`<aside class="sidebar">
    <header>
      <a class="me" href="#/settings" title="Settings">
        <${Avatar} pubkey=${me.value.pubkey} size=${32} />
        <span>${store.displayName(me.value.pubkey)}</span>
      </a>
      <a class="button" href="#/new" title="New chat or room">+</a>
    </header>
    <div class="search"><input type="search" placeholder="Search" value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
    <nav>
      <h2>Rooms <a class="add" href="#/new" title="Join or create a room">+</a></h2>
      ${rooms.map(({ room, last }) => {
        const link = nostr.encodeRoomLink(room);
        return html`<a class=${'item' + (r.kind === 'room' && r.id === link ? ' on' : '')} href=${`#/room/${link}`}>
          <${RoomAvatar} room=${room} />
          <span class="label">
            <span class="line"><b>${room.name}</b>${last && html`<time>${shortTime(last.created_at)}</time>`}</span>
            <span class="line">
              <small>${last ? `${store.displayName(last.pubkey)}: ${previewText(last.content).slice(0, 80)}` : 'Public room'}</small>
              <${Unread} count=${store.unreadCount(room.address, roomState.value[room.address]?.messages ?? [])} />
            </span>
          </span>
        </a>`;
      })}
      <h2>Chats ${syncing.value && html`<span class="spinner" title="Syncing" />`} <a class="add" href="#/new" title="New chat">+</a></h2>
      ${chats.length === 0 && html`<p class="muted small pad">${q ? 'No matches.' : 'No conversations yet.'}</p>`}
      ${chats.map(({ peer, last }) => {
        const id = nostr.did(peer);
        return html`<a class=${'item' + (r.kind === 'dm' && r.id === id ? ' on' : '')} href=${`#/dm/${id}`}>
          <${Avatar} pubkey=${peer} />
          <span class="label">
            <span class="line">
              <b>${peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)}</b>
              ${last && html`<time>${shortTime(last.created_at)}</time>`}
            </span>
            <span class="line">
              <small>${last ? `${last.pubkey === me.value.pubkey ? 'You: ' : ''}${previewText(last.content).slice(0, 80)}` : 'No messages yet'}</small>
              <${Unread} count=${store.unreadCount(peer, dms.value[peer] ?? [])} />
            </span>
          </span>
        </a>`;
      })}
    </nav>
  </aside>`;
}

// ---------- Messages ----------

const sameRun = (a, b) => a && b && a.pubkey === b.pubkey && dayKey(a.created_at) === dayKey(b.created_at) && Math.abs(b.created_at - a.created_at) < 300;

const react = (context) => (message, emoji) =>
  store.toggleReaction(context, message, emoji).catch((e) => store.notify(`Reaction failed: ${e.message}`));

function MessageMenu({ menu, onClose, onReply, onReact, onEdit, onDelete }) {
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
    </div>`}
    ${onReply && html`<button role="menuitem" onClick=${act(() => onReply(m))}>↩ Reply</button>`}
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
  const list = reactions.value[message.id];
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
  const [menu, setMenu] = useState(null);
  const [away, setAway] = useState(null); // message count when the user scrolled up, else null
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  useLayoutEffect(() => {
    if (stick.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length]);
  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stick.current && away !== null) setAway(null);
    else if (!stick.current && away === null) setAway(messages.length);
    if (menu) setMenu(null);
  };
  const toBottom = () => {
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
  };
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
  const visible = messages.filter((m) => policy(m.pubkey) !== 'blocked');
  const below = away === null ? 0 : Math.max(0, messages.length - away);
  return html`<div class="thread"><div class="messages" ref=${ref} onScroll=${onScroll}>
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
      return html`${newDay && html`<div class="day" key=${'d' + m.id}><span>${dayLabel(m.created_at)}</span></div>`}
        <div
          class=${`msg${mine ? ' mine' : ''}${first ? ' first' : ''}${last ? ' last' : ''}`}
          key=${m.id}
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
            html`<button class="quote" onClick=${() => jumpTo(quote.id)}>
              <b>${store.displayName(quote.pubkey)}</b>${previewText(quote.content).slice(0, 140)}
            </button>`}
            ${policy(m.pubkey) === 'trusted' && html`<${Media} message=${m} auto=${mine || mediaAuto(m.pubkey)} />`}
            <div class="body"><${Text} content=${m.content} links=${policy(m.pubkey) === 'trusted'} /><span class="meta">${(m.edited ?? nostr.isEdited(m.tags ?? [])) ? 'edited ' : ''}${clock(m.created_at)}${mine && html`<${Tick} id=${m.id} />`}</span></div>
            <${Reactions} message=${m} onReact=${onReact} />
          </div>
        </div>`;
    })}
    ${footer}
    ${menu && html`<${MessageMenu} menu=${menu} onReply=${onReply} onReact=${onReact} onEdit=${onEdit} onDelete=${onDelete} onClose=${() => setMenu(null)} />`}
  </div>
  ${away !== null &&
  html`<button class="to-bottom" title="Jump to latest" onClick=${toBottom}>
    ↓${below > 0 && html`<span class="unread">${below}</span>`}
  </button>`}
  </div>`;
}

function Composer({ onSend, placeholder, replyTo, onCancelReply, editing, onEdit, onCancelEdit }) {
  const [text, setText] = useState('');
  const input = useRef();
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (editing) setText(editing.content);
    if (editing || replyTo) input.current?.focus();
  }, [editing?.id, replyTo?.id]);
  const cancel = () => {
    if (editing) {
      onCancelEdit();
      setText('');
    } else onCancelReply?.();
  };
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    if (editing && value === editing.content.trim()) return cancel();
    // Clear at once like Telegram; put the text back if sending fails outright.
    setText('');
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
  return html`<footer class="composer">
    ${context &&
    html`<div class="replying">
      <span class="what">${editing ? '✎ Edit message' : `↩ Reply to ${store.displayName(replyTo.pubkey)}`}</span>
      <span class="snippet">${previewText(context.content).slice(0, 80)}</span>
      <button class="link" title="Cancel" onClick=${cancel}>✕</button>
    </div>`}
    ${error && html`<p class="error">${error}</p>`}
    <div class="row">
      <textarea
        ref=${input}
        rows="1"
        placeholder=${placeholder}
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
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

function Unread({ count }) {
  return count ? html`<span class="unread">${count > 999 ? '999+' : count}</span>` : null;
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

function PersonInfo({ pubkey, messages }) {
  const p = profiles.value[pubkey] ?? {};
  return html`<div class="hero">
      <${Avatar} pubkey=${pubkey} size=${96} />
      <h3>${pubkey === me.value.pubkey ? 'Note to self' : store.displayName(pubkey)}</h3>
      ${p.nip05 && html`<small class="muted">${p.nip05}</small>`}
    </div>
    ${p.about && html`<section><p class="about">${p.about}</p></section>`}
    <section>
      <${Field} label="DID" value=${nostr.did(pubkey)} onCopy=${() => copy(nostr.did(pubkey), 'DID copied')} />
      <${Field} label="npub" value=${nostr.shortKey(pubkey)} onCopy=${() => copy(nostr.npub(pubkey), 'npub copied')} />
      ${p.website && html`<${Field} label="Website" value=${p.website.replace(/^https:\/\//, '')} href=${p.website} />`}
      <${Field} label="Profile" value="nostr.social ↗" href=${nostr.profileUrl(pubkey)} />
    </section>
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
        <small class="mono">${profiles.value[peer]?.nip05 || nostr.shortKey(peer)}</small>
      </button>
    </header>
    <${InfoPanel}><${PersonInfo} pubkey=${peer} messages=${messages} /></${InfoPanel}>
    <${MessageList}
      ...${actions.list}
      mediaAuto=${(pk) => store.contacts.value.includes(pk)}
      messages=${messages}
      header=${html`<div class="older">
        <button class="link" disabled=${older.busy} onClick=${() => older.run(store.loadOlderDirectMessages)}>
          ${older.busy ? 'Loading…' : 'Load older messages'}
        </button>
      </div>`}
    />
    <${Composer}
      ...${actions.composer}
      placeholder="Encrypted message"
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
      <button class="wide-only" onClick=${() => copy(`${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`, 'Room link copied')}>Share</button>
      ${joined
        ? html`<button class="wide-only" onClick=${() => store.leaveRoom(room.address)}>Leave</button>`
        : html`<button class="primary" onClick=${() => store.joinRoom(room)}>Join</button>`}
    </header>
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
        <button class="danger" onClick=${store.logout}>Sign out</button>
      </div>
    </div>
  </section>`;
}

function Home() {
  return html`<section class="main empty">
    <div>
      <h2>Anagram lite</h2>
      <p class="muted">Pick a conversation, or <a href="#/new">start a new one</a>.</p>
    </div>
  </section>`;
}

function App() {
  const unread = store.totalUnread.value;
  const routeKey = `${route.value.kind}:${route.value.id ?? ''}`;
  useEffect(() => {
    infoOpen.value = false;
  }, [routeKey]);
  useEffect(() => {
    document.title = unread ? `(${unread}) Anagram lite` : 'Anagram lite';
  }, [unread]);
  if (!me.value) return html`<${Login} />`;
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
  </div>`;
}

const root = document.getElementById('app');
render(html`<p class="boot muted">Loading…</p>`, root);
store.restoreSession().finally(() => render(html`<${App} />`, root));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
