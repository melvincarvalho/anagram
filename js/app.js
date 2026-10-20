// nostr.chat: the app root. Routing, keyboard shortcuts, the title badge, mounting.
// Everything visible lives in ./ui/ by feature; everything stateful in ./store.js.
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import * as store from './store.js';
import { chatSearch, html, infoOpen, takeInfoOnArrival } from './ui/common.js';
import { Viewer } from './ui/text.js';
import { Login } from './ui/login.js';
import { Sidebar } from './ui/sidebar.js';
import { DirectChat, RoomChat } from './ui/chats.js';
import { NewThing } from './ui/new.js';
import { Settings } from './ui/settings.js';
import { ForwardPicker } from './ui/forward.js';
import './ui/notifications.js';
const { me, route, toast } = store;

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
    infoOpen.value = takeInfoOnArrival();
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
