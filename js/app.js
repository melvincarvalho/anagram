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

// Open someone's profile inside the app: their chat with the info panel showing. The
// nostr.social page stays one tap away from there.
let infoOnArrival = false; // openProfile: show the info panel once the new route renders
function openProfile(pubkey) {
  const target = `#/dm/${nostr.did(pubkey)}`;
  if (location.hash === target) return void (infoOpen.value = true);
  infoOnArrival = true;
  store.go(target);
}

function Mention({ pubkey }) {
  useEffect(() => store.requestProfiles([pubkey]), [pubkey]);
  return html`<a class="mention" href=${`#/dm/${nostr.did(pubkey)}`} title=${nostr.did(pubkey)} onClick=${(e) => {
    e.preventDefault();
    e.stopPropagation();
    openProfile(pubkey);
  }}>@${store.displayName(pubkey)}</a>`;
}

function Mentions({ text }) {
  return text.split(MENTION_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const pubkey = nostr.decodePubkey(part);
    return pubkey ? html`<${Mention} pubkey=${pubkey} />` : part;
  });
}

// Anagram's message formatting grammar (utils/messageFormatting.ts), ported as-is:
// **bold** *italic* _italic_ __underline__ ~strike~ ||spoiler|| `code` ```block``` [label](https://…),
// "- " bullets and \ escapes. Text only: no HTML, bounded tokens and nesting.
const FORMAT_MARKERS = { '**': 'bold', '*': 'italic', __: 'underline', _: 'italic', '~': 'strike', '~~': 'strike', '||': 'spoiler' };
const isWord = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c) => !c || /\s/u.test(c);

function formatMessage(text) {
  const root = { marker: '', start: 0, children: [] };
  const stack = [root];
  let buffer = '';
  let cursor = 0;
  let tokens = 0;
  const frame = () => stack[stack.length - 1];
  const flush = () => {
    if (buffer) frame().children.push({ type: 'text', text: buffer });
    buffer = '';
  };
  const urlPattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/iy;
  while (cursor < text.length) {
    if (tokens >= 1000) {
      flush();
      frame().children.push({ type: 'text', text: text.slice(cursor) });
      break;
    }
    const rest = text.slice(cursor);
    if (text[cursor] === '\\' && /[\\*_~|`\[\]()]/.test(text[cursor + 1] ?? '')) {
      buffer += text[cursor + 1];
      cursor += 2;
      continue;
    }
    if ((cursor === 0 || text[cursor - 1] === '\n') && /^[*-] +(?=\S)/.test(rest)) {
      buffer += '• ';
      cursor += rest.match(/^[*-] +/)[0].length;
      continue;
    }
    urlPattern.lastIndex = cursor;
    const url = !isWord(text[cursor - 1]) && urlPattern.exec(text);
    if (url) {
      // URLs stay plain text (linkified later) so underscores in them aren't formatting.
      let value = url[0];
      const marker = frame().marker;
      if (marker) {
        let end = value.indexOf(marker);
        while (end > 0 && marker.includes('_') && isWord(value[end + marker.length])) end = value.indexOf(marker, end + marker.length);
        if (end > 0) value = value.slice(0, end);
      }
      buffer += value;
      cursor += value.length;
      tokens++;
      continue;
    }
    if (rest.startsWith('`')) {
      const fence = rest.startsWith('```') ? '```' : '`';
      const end = text.indexOf(fence, cursor + fence.length);
      if (end > cursor + fence.length && (fence.length === 3 || !text.slice(cursor + 1, end).includes('\n'))) {
        flush();
        let content = text.slice(cursor + fence.length, end);
        if (fence.length === 3) content = content.replace(/^(?:[a-zA-Z][\w+-]{0,30})?\r?\n/, '').replace(/\r?\n$/, '');
        frame().children.push({ type: 'code', text: content, block: fence.length === 3 });
        cursor = end + fence.length;
        tokens++;
        continue;
      }
      buffer += fence;
      cursor += fence.length;
      tokens++;
      continue;
    }
    if (text[cursor] === '[') {
      const labelOffset = text.slice(cursor + 1, cursor + 2049).indexOf('](');
      const labelEnd = labelOffset < 0 ? -1 : cursor + 1 + labelOffset;
      if (labelEnd > cursor + 1 && labelEnd - cursor <= 2048) {
        let end = labelEnd + 2;
        let depth = 1;
        for (; end < text.length && end - labelEnd <= 4096 && depth; end++) {
          if (text[end] === '(') depth++;
          else if (text[end] === ')') depth--;
          if (/\s/.test(text[end])) break;
        }
        if (!depth) {
          const href = text.slice(labelEnd + 2, end - 1);
          let safe = false;
          try {
            const u = new URL(href);
            safe = /^https?:\/\//i.test(href) && !u.username && !u.password && !/[\s\x00-\x1f\x7f]/.test(href);
          } catch {}
          flush();
          frame().children.push(
            safe ? { type: 'link', text: text.slice(cursor + 1, labelEnd), href: new URL(href).href } : { type: 'text', text: text.slice(cursor, end) },
          );
          cursor = end;
          tokens++;
          continue;
        }
      }
      tokens++;
    }
    const marker =
      frame().marker && rest.startsWith(frame().marker) && !isSpace(text[cursor - 1])
        ? frame().marker
        : ['**', '__', '||', '~~', '*', '_', '~'].find((m) => rest.startsWith(m));
    if (marker) {
      const previous = text[cursor - 1];
      const next = text[cursor + marker.length];
      if (frame().marker === marker && (marker === '||' || !isSpace(previous)) && (!marker.includes('_') || !isWord(next))) {
        flush();
        const closed = stack.pop();
        frame().children.push({ type: 'format', format: FORMAT_MARKERS[marker], children: closed.children });
      } else if ((marker === '||' ? next !== undefined : !isSpace(next)) && (!marker.includes('_') || !isWord(previous)) && stack.length < 9) {
        flush();
        stack.push({ marker, start: cursor + marker.length, children: [] });
      } else buffer += marker;
      cursor += marker.length;
      tokens++;
      continue;
    }
    buffer += text[cursor++];
  }
  flush();
  while (stack.length > 1) {
    const unclosed = stack.pop();
    frame().children.push({ type: 'text', text: unclosed.marker }, ...unclosed.children);
  }
  return root.children;
}

const formatCache = new Map(); // content -> parsed parts (bounded)
function formatted(content) {
  let parts = formatCache.get(content);
  if (!parts) {
    parts = formatMessage(content);
    if (formatCache.size > 2000) formatCache.clear();
    formatCache.set(content, parts);
  }
  return parts;
}

const FORMAT_TAGS = { bold: 'strong', italic: 'em', underline: 'u', strike: 's' };

function Spoiler({ children }) {
  const [shown, setShown] = useState(false);
  return html`<span class=${`spoiler${shown ? ' shown' : ''}`} title=${shown ? '' : 'Tap to reveal'} onClick=${(e) => {
    if (!shown) {
      // The first tap only reveals; a link hidden inside must not navigate.
      e.stopPropagation();
      e.preventDefault();
    }
    setShown(true);
  }}>${children}</span>`;
}

