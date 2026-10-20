// Shared UI state and small pieces: the html tag, cross-view signals, theme, helpers,
// avatars, confirm buttons and fields.
import { h } from 'preact';
import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import htm from 'htm';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
const { profiles } = store;

export const html = htm.bind(h);

export function Avatar({ pubkey, size = 36 }) {
  const picture = profiles.value[pubkey]?.picture;
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  return picture
    ? html`<img class="avatar" src=${picture} width=${size} height=${size} loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : html`<span class="avatar" style=${`width:${size}px;height:${size}px;background:hsl(${hue} 45% 45%)`}>
        ${store.displayName(pubkey).replace(/^npub1/, '').slice(0, 1).toUpperCase()}
      </span>`;
}

// Open someone's profile inside the app: their chat with the info panel showing. The
// nostr.social page stays one tap away from there.
let infoOnArrival = false; // openProfile: show the info panel once the new route renders
export function openProfile(pubkey) {
  const target = `#/dm/${nostr.did(pubkey)}`;
  if (location.hash === target) return void (infoOpen.value = true);
  infoOnArrival = true;
  store.go(target);
}
// Read and clear the flag (the App does this when a route renders).
export function takeInfoOnArrival() {
  const v = infoOnArrival;
  infoOnArrival = false;
  return v;
}

export const viewer = signal(null); // full-screen media url
export const infoOpen = signal(false); // chat info panel
export const forwarding = signal(null); // message being forwarded

// Theme: 'system' | 'light' | 'dark', per device. index.html applies it before first paint.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const readTheme = () => {
  try {
    return JSON.parse(localStorage.getItem('lite:theme')) ?? 'system';
  } catch {
    return 'system';
  }
};
export const theme = signal(readTheme());
export const isDark = () => theme.value === 'dark' || (theme.value === 'system' && darkQuery.matches);
export function setTheme(value) {
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
export const chatSearch = signal(false); // in-chat search bar open
export const focusMessage = signal(null); // message id to scroll to and flash once it is rendered

// Telegram gives each sender a stable name colour.
const NAME_COLORS = ['#e17076', '#7bc862', '#e5a64e', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
export const nameColor = (pk) => NAME_COLORS[parseInt(pk.slice(-2), 16) % NAME_COLORS.length];

export const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function useAction() {
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

export const dayKey = (ts) => new Date(ts * 1000).toDateString();
export function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
export const shortTime = (ts) =>
  dayKey(ts) === new Date().toDateString()
    ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric' });

export function RoomAvatar({ room, size = 36 }) {
  return room.picture
    ? html`<img class="avatar room" src=${room.picture} width=${size} height=${size} loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : html`<span class="avatar room" style=${`width:${size}px;height:${size}px`}>#</span>`;
}

// Native share sheet where available (phones), otherwise copy the link.
export async function shareLink(url, title) {
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

export async function copy(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    store.notify(label);
  } catch {
    store.notify('Copy failed');
  }
}

// Arrow keys move between a menu's items (focus stays inside the menu).
export function menuKeys(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}

export function Unread({ count, muted }) {
  return count ? html`<span class=${`unread${muted ? ' muted' : ''}`}>${count > 999 ? '999+' : count}</span>` : null;
}

export function Field({ label, value, onCopy, href, onClick }) {
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
export function ConfirmButton({ label, confirm, onConfirm, className = 'danger', role, disabled }) {
  const [armed, setArmed] = useState(false);
  return html`<button role=${role} class=${className} disabled=${disabled} onClick=${(e) => {
    e.stopPropagation();
    if (armed) onConfirm();
    else setArmed(true);
  }}>${armed ? confirm : label}</button>`;
}

export const fail = (what) => (e) => store.notify(`${what} failed: ${e.message}`);

// Touch devices without a hardware keyboard: Enter inserts a newline.
export const touchKeyboard = matchMedia('(hover: none) and (pointer: coarse)').matches;

// Grow the composer with its text (field-sizing isn't available everywhere, e.g. Firefox).
export function autosize(el) {
  if (!el || CSS.supports('field-sizing', 'content')) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`;
}
