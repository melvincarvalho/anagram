// The message list: bubbles, day dividers, unread marker, context menu, reactions,
// ticks, scroll anchoring, touch gestures; plus the per-chat action hooks.
import { Fragment } from 'preact';
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { EMOJI_GROUPS } from '../emoji.js';
import { Avatar, ConfirmButton, clock, copy, dayKey, dayLabel, fail, focusMessage, forwarding, html, menuKeys, nameColor, openProfile } from './common.js';
import { EncryptedFile, Media, Text, isBigEmoji, previewText } from './text.js';
const { me, reactions } = store;

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎'];

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

export function EmojiPanel({ onPick, onClose, style = '' }) {
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
    ${m.peer && html`<p class="muted small">${m.protocol === 'ndr' ? 'Double ratchet' : 'NIP-17'}</p>`}
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
  if (status === 'queued') return html`<button class="tick" title="Queued for double-ratchet delivery — tap to retry" onClick=${() => store.retrySend(id)}>🕓</button>`;
  if (status === 'sending') return html`<span class="tick" title="Sending">🕓</span>`;
  if (status === 'failed')
    return html`<button class="tick failed" title="Not sent — tap to retry" onClick=${() => store.retrySend(id)}>⚠</button>`;
  if (status === 'partial')
    return html`<button class="tick failed" title="Reached shared relays only, not the recipient's inbox relays — tap to retry" onClick=${() => store.retrySend(id)}>⚠</button>`;
  return html`<span class="tick" title="Accepted by a relay">✓</span>`;
}

export function MessageList({ messages, policy = () => 'trusted', badge = () => '', mediaAuto = () => true, onReply, onReact, onEdit, onDelete, onHide, footer, header, unreadAfter = Infinity, onReachTop, lookupQuote, jumpOlder, onPin, pinnedId, showNames = true }) {
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
    if (!el) return; // fired after unmount
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
          ${showNames && html`<div class="slot">${last && !mine && html`<button class="person" title=${nostr.did(m.pubkey)} aria-label=${`Profile of ${store.displayName(m.pubkey)}`} onClick=${(e) => { e.stopPropagation(); openProfile(m.pubkey); }}><${Avatar} pubkey=${m.pubkey} size=${32} /></button>`}</div>`}
          <div class="bubble">
            ${showNames && first && !mine && html`<div class="who" style=${`--name-color:${nameColor(m.pubkey)}`}><button class="person" title=${nostr.did(m.pubkey)} onClick=${(e) => { e.stopPropagation(); openProfile(m.pubkey); }}>${store.displayName(m.pubkey)}</button>${tag && html`<span class="badge">${tag}</span>`}</div>`}
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

// Mark a chat read while it is on screen and the tab is visible.
export function useMarkRead(key, messages) {
  const last = messages[messages.length - 1]?.created_at ?? 0;
  useEffect(() => {
    const mark = () => key && last && document.visibilityState === 'visible' && store.markRead(key, last);
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [key, last]);
}

// Reply / edit / delete / react state shared by DM and room views.
export function useChatActions(context, messages) {
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