function renderParts(parts, links) {
  return parts.map((p) => {
    if (p.type === 'text') return html`<${PlainText} content=${p.text} links=${links} />`;
    if (p.type === 'code') return p.block ? html`<pre class="code"><code>${p.text}</code></pre>` : html`<code>${p.text}</code>`;
    if (p.type === 'link')
      return links ? html`<a href=${p.href} target="_blank" rel="noopener noreferrer nofollow">${p.text}</a>` : html`<span>${p.text}</span>`;
    const inner = renderParts(p.children, links);
    if (p.format === 'spoiler') return html`<${Spoiler}>${inner}</${Spoiler}>`;
    return h(FORMAT_TAGS[p.format], null, inner);
  });
}

// One to three emoji and nothing else are shown large (Telegram); pattern from Anagram's singleEmoji.ts.
const EMOJI_UNIT = '(?:\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3)';
const BIG_EMOJI_RE = new RegExp(`^(?:${EMOJI_UNIT}\\s*){1,3}$`, 'u');
const isBigEmoji = (text) => text.length <= 40 && BIG_EMOJI_RE.test(text.trim());

function Text({ content, links = true }) {
  return renderParts(formatted(content), links);
}

function PlainText({ content, links = true }) {
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
const AUDIO_RE = /\.(?:mp3|m4a|ogg|oga|opus|wav|flac|aac|weba)(?:[?#]|$)/i;
// The imeta mime type decides (audio/webm is audio, not video); the extension is the fallback.
const mediaKind = (url, mime = '') =>
  mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image'
  : AUDIO_RE.test(url) ? 'audio' : VIDEO_RE.test(url) ? 'video' : IMAGE_RE.test(url) ? 'image' : null;
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
// -> [{ url, kind: 'image'|'video'|'audio' }], imeta first (its mime type is authoritative).
function extractMedia(message) {
  const items = new Map();
  for (const t of message.tags ?? [])
    if (t[0] === 'imeta') {
      const url = t.find((v) => v.startsWith('url '))?.slice(4);
      const kind = url?.startsWith('https://') && mediaKind(url, t.find((v) => v.startsWith('m '))?.slice(2) ?? '');
      if (kind) items.set(url, { url, kind });
    }
  for (const url of message.content.match(URL_RE) ?? []) {
    const kind = !items.has(url) && mediaKind(url);
    if (kind) items.set(url, { url, kind });
  }
  return [...items.values()].slice(0, 10);
}

function Media({ message, auto }) {
  const urls = mediaOf(message);
  const [shown, setShown] = useState(auto);
  if (!urls.length) return null;
  if (!shown)
    return html`<button class="show-media" onClick=${() => setShown(true)}>
      🖼 Show ${urls.length > 1 ? `${urls.length} media` : 'media'} <small>(reveals your IP to the host)</small>
    </button>`;
  const visual = urls.filter((m) => m.kind !== 'audio');
  const audio = urls.filter((m) => m.kind === 'audio');
  return html`${visual.length > 0 &&
    html`<div class=${`media n${Math.min(visual.length, 3)}`}>
      ${visual.map(({ url, kind }) =>
        kind === 'video'
          ? html`<video src=${url} controls preload="metadata" playsinline />`
          : html`<img src=${url} loading="lazy" referrerpolicy="no-referrer" alt="" onClick=${() => (viewer.value = url)} />`,
      )}
    </div>`}
    ${audio.map(({ url }) => html`<audio class="audio" src=${url} controls preload="none" />`)}`;
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
function flattenParts(parts) {
  return parts
    .map((p) =>
      p.type === 'format' && p.format === 'spoiler'
        ? '▒▒▒'
        : p.type === 'format'
          ? flattenParts(p.children)
          : p.text,
    )
    .join('');
}

function previewText(content) {
  content = flattenParts(formatted(content));
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

// Native share sheet where available (phones), otherwise copy the link.
async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  copy(url, 'Link copied');
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
  const [newName, setNewName] = useState('');
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
      if (mode === 'new') store.setUpNewAccount(newName).catch((e) => store.notify(`Profile setup failed: ${e.message}`));
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
      html`<input placeholder="Your name" maxlength="80" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <p class="muted">Generates a fresh key in this browser. Back it up from Settings afterwards.</p>`}
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

// Arrow keys move between a menu's items (focus stays inside the menu).
function menuKeys(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}

function MessageMenu({ menu, onClose, onReply, onReact, onEdit, onDelete, onHide, onMoreReactions, onPin, pinnedId }) {
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
  useEffect(() => ref.current.querySelector('[role=menuitem]:not(:disabled)')?.focus(), []);
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
  return html`<div class="menu" ref=${ref} role="menu" onKeyDown=${menuKeys}>
    ${onReact &&
    html`<div class="quick">
      ${QUICK_REACTIONS.map((e) => html`<button title=${`React ${e}`} onClick=${act(() => onReact(m, e))}>${e}</button>`)}
      <button class="more" title="More reactions" onClick=${act(() => onMoreReactions(m, menu.x, menu.y))}>＋</button>
    </div>`}
    ${onReply && html`<button role="menuitem" onClick=${act(() => onReply(m))}>↩ Reply</button>`}
    <button role="menuitem" onClick=${act(() => (forwarding.value = m))}>↪ Forward</button>
    <button role="menuitem" onClick=${act(() => copy(m.content, 'Text copied'))}>⧉ Copy text</button>
    <button role="menuitem" onClick=${act(() => copy(nostr.did(m.pubkey), 'DID copied'))}>⧉ Copy author DID</button>
    <button role="menuitem" onClick=${act(() => openProfile(m.pubkey))}>👤 View profile</button>
    ${m.pubkey === me.value.pubkey && onEdit && html`<button role="menuitem" onClick=${act(() => onEdit(m))}>✎ Edit</button>`}
    ${onPin && html`<button role="menuitem" onClick=${act(() => onPin(pinnedId === m.id ? null : m))}>📌 ${pinnedId === m.id ? 'Unpin' : 'Pin'}</button>`}
    ${m.pubkey !== me.value.pubkey &&
    html`<${ConfirmButton} role="menuitem" label=${`⛔ Block ${store.displayName(m.pubkey)}`} confirm="Tap again to block" onConfirm=${act(() => store.toggleBlock(m.pubkey).catch(fail('Block')))} />`}
    ${m.pubkey === me.value.pubkey &&
    onDelete &&
    (confirming
      ? html`<button role="menuitem" class="danger" onClick=${act(() => onDelete(m))}>🗑 Tap again to delete for everyone</button>`
      : html`<button role="menuitem" class="danger" onClick=${() => setConfirming(true)}>🗑 Delete</button>`)}
    ${onHide && html`<button role="menuitem" title="Hides it on your devices only" onClick=${act(() => onHide(m))}>🙈 Delete for me</button>`}
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
  if (status === 'partial')
    return html`<button class="tick failed" title="Reached shared relays only, not the recipient's inbox relays — tap to retry" onClick=${() => store.retrySend(id)}>⚠</button>`;
  return html`<span class="tick" title="Accepted by a relay">✓</span>`;
}

function MessageList({ messages, policy = () => 'trusted', badge = () => '', mediaAuto = () => true, onReply, onReact, onEdit, onDelete, onHide, footer, header, unreadAfter = Infinity, onReachTop, lookupQuote, jumpOlder, onPin, pinnedId, showNames = true }) {
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
  const allVisibleRef = useRef([]);
  const firstUnreadRef = useRef(null);
  const byId = Object.fromEntries(messages.flatMap((m) => [m.id, ...(m.prev ?? [])].map((id) => [id, m])));
  const first = messages[0]?.id;
  const lastMsg = messages[messages.length - 1];
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (opened.current || !allVisibleRef.current.length) return;
    opened.current = true;
    const target = firstUnreadRef.current;
    if (!target) return;
    const index = allVisibleRef.current.indexOf(target);
    const needed = allVisibleRef.current.length - index + 10;
    if (needed > limit) {
      opened.current = false; // widen the window first, then position on the next render
      return setLimit(needed);
    }
    const node = inner.current.querySelector(`[data-id="${target.id}"]`);
    if (!node) return;
    stick.current = false;
    ref.current.scrollTop += node.getBoundingClientRect().top - ref.current.getBoundingClientRect().top - 48;
    saveAnchor();
  });
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
    // Out of local messages: fetch older history from relays (infinite scroll up).
    else if (el.scrollTop < 400 && onReachTop) onReachTop();
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
  // Open at the first unread message (Telegram), marked by a divider.
  const firstUnread = allVisible.find((m) => m.created_at > unreadAfter && m.pubkey !== me.value.pubkey);
  allVisibleRef.current = allVisible;
  firstUnreadRef.current = firstUnread;
  const visibleCount = allVisible.length;
  const visible = allVisible.length > limit ? allVisible.slice(-limit) : allVisible;
  // New messages from others since you scrolled up (older pages loading above don't count).
  const awayIndex = away === null ? -1 : messages.findIndex((m) => m.id === away);
  const below = awayIndex < 0 ? 0 : messages.slice(awayIndex + 1).filter((m) => m.pubkey !== me.value.pubkey).length;
  return html`<div class="thread"><div class="messages" ref=${ref} onScroll=${onScroll} role="log" aria-live="polite" aria-label="Messages" tabindex="0"><div class="messages-inner" ref=${inner}>
    ${header}
    ${visible.map((m, i) => {
      const mine = m.pubkey === me.value.pubkey;
      const prev = visible[i - 1];
      const next = visible[i + 1];
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const first = !sameRun(prev, m);
      const last = !sameRun(m, next);
      const quoteId = m.reply ?? m.tags?.find((t) => t[0] === 'q')?.[1];
      const quote = quoteId && (byId[quoteId] ?? lookupQuote?.(quoteId));
      const tag = badge(m.pubkey);
      // Keyed per message, so loading older pages adds nodes instead of rewriting every row.
      return html`<${Fragment} key=${m.id}>${newDay && html`<div class="day"><span>${dayLabel(m.created_at)}</span></div>`}${m === firstUnread &&
        html`<div class="unread-divider"><span>Unread messages</span></div>`}
        <div
          class=${`msg${mine ? ' mine' : ''}${first ? ' first' : ''}${last ? ' last' : ''}${isBigEmoji(m.content) && !quote && m.kind !== 15 ? ' big-emoji' : ''}`}
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
          ${showNames && html`<div class="slot">${last && !mine && html`<${Avatar} pubkey=${m.pubkey} size=${32} />`}</div>`}
          <div class="bubble">
            ${showNames && first && !mine && html`<div class="who" style=${`--name-color:${nameColor(m.pubkey)}`}>${store.displayName(m.pubkey)}${tag && html`<span class="badge">${tag}</span>`}</div>`}
            ${quote &&
            html`<button class="quote" onClick=${() => (byId[quote.id] || !jumpOlder ? (focusMessage.value = quote.id) : jumpOlder(quote.id))}>
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
      onHide=${onHide}
      onPin=${onPin}
      pinnedId=${pinnedId}
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

// Voice notes: MediaRecorder on the microphone; the browser picks the container
// (audio/webm;codecs=opus in Chrome/Firefox, audio/mp4 in Safari). Stopping resolves
// with the recorded file, or null when cancelled or too short.
const VOICE_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const state = useRef(null); // { recorder, chunks, stream, startedAt, timer, done }
  const cleanup = () => {
    const s = state.current;
    if (!s) return;
    clearInterval(s.timer);
    s.stream.getTracks().forEach((t) => t.stop());
    state.current = null;
    setRecording(false);
    setSeconds(0);
  };
  const start = async () => {
    if (state.current || typeof MediaRecorder === 'undefined') return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = VOICE_MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const s = { recorder, chunks: [], stream, startedAt: Date.now(), timer: 0, done: null };
    recorder.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
    recorder.onstop = () => {
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File(s.chunks, `voice-${new Date(s.startedAt).toISOString().replace(/[:.]/g, '-')}.${ext}`, { type });
      const long = Date.now() - s.startedAt >= 700 && file.size > 0;
      s.done?.(long ? file : null);
      cleanup();
    };
    s.timer = setInterval(() => setSeconds(Math.floor((Date.now() - s.startedAt) / 1000)), 250);
    state.current = s;
    recorder.start(250);
    setRecording(true);
    return true;
  };
  const stop = ({ cancel = false } = {}) =>
    new Promise((resolve) => {
      const s = state.current;
      if (!s) return resolve(null);
      s.done = cancel ? () => resolve(null) : resolve;
      // If the recorder never reports stopping (seen with dead audio sources), settle anyway.
      const fallback = setTimeout(() => state.current === s && s.recorder.onstop(), 3000);
      const finish = s.recorder.onstop;
      s.recorder.onstop = () => {
        clearTimeout(fallback);
        s.recorder.onstop = () => {};
        finish();
      };
      s.recorder.state === 'inactive' ? s.recorder.onstop() : s.recorder.stop();
    });
  useEffect(() => () => state.current && stop({ cancel: true }), []);
  return { recording, seconds, start, stop };
}

const canRecordVoice = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

function Composer({ onSend, placeholder, replyTo, onCancelReply, editing, onEdit, onCancelEdit, draftKey, canUpload = true, mentionables = [] }) {
  const [text, setTextState] = useState(() => store.drafts.value[draftKey] ?? '');
  // Keep the per-chat draft in step with what is typed (not while editing a sent message).
  // Drafts reach the store after a pause in typing, so each keystroke doesn't re-render the sidebar.
  const draftTimer = useRef();
  const pendingDraft = useRef(null);
  // Resize whenever the text changes from code too (send clears it, drafts restore it);
  // field-sizing handles this natively where supported.
  useEffect(() => autosize(input.current), [text]);
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
    if (editing) setText(collapseMentions(editing.content));
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
    if (editing && expandMentions(value) === editing.content.trim()) return cancel();
    // Clear at once like Telegram; put the text back if sending fails outright.
    // After an edit, bring back whatever draft was there before.
    if (editing) setTextState(store.drafts.value[draftKey] ?? '');
    else setText('');
    run(async () => {
      try {
        const wire = expandMentions(value); // @Name -> nostr:nprofile… (Anagram's mention format)
        await (editing ? onEdit(editing, wire) : onSend(wire, attachmentsFor(value)));
      } catch (e) {
        setText(value);
        throw e;
      }
    });
  };
  const context = editing ?? replyTo;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Uploaded media: url -> imeta tag. Like Anagram, the URL goes into the text and only
  // URLs still present when sending become attachments.
  const uploads = useRef(new Map());
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  const textRef = useRef(text);
  textRef.current = text;
  const upload = async (files) => {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    if (!canUpload) return store.notify('Only trusted members can post media in this room.');
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const tag = await store.uploadMedia(file);
        const url = tag[1].slice(4);
        uploads.current.set(url, tag);
        const current = textRef.current;
        setText(current + (current && !current.endsWith('\n') ? '\n' : '') + url);
      } catch (e) {
        store.notify(`Upload failed: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    input.current?.focus();
  };
  const voice = useRecorder();
  const startVoice = async () => {
    if (!canUpload) return store.notify('Only trusted members can post media in this room.');
    try {
      await voice.start();
    } catch (e) {
      store.notify(e.name === 'NotAllowedError' ? 'Microphone access was refused.' : `Could not record: ${e.message}`);
    }
  };
  // Stop, upload and send as a media message: the URL is the text, the imeta tag the attachment.
  const sendVoice = () =>
    run(async () => {
      const file = await voice.stop();
      if (!file) return store.notify('Voice note too short.');
      setUploading((n) => n + 1);
      try {
        const tag = await store.uploadMedia(file);
        await onSend(tag[1].slice(4), [tag]);
      } catch (e) {
        store.notify(`Voice note failed: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    });
  const attachmentsFor = (value) => {
    const tokens = new Set(value.split(/\s+/));
    return [...uploads.current].filter(([url]) => tokens.has(url)).map(([, tag]) => tag);
  };
  // @mention autocomplete: "@query" right before the caret suggests people in this chat.
  const [mention, setMention] = useState(null); // { start, query, index }
  const updateMention = (el) => {
    const before = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}_.\-]{0,30})$/u.exec(before);
    setMention(m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase(), index: 0 } : null);
  };
  const candidates = mention
    ? nostr
        .uniq([...mentionables, ...store.contacts.value])
        .filter((pk) => pk !== me.value.pubkey && store.displayName(pk).toLowerCase().includes(mention.query))
        .slice(0, 6)
    : [];
  // The composer shows @Name; the wire format (nostr:nprofile…) is produced on send.
  const mentionMap = useRef(new Map()); // '@Name' -> pubkey
  const labelFor = (pk) => `@${store.displayName(pk).replace(/\s+/g, ' ').trim()}`;
  const expandMentions = (value) => {
    let out = value;
    for (const [label, pk] of [...mentionMap.current].sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'gu');
      out = out.replace(re, (_, before) => `${before}${nostr.mentionUri(pk)}`);
    }
    return out;
  };
  const collapseMentions = (value) =>
    value.replace(MENTION_RE, (m) => {
      const pk = nostr.decodePubkey(m);
      if (!pk) return m;
      const label = labelFor(pk);
      mentionMap.current.set(label, pk);
      return label;
    });
  const pickMention = (pk) => {
    const el = input.current;
    const end = el.selectionStart;
    const label = labelFor(pk);
    mentionMap.current.set(label, pk);
    const uri = `${label} `;
    setText(text.slice(0, mention.start) + uri + text.slice(end));
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(mention.start + uri.length, mention.start + uri.length);
    });
  };

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
  return html`<footer
    class=${`composer${dragging ? ' dragging' : ''}`}
    onDragOver=${(e) => {
      if (!editing && e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    }}
    onDragLeave=${() => setDragging(false)}
    onDrop=${(e) => {
      setDragging(false);
      if (e.dataTransfer?.files?.length && !editing) {
        e.preventDefault();
        upload(e.dataTransfer.files);
      }
    }}
  >
    ${uploading > 0 && html`<div class="uploading">Uploading ${uploading} file${uploading > 1 ? 's' : ''} to ${new URL(store.mediaServer.value).host}…</div>`}
    ${emojiOpen && html`<${EmojiPanel} onPick=${insert} onClose=${() => setEmojiOpen(false)} />`}
    ${candidates.length > 0 &&
    html`<div class="mentions-popup" role="listbox">
      ${candidates.map(
        (pk, i) => html`<button role="option" aria-selected=${i === mention.index} class=${i === mention.index ? 'on' : ''}
          onMouseDown=${(e) => {
            e.preventDefault();
            pickMention(pk);
          }}>
          <${Avatar} pubkey=${pk} size=${28} /><span><b>${store.displayName(pk)}</b> <small>${profiles.value[pk]?.nip05 || ''}</small></span>
        </button>`,
      )}
    </div>`}
    ${context &&
    html`<div class="replying">
      <span class="what">${editing ? '✎ Edit message' : `↩ Reply to ${store.displayName(replyTo.pubkey)}`}</span>
      <span class="snippet">${previewText(context.content).slice(0, 80)}</span>
      <button class="link" title="Cancel" onClick=${cancel}>✕</button>
    </div>`}
    ${error && html`<p class="error">${error}</p>`}
    <div class="row">
      <button class="icon emoji-toggle" title="Emoji" aria-label="Emoji" onClick=${() => setEmojiOpen(!emojiOpen)}>🙂</button>
      ${!editing &&
      html`<button class="icon" title="Attach photo, video or audio" aria-label="Attach file" disabled=${uploading > 0} onClick=${() => fileInput.current.click()}>
          ${uploading ? '⏳' : '📎'}
        </button>
        <input ref=${fileInput} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange=${(e) => {
          upload(e.target.files);
          e.target.value = '';
        }} />`}
      <textarea
        ref=${input}
        aria-label=${placeholder}
        rows="1"
        placeholder=${placeholder}
        value=${text}
        onInput=${(e) => {
          setText(e.target.value);
          autosize(e.target);
          updateMention(e.target);
        }}
        onBlur=${() => setTimeout(() => setMention(null), 150)}
        onPaste=${(e) => {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length && !editing) {
            e.preventDefault();
            upload(files);
          }
        }}
        onKeyDown=${(e) => {
          if (candidates.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              return setMention({ ...mention, index: (mention.index + step + candidates.length) % candidates.length });
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              return pickMention(candidates[mention.index] ?? candidates[0]);
            }
            if (e.key === 'Escape') return setMention(null);
          }
          // On touch keyboards Enter makes a new line (like Telegram mobile); send with the button.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchKeyboard) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape' && context) cancel();
          else if (e.key === 'ArrowUp' && !text && onEdit) onEdit(null);
        }}
      />
      ${!editing && !text.trim() && canRecordVoice()
        ? html`<button class="primary mic" disabled=${busy || voice.recording} title="Record a voice note" aria-label="Record a voice note" onClick=${startVoice}>
            ${busy ? '…' : '🎤'}
          </button>`
        : html`<button class="primary" disabled=${busy || !text.trim()} onClick=${send}>${busy ? '…' : editing ? 'Save' : 'Send'}</button>`}
    </div>
    ${voice.recording &&
    html`<div class="recording" role="status">
      <span class="rec-dot" aria-hidden="true" /> Recording ${String(Math.floor(voice.seconds / 60))}:${String(voice.seconds % 60).padStart(2, '0')}
      <button class="link" onClick=${() => voice.stop({ cancel: true })}>Cancel</button>
      <button class="primary" onClick=${sendVoice}>Send</button>
    </div>`}
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
      onHide: (m) => store.hideMessage(m),
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
    .filter((m) => m.kind === 'image')
    .map((m) => m.url)
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

function Field({ label, value, onCopy, href, onClick }) {
  return html`<div class="field">
    <small>${label}</small>
    ${href
      ? html`<a href=${href} target="_blank" rel="noopener noreferrer">${value}</a>`
      : onClick
        ? html`<button class="link field-link" onClick=${onClick}>${value}</button>`
        : html`<span class=${onCopy ? 'copyable mono' : ''} title=${onCopy ? 'Copy' : ''} onClick=${onCopy}>${value}</span>`}
  </div>`;
}

// A destructive action that asks for a second tap instead of a browser dialog.
function ConfirmButton({ label, confirm, onConfirm, className = 'danger', role, disabled }) {
  const [armed, setArmed] = useState(false);
  return html`<button role=${role} class=${className} disabled=${disabled} onClick=${(e) => {
    e.stopPropagation();
    if (armed) onConfirm();
    else setArmed(true);
  }}>${armed ? confirm : label}</button>`;
}

const fail = (what) => (e) => store.notify(`${what} failed: ${e.message}`);

function ChatToggles({ chatKey }) {
  return html`<section class="toggles">
    <label class="check"><input type="checkbox" checked=${store.isPinned(chatKey)} onChange=${() => store.togglePinned(chatKey)} /> 📌 Pin to top</label>
    <label class="check"><input type="checkbox" checked=${store.isMuted(chatKey)} onChange=${() => store.toggleMuted(chatKey)} /> 🔕 Mute notifications</label>
  </section>`;
}

// The person's did:nostr identity, resolved from nostr.social (did-nostr.com).
function DidIdentity({ pubkey }) {
  const entry = store.didDocs.value[pubkey];
  useEffect(() => {
    store.resolveDid(pubkey);
  }, [pubkey]);
  const count = (n) => (n == null ? '—' : n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
  const links = (entry?.alsoKnownAs ?? []).filter((u) => /^https:\/\//.test(u));
  const relays = (entry?.service ?? []).map((s) => (typeof s.serviceEndpoint === 'string' ? s.serviceEndpoint : '')).filter(Boolean);
  return html`<section class="did">
    <h4>did:nostr identity</h4>
    ${!entry && html`<p class="muted small">Resolving…</p>`}
    ${entry?.error && html`<p class="muted small">Not resolved: ${entry.error}</p>`}
    ${entry?.doc &&
    html`<div class="did-stats">
        <span><b>${count(entry.following)}</b> following</span>
        <span><b>${count(entry.followers)}</b> followers</span>
        <span title="The DID document's key matches this account">${entry.keyMatches ? '🔑 key matches' : '⚠ key mismatch'}</span>
      </div>
      ${links.length > 0 && html`<${Field} label="Also known as" value=${links.map((u) => html`<a href=${u} target="_blank" rel="noopener noreferrer">${u.replace(/^https:\/\//, '')}</a> `)} />`}
      ${relays.length > 0 && html`<${Field} label="Relays" value=${relays.map((r) => r.replace(/^wss:\/\//, '')).join(', ')} />`}`}
    <div class="buttons">
      <button onClick=${() => shareLink(nostr.chatLink(pubkey), `${store.displayName(pubkey)} on nostr.chat`)}>Share contact</button>
      <a class="button" href=${nostr.profileUrl(pubkey)} target="_blank" rel="noopener">nostr.social ↗</a>
      <a class="button" href=${nostr.didDocumentUrl(pubkey)} target="_blank" rel="noopener">DID document ↗</a>
    </div>
  </section>`;
}

// NIP-05 under a person's name: verified ✓, or the claimed address with a Verify tap
// (checking it contacts their domain), or a failed mark.
function Nip05Line({ pubkey }) {
  const verified = store.verifiedNip05(pubkey); // auto-verifies people you already deal with
  const { state, address } = store.nip05State(pubkey);
  if (state === 'none') return null;
  if (verified) return html`<small class="muted" title="Verified NIP-05 address">✓ ${address}</small>`;
  if (state === 'failed') return html`<small class="muted nip05-failed" title="This address does not point to this key">✗ ${address}</small>`;
  return html`<small class="muted nip05-unchecked">
    ${address}
    ${state === 'checking' ? html` · checking…` : html` · <button class="link" title="Checks with ${address.split('@')[1]} (they will see your IP)" onClick=${() => store.verifyNip05Now(pubkey)}>verify</button>`}
  </small>`;
}

function PersonInfo({ pubkey, messages }) {
  const p = profiles.value[pubkey] ?? {};
  return html`<div class="hero">
      <${Avatar} pubkey=${pubkey} size=${96} />
      <h3>${pubkey === me.value.pubkey ? 'Note to self' : store.displayName(pubkey)}</h3>
      <${Nip05Line} pubkey=${pubkey} />
    </div>
    ${p.about && html`<section><p class="about">${p.about}</p></section>`}
    <section>
      <${Field} label="DID" value=${nostr.did(pubkey)} onCopy=${() => copy(nostr.did(pubkey), 'DID copied')} />
      <${Field} label="npub" value=${nostr.shortKey(pubkey)} onCopy=${() => copy(nostr.npub(pubkey), 'npub copied')} />
      ${p.website && html`<${Field} label="Website" value=${p.website.replace(/^https:\/\//, '')} href=${p.website} />`}
    </section>
    <${DidIdentity} pubkey=${pubkey} />
    <${ChatToggles} chatKey=${pubkey} />
    ${pubkey !== me.value.pubkey &&
    html`<section class="actions">
      ${store.isBlocked(pubkey)
        ? html`<button onClick=${() => store.toggleBlock(pubkey).catch(fail('Unblock'))}>Unblock</button>`
        : html`<${ConfirmButton} label="⛔ Block" confirm="Tap again to block" onConfirm=${() => store.toggleBlock(pubkey).catch(fail('Block'))} />`}
      <${ConfirmButton} label="🗑 Delete chat" confirm="Tap again to delete this chat" onConfirm=${() => {
        store.deleteChat(pubkey);
        store.go('');
      }} />
    </section>`}
    <${SharedMedia} messages=${messages} allowed=${() => true} />`;
}

// Owner-only: edit the room's name, description and picture (re-signs the definition).
function RoomEditor({ room }) {
  const [form, setForm] = useState({ name: room.name, about: room.about, picture: room.picture });
  const [open, setOpen] = useState(false);
  const save = useAction();
  const upload = useAction();
  const fileInput = useRef();
  if (!open) return html`<section><button class="wide" onClick=${() => setOpen(true)}>Edit room</button></section>`;
  const changed = form.name !== room.name || form.about !== room.about || form.picture !== room.picture;
  return html`<section class="room-editor">
    <h4>Edit room</h4>
    <label>Name <input value=${form.name} maxlength="100" onInput=${(e) => setForm({ ...form, name: e.target.value })} /></label>
    <label>Description <textarea rows="3" maxlength="2000" value=${form.about} onInput=${(e) => setForm({ ...form, about: e.target.value })} /></label>
    <div class="row">
      ${form.picture ? html`<img class="avatar" src=${form.picture} width="40" height="40" referrerpolicy="no-referrer" alt="" />` : html`<${RoomAvatar} room=${room} size=${40} />`}
      <button type="button" disabled=${upload.busy} onClick=${() => fileInput.current.click()}>${upload.busy ? 'Uploading…' : 'Upload picture'}</button>
      ${form.picture && html`<button type="button" class="link" onClick=${() => setForm({ ...form, picture: '' })}>Remove</button>`}
      <input ref=${fileInput} type="file" accept="image/*" hidden onChange=${(e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) upload.run(async () => setForm({ ...form, picture: (await store.uploadMedia(file))[1].slice(4) }));
      }} />
    </div>
    ${(save.error || upload.error) && html`<p class="error">${save.error || upload.error}</p>`}
    <div class="row">
      <button class="primary" disabled=${save.busy || !changed || !form.name.trim()} onClick=${() => save.run(async () => {
        await store.updateRoom(room.address, form);
        store.notify('Room updated');
        setOpen(false);
      })}>${save.busy ? 'Saving…' : 'Save'}</button>
      <button class="link" onClick=${() => setOpen(false)}>Cancel</button>
    </div>
    <p class="muted small">Changes are signed with your key and sent to the room's relays; Anagram sees them too.</p>
  </section>`;
}

// Owner-only: a member's posting policy. Trusted members may post links and media; blocked
// members are hidden for everyone using an Anagram-compatible client.
function MemberPolicy({ room, pubkey }) {
  const current = nostr.roomPolicy(room, pubkey);
  const [busy, setBusy] = useState(false);
  const set = (policy) => {
    setBusy(true);
    store
      .setMemberPolicy(room.address, pubkey, policy)
      .catch((e) => store.notify(`Could not update member: ${e.message}`))
      .finally(() => setBusy(false));
  };
  return html`<span class="member-policy">
    ${current !== 'trusted' && html`<button class="link" disabled=${busy} title="Allow links and media" onClick=${() => set('trusted')}>Trust</button>`}
    ${current !== 'plain' && html`<button class="link" disabled=${busy} title="Plain text only" onClick=${() => set('plain')}>${current === 'blocked' ? 'Unblock' : 'Untrust'}</button>`}
    ${current !== 'blocked' && html`<${ConfirmButton} className="link danger-text" disabled=${busy} label="Block" confirm="Confirm block" onConfirm=${() => set('blocked')} />`}
  </span>`;
}

function RoomInfo({ room, messages }) {
  const isOwner = room.owner === me.value.pubkey;
  const authors = [...new Set([...messages.map((m) => m.pubkey), ...(isOwner ? [...room.trusted, ...room.blocked] : [])])].filter((pk) => isOwner || nostr.roomPolicy(room, pk) !== 'blocked');
  const order = { owner: 0, trusted: 1, plain: 2, blocked: 3 };
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
      <${Field} label="Owner" value=${store.displayName(room.owner)} onClick=${() => openProfile(room.owner)} />
      <${Field} label="Relays" value=${room.relays.map((r) => r.replace(/^wss:\/\//, '')).join(', ')} />
    </section>
    <${ChatToggles} chatKey=${room.address} />
    ${isOwner && html`<${RoomEditor} room=${room} key=${room.event.id} />`}
    <${SharedMedia} messages=${messages} allowed=${(pk) => nostr.roomPolicy(room, pk) === 'trusted'} />
    ${joinedRooms.value.some((r) => r.address === room.address) &&
    html`<section><button class="danger wide" onClick=${() => store.leaveRoom(room.address)}>Leave room</button></section>`}
    <section>
      <h4>Members</h4>
      ${authors.map(
        (pk) => html`<div class="item member" key=${pk}>
          <a class="who-link" href=${`#/dm/${nostr.did(pk)}`}><${Avatar} pubkey=${pk} size=${32} /></a>
          <a class="label who-link" href=${`#/dm/${nostr.did(pk)}`}><b>${store.displayName(pk)}</b></a>
          ${role(pk) !== 'plain' && html`<span class=${`badge ${role(pk)}`}>${role(pk)}</span>`}
          ${isOwner && pk !== room.owner && html`<${MemberPolicy} room=${room} pubkey=${pk} />`}
        </div>`,
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
  // Read position when the chat was opened (before it gets marked read).
  const [unreadAfter] = useState(() => (peer ? store.readPoint(peer) : Infinity));
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
    ${store.isBlocked(peer)
      ? html`<footer class="composer blocked-bar">You blocked this person.
          <button onClick=${() => store.toggleBlock(peer).catch(fail('Unblock'))}>Unblock</button></footer>`
      : html`<${Composer}
      ...${actions.composer}
      placeholder="Encrypted message"
      draftKey=${peer}
      mentionables=${[peer]}
      onSend=${async (text, tags) => {
        await store.sendDirectMessage(peer, text, actions.composer.replyTo, null, tags);
        actions.clearReply();
      }}
    />`}
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
    <${Composer}
      ...${actions.composer}
      mentionables=${nostr.uniq(state.messages.map((m) => m.pubkey).reverse())}
      placeholder="Public message — anyone can read this"
      draftKey=${room.address}
      canUpload=${nostr.roomPolicy(room, me.value.pubkey) === 'trusted'}
      onSend=${async (text, tags) => {
        await store.sendRoomMessage(room.address, text, actions.composer.replyTo, tags);
        if (!joined) store.joinRoom(room);
        actions.clearReply();
      }}
    />
  </section>`;
}

// Find someone to message: paste an identity, search nostr.social, or pick from your follows.
function PeopleFinder() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ q: '', people: [], error: '' });
  const [follows, setFollows] = useState(null);
  const open = useAction();
  const q = query.trim();
  const direct = nostr.decodePubkey(q);
  useEffect(() => {
    store.followsOf(me.value.pubkey).then(setFollows, () => setFollows([]));
  }, []);
  useEffect(() => {
    if (q.length < 2 || direct || q.includes('@')) return setResults({ q: '', people: [], error: '' });
    const timer = setTimeout(() => {
      nostr.searchDirectory(q, 20).then(
        (people) => {
          store.rememberProfiles(people);
          setResults({ q, people, error: '' });
        },
        (e) => setResults({ q, people: [], error: e.message }),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);
  const go = (pk) => store.go(`#/dm/${nostr.did(pk)}`);
  const lower = q.toLowerCase();
  const followRows = (follows ?? []).filter((pk) => !lower || store.displayName(pk).toLowerCase().includes(lower)).slice(0, 60);
  useEffect(() => follows && store.requestProfiles(follows.slice(0, 60)), [follows]);
  const row = (pk, extra) => html`<button class="item person" onClick=${() => go(pk)}>
    <${Avatar} pubkey=${pk} />
    <span class="label">
      <b>${store.displayName(pk)}</b>
      <small>${extra ?? (profiles.value[pk]?.nip05 || nostr.shortKey(pk))}</small>
    </span>
  </button>`;
  return html`<div class="card people">
    <h3>New message</h3>
    <form onSubmit=${(e) => {
      e.preventDefault();
      open.run(async () => go((await nostr.resolvePubkey(q)).pubkey));
    }}>
      <input autofocus placeholder="Search people, or paste did:nostr / nostr.social link / name@domain" value=${query} onInput=${(e) => setQuery(e.target.value)} />
    </form>
    ${open.error && html`<p class="error">${open.error}</p>`}
    <div class="people-list">
      ${direct && row(direct, nostr.did(direct))}
      ${!direct && q.includes('@') && html`<button class="item person" onClick=${() => open.run(async () => go((await nostr.resolvePubkey(q)).pubkey))}>
        <span class="avatar room">@</span><span class="label"><b>Look up ${q}</b><small>NIP-05 address</small></span></button>`}
      ${results.q === q &&
      results.people.map((p) => row(p.pubkey, `${p.nip05 || nostr.shortKey(p.pubkey)} · ${p.followers} followers`))}
      ${results.q === q && !results.people.length && !results.error && html`<p class="muted small">No people found on nostr.social.</p>`}
      ${results.error && html`<p class="muted small">Search unavailable: ${results.error}</p>`}
      ${!direct && followRows.length > 0 && html`<h4>People you follow</h4>${followRows.map((pk) => row(pk))}`}
      ${follows === null && html`<p class="muted small">Loading people you follow…</p>`}
    </div>
    <p class="muted small">Search by nostr.social · results are signature-checked.</p>
  </div>`;
}

function NewThing() {
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const join = useAction();
  const create = useAction();
  return html`<section class="main scroll">
    <header class="bar"><a class="back" href="#">‹</a><div class="title"><b>New</b></div></header>
    <div class="forms">
      <${PeopleFinder} />
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
        <p class="muted small">Your identity is this did:nostr. Anyone can resolve it at nostr.social.</p>
        <div class="buttons">
          <button onClick=${() => copy(nostr.did(signer.pubkey), 'DID copied')}>Copy DID</button>
          <button onClick=${() => copy(nostr.npub(signer.pubkey), 'npub copied')}>Copy npub</button>
          <button class="primary" onClick=${() => shareLink(nostr.chatLink(signer.pubkey), 'Message me on nostr.chat')}>Share my link</button>
          <a class="button" href=${nostr.profileUrl(signer.pubkey)} target="_blank" rel="noopener">nostr.social ↗</a>
          <a class="button" href=${nostr.didDocumentUrl(signer.pubkey)} target="_blank" rel="noopener">DID document ↗</a>
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
      <${ProfileSettings} />
      <${MediaServerSettings} />
      <${RelaySettings} />
      <${BlockedSettings} />
      <${NotificationSettings} />
      <div class="card">
        <h3>Privacy</h3>
        <p class="muted small">
          Messages are end-to-end encrypted. Relays, the nostr.social directory (profiles and search), the media server and the hosts of
          pictures you open can see your IP address. Media from strangers and NIP-05 checks for strangers wait for your tap.
          <a href="https://github.com/melvincarvalho/anagram#privacy" target="_blank" rel="noopener noreferrer">Full details ↗</a>
        </p>
      </div>
      <div class="card">
        <button class="danger" onClick=${store.logout}>Sign out of this account</button>
      </div>
    </div>
  </section>`;
}

function ProfileSettings() {
  const pk = me.value.pubkey;
  const p = profiles.value[pk] ?? {};
  const [form, setForm] = useState({ name: p.name ?? '', about: p.about ?? '', picture: p.picture ?? '', website: p.website ?? '', nip05: p.nip05 ?? '' });
  const save = useAction();
  const upload = useAction();
  const fileInput = useRef();
  const field = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return html`<form class="card profile-form" onSubmit=${(e) => {
    e.preventDefault();
    save.run(async () => {
      if (form.picture && !/^https:\/\//.test(form.picture)) throw new Error('The picture must be an https:// link.');
      if (form.website && !/^https:\/\//.test(form.website)) throw new Error('The website must be an https:// link.');
      await store.saveProfile(form);
      store.notify('Profile saved');
    });
  }}>
    <h3>Profile</h3>
    <div class="profile-head">
      ${form.picture ? html`<img class="avatar" src=${form.picture} width="64" height="64" referrerpolicy="no-referrer" alt="" />` : html`<${Avatar} pubkey=${pk} size=${64} />`}
      <button type="button" disabled=${upload.busy} onClick=${() => fileInput.current.click()}>${upload.busy ? 'Uploading…' : 'Upload picture'}</button>
      <input ref=${fileInput} type="file" accept="image/*" hidden onChange=${(e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) upload.run(async () => setForm({ ...form, picture: (await store.uploadMedia(file))[1].slice(4) }));
      }} />
    </div>
    <label>Name<input maxlength="80" value=${form.name} onInput=${field('name')} placeholder="How people see you" /></label>
    <label>Bio<textarea rows="3" maxlength="600" value=${form.about} onInput=${field('about')} placeholder="A few words about you" /></label>
    <label>Picture link<input value=${form.picture} onInput=${field('picture')} placeholder="https://…" /></label>
    <label>Website<input value=${form.website} onInput=${field('website')} placeholder="https://…" /></label>
    <label>NIP-05 address<input value=${form.nip05} onInput=${field('nip05')} placeholder="you@example.com" /></label>
    <p class="muted small">Public: published as your Nostr profile (kind 0), visible in every Nostr app. Other fields set elsewhere are kept.</p>
    ${(save.error || upload.error) && html`<p class="error">${save.error || upload.error}</p>`}
    <button class="primary" disabled=${save.busy}>${save.busy ? 'Saving…' : 'Save profile'}</button>
  </form>`;
}

function MediaServerSettings() {
  const [value, setValue] = useState(store.mediaServer.value);
  const save = useAction();
  return html`<form class="card" onSubmit=${(e) => {
    e.preventDefault();
    save.run(async () => {
      store.setMediaServer(value);
      store.notify('Media server saved');
    });
  }}>
    <h3>Media server</h3>
    <p class="muted small">Photos and videos you send are uploaded unencrypted to this Blossom server; anyone with the link can view them.</p>
    <input value=${value} onInput=${(e) => setValue(e.target.value)} placeholder=${nostr.DEFAULT_BLOSSOM} />
    ${save.error && html`<p class="error">${save.error}</p>`}
    <button disabled=${save.busy}>Save</button>
  </form>`;
}

// NIP-17 inbox relays: where others deliver your DMs. Suggestions come from
// nostr.social's relay health directory (public relays ranked by uptime and latency).
function RelaySettings() {
  const current = store.inboxRelays.value;
  const [list, setList] = useState(null); // null = not editing
  const [draft, setDraft] = useState('');
  const save = useAction();
  const editing = list ?? current ?? [];
  useEffect(() => store.loadRelayDirectory(), []);
  const suggestions = (store.relayDirectory.value ?? []).filter((r) => !editing.includes(r.url) && !r.requiresPayment).slice(0, 8);
  const add = (url) => {
    const n = nostr.normalizeRelay(url.trim());
    if (!n) return store.notify('Enter a wss:// relay address.');
    if (!editing.includes(n)) setList([...editing, n]);
    setDraft('');
  };
  const dirty = list && (list.length !== (current ?? []).length || list.some((r, i) => r !== current?.[i]));
  return html`<div class="card relays">
    <h3>Inbox relays</h3>
    <p class="muted small">Where other people deliver your encrypted messages (NIP-17). Pick two or three reliable ones; they are published signed by your key, with a matching relay list for other apps and your did:nostr document.</p>
    ${current === null && html`<p class="muted small">Loading your current list…</p>`}
    ${current?.length === 0 && !list && html`<p class="error">You haven't published inbox relays yet, so people can only reach you through the shared app relays.</p>`}
    <ul class="relay-list">
      ${editing.map((r) => html`<li key=${r}><span class="mono">${r.replace(/^wss:\/\//, '')}</span>
        <button class="link" title="Remove" aria-label=${`Remove ${r}`} onClick=${() => setList(editing.filter((x) => x !== r))}>✕</button></li>`)}
    </ul>
    <form class="row" onSubmit=${(e) => { e.preventDefault(); add(draft); }}>
      <input value=${draft} placeholder="wss://relay.example.com" onInput=${(e) => setDraft(e.target.value)} />
      <button type="submit" disabled=${!draft.trim()}>Add</button>
    </form>
    ${suggestions.length > 0 && html`<details class="suggestions">
      <summary>Suggested relays <small class="muted">from nostr.social's health checks</small></summary>
      ${suggestions.map((r) => html`<div class="suggestion" key=${r.url}>
        <span class="mono">${r.url.replace(/^wss:\/\//, '')}</span>
        <small class="muted">${r.uptime}% up · ${r.responseTime} ms${r.requiresAuth ? ' · auth' : ''}</small>
        <button class="link" onClick=${() => add(r.url)}>+ Add</button>
      </div>`)}
    </details>`}
    ${save.error && html`<p class="error">${save.error}</p>`}
    <div class="row">
      <button class="primary" disabled=${save.busy || !dirty} onClick=${() => save.run(async () => {
        await store.saveInboxRelays(editing);
        setList(null);
        store.notify('Inbox relays published');
      })}>${save.busy ? 'Publishing…' : 'Publish'}</button>
      ${dirty && html`<button class="link" onClick=${() => setList(null)}>Cancel</button>`}
    </div>
  </div>`;
}

function BlockedSettings() {
  const list = store.blocked.value;
  useEffect(() => store.requestProfiles(list), [list.length]);
  return html`<div class="card">
    <h3>Blocked</h3>
    ${list.length === 0 && html`<p class="muted small">You haven't blocked anyone.</p>`}
    ${list.map(
      (pk) => html`<div class="item blocked-row" key=${pk}>
        <${Avatar} pubkey=${pk} size=${32} />
        <span class="label"><b>${store.displayName(pk)}</b><small class="mono">${nostr.shortKey(pk)}</small></span>
        <button onClick=${() => store.toggleBlock(pk).catch(fail('Unblock'))}>Unblock</button>
      </div>`,
    )}
    <p class="muted small">Blocks are kept in your encrypted mute list, shared with Anagram.</p>
  </div>`;
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

const CONNECTION_TEXT = { offline: 'Waiting for network…', connecting: 'Connecting…', updating: 'Updating…' };

function ConnectionBanner() {
  const state = store.connection.value;
  if (state === 'ok') return null;
  return html`<div class=${`connection ${state}`} role="status" aria-live="polite">
    ${state === 'updating' ? html`<span class="spinner" />` : '⚠'} ${CONNECTION_TEXT[state]}
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
    infoOpen.value = infoOnArrival;
    infoOnArrival = false;
    chatSearch.value = false;
  }, [routeKey]);
  useEffect(() => {
    const inChat = () => ['dm', 'room'].includes(route.value.kind);
    const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && inChat()) {
        e.preventDefault();
        chatSearch.value = true;
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        // Jump to the chat list search.
        e.preventDefault();
        document.querySelector('.sidebar .search input')?.focus();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // Previous / next chat in sidebar order (Telegram desktop).
        e.preventDefault();
        const links = [...document.querySelectorAll('.sidebar nav a.item')].map((a) => a.getAttribute('href'));
        const at = links.indexOf(location.hash);
        const next = links[at < 0 ? 0 : at + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) store.go(next);
      } else if (e.key === 'Escape' && !typing(document.activeElement)) {
        if (infoOpen.value) infoOpen.value = false;
        else if (chatSearch.value) chatSearch.value = false;
      } else if (inChat() && !typing(document.activeElement) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Start typing anywhere in a chat: the keystroke goes to the composer.
        document.querySelector('.composer textarea')?.focus();
      }
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    document.title = unread ? `(${unread}) nostr.chat` : 'nostr.chat';
    // Installed-app icon badge (where supported).
    try {
      if (unread) navigator.setAppBadge?.(unread)?.catch?.(() => {});
      else navigator.clearAppBadge?.()?.catch?.(() => {});
    } catch {}
  }, [unread]);
  if (!me.value && store.restoring.value) return html`<p class="boot muted">Loading…</p>`;
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
    <${ConnectionBanner} />
    <${Viewer} />
    <${ForwardPicker} />
  </div>`;
}

const root = document.getElementById('app');
// A failed relay AUTH exchange (our signer failing, or the relay refusing the answer, e.g.
// "relay needs serviceUrl to be configured") is rethrown by nostr-tools with nothing to
// catch it. Log it once and keep it out of the console; publishes that needed AUTH still
// fail normally through their own promises.
let authRejectionLogged = false;
addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  if (!(reason?.relayAuth || /\bauth\b/i.test(String(reason?.message ?? '')))) return;
  if (!authRejectionLogged && !reason?.relayAuth) console.warn(`[nostr] relay AUTH failed: ${reason.message}`);
  authRejectionLogged = true;
  e.preventDefault();
});

render(html`<${App} />`, root);
store.restoreSession();

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
