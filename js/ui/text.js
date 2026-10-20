// Message text: Anagram's formatting grammar, mentions, links, media detection and the
// media viewer, previews, and NIP-17 encrypted files.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { html, openProfile, viewer } from './common.js';

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

// Profile references: nostr:npub…/nprofile… (NIP-27) and did:nostr:<hex>.
export const MENTION_RE = /((?:nostr:)?(?:npub1|nprofile1)[02-9ac-hj-np-z]{20,}|did:nostr:[a-f0-9]{64})/g;

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
export const isBigEmoji = (text) => text.length <= 40 && BIG_EMOJI_RE.test(text.trim());

export function Text({ content, links = true }) {
  return renderParts(formatted(content), links);
}

function PlainText({ content, links = true }) {
  const parts = content.split(URL_RE);
  return parts.map((part, i) =>
    i % 2 === 0
      ? html`<${Mentions} text=${part} />`
      : links
        ? html`<a href=${part} target="_blank" rel="noopener noreferrer nofollow">${part}</a>`
        : // Untrusted room author: the words stay, nothing is clickable (Anagram drops the URL).
          html`<span class="plain-link" title="Links from untrusted members are not clickable">${part}</span>`,
  );
}

const IMAGE_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i;
const VIDEO_RE = /\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i;
const AUDIO_RE = /\.(?:mp3|m4a|ogg|oga|opus|wav|flac|aac|weba)(?:[?#]|$)/i;
// The imeta mime type decides (audio/webm is audio, not video); the extension is the fallback.
const mediaKind = (url, mime = '') =>
  mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image'
  : AUDIO_RE.test(url) ? 'audio' : VIDEO_RE.test(url) ? 'video' : IMAGE_RE.test(url) ? 'image' : null;

export function Highlight({ text, q }) {
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
export function snippet(content, q) {
  const text = previewText(content).replace(/\s+/g, ' ');
  const at = text.toLowerCase().indexOf(q);
  const start = Math.max(0, at - 30);
  return (start ? '…' : '') + text.slice(start, start + 90);
}

// Media URLs from the text plus NIP-92 imeta attachments.
// Parsing is cached per message object (messages are immutable; edits create new objects).
const mediaCache = new WeakMap();
export function mediaOf(message) {
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

export function Media({ message, auto }) {
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

export function Viewer() {
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

export function previewText(content) {
  content = flattenParts(formatted(content));
  return content.replace(MENTION_RE, (m) => {
    const pk = nostr.decodePubkey(m);
    return pk ? `@${store.displayName(pk)}` : m;
  });
}

// NIP-17 kind 15: an AES-GCM encrypted file. Decrypt it locally when asked.
export function EncryptedFile({ message }) {
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
