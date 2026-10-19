import { h, render } from 'preact';
import { useState, useEffect, useRef, useLayoutEffect } from 'preact/hooks';
import htm from 'htm';
import * as nostr from './nostr.js';
import * as store from './store.js';

const html = htm.bind(h);
const { me, route, profiles, conversations, dms, joinedRooms, roomState, inboxRelays, syncing, toast } = store;

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

function Text({ content, links = true }) {
  if (!links) return html`<span>${content.replace(URL_RE, '[link removed]')}</span>`;
  return content
    .split(URL_RE)
    .map((part, i) =>
      i % 2 ? html`<a href=${part} target="_blank" rel="noopener noreferrer nofollow">${part}</a>` : part,
    );
}

const time = (ts) => {
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

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
            <small>${last ? `${store.displayName(last.pubkey)}: ${last.content.slice(0, 80)}` : 'Public room'}</small>
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
            <small>${last ? `${last.pubkey === me.value.pubkey ? 'You: ' : ''}${last.content.slice(0, 80)}` : 'No messages yet'}</small>
          </span>
        </a>`;
      })}
    </nav>
  </aside>`;
}

// ---------- Messages ----------

function MessageList({ messages, policy = () => 'trusted', badge = () => '', onReply, footer, header }) {
  const ref = useRef();
  const stick = useRef(true);
  const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
  useLayoutEffect(() => {
    if (stick.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages.length]);
  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  const visible = messages.filter((m) => policy(m.pubkey) !== 'blocked');
  return html`<div class="messages" ref=${ref} onScroll=${onScroll}>
    ${header}
    ${visible.map((m, i) => {
      const mine = m.pubkey === me.value.pubkey;
      const prev = visible[i - 1];
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const grouped = !newDay && prev.pubkey === m.pubkey && m.created_at - prev.created_at < 300;
      const quoteId = m.reply ?? m.tags?.find((t) => t[0] === 'q')?.[1];
      const quote = quoteId && byId[quoteId];
      const tag = badge(m.pubkey);
      return html`${newDay && html`<div class="day" key=${'d' + m.id}><span>${dayLabel(m.created_at)}</span></div>`}
        <div class=${`msg${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`} key=${m.id}>
          ${!grouped && !mine && html`<${Avatar} pubkey=${m.pubkey} size=${28} />`}
          <div class="bubble">
            ${!grouped && !mine && html`<div class="who">${store.displayName(m.pubkey)}${tag && html`<span class="badge">${tag}</span>`}</div>`}
            ${quote && html`<div class="quote"><b>${store.displayName(quote.pubkey)}</b> ${quote.content.slice(0, 140)}</div>`}
            <div class="body"><${Text} content=${m.content} links=${policy(m.pubkey) === 'trusted'} /></div>
            <div class="meta">
              ${time(m.created_at)}
              ${onReply && html` · <button class="link" onClick=${() => onReply(m)}>Reply</button>`}
            </div>
          </div>
        </div>`;
    })}
    ${footer}
  </div>`;
}

function Composer({ onSend, placeholder, replyTo, onCancelReply }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    run(async () => {
      await onSend(value);
      setText('');
    });
  };
  return html`<footer class="composer">
    ${replyTo &&
    html`<div class="replying">Replying to ${store.displayName(replyTo.pubkey)}: ${replyTo.content.slice(0, 80)}
      <button class="link" onClick=${onCancelReply}>✕</button></div>`}
    ${error && html`<p class="error">${error}</p>`}
    <div class="row">
      <textarea
        rows="1"
        placeholder=${placeholder}
        value=${text}
        onInput=${(e) => setText(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button class="primary" disabled=${busy || !text.trim()} onClick=${send}>${busy ? '…' : 'Send'}</button>
    </div>
  </footer>`;
}

// ---------- Views ----------

function DirectChat({ id }) {
  const peer = nostr.decodePubkey(id);
  const older = useAction();
  useEffect(() => peer && store.requestProfiles([peer]), [peer]);
  if (!peer) return html`<section class="main empty"><p class="error">Invalid contact.</p></section>`;
  const messages = dms.value[peer] ?? [];
  return html`<section class="main">
    <header class="bar">
      <a class="back" href="#">‹</a>
      <${Avatar} pubkey=${peer} size=${32} />
      <div class="title">
        <a class="name" href=${nostr.profileUrl(peer)} target="_blank" rel="noopener" title="View profile on nostr.social">
          ${peer === me.value.pubkey ? 'Note to self' : store.displayName(peer)}
        </a>
        <small class="mono" title=${nostr.did(peer)} onClick=${() => copy(nostr.did(peer), 'DID copied')}>${nostr.shortKey(peer)}</small>
      </div>
    </header>
    <${MessageList}
      messages=${messages}
      header=${html`<div class="older">
        <button class="link" disabled=${older.busy} onClick=${() => older.run(store.loadOlderDirectMessages)}>
          ${older.busy ? 'Loading…' : 'Load older messages'}
        </button>
      </div>`}
    />
    <${Composer} placeholder="Encrypted message" onSend=${(text) => store.sendDirectMessage(peer, text)} />
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
  const [replyTo, setReplyTo] = useState(null);
  const older = useAction();
  useEffect(() => {
    if (pointer) store.openRoom(pointer);
  }, [pointer?.address]);
  if (!pointer) return html`<section class="main empty"><p class="error">${invalid}</p></section>`;
  const state = roomState.value[pointer.address] ?? { messages: [], loading: true };
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
      <div class="title">
        <b>${room.name}</b>
        <small>${room.about || `by ${store.displayName(room.owner)}`}</small>
      </div>
      <button onClick=${() => copy(`${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`, 'Room link copied')}>Share</button>
      ${joined
        ? html`<button onClick=${() => store.leaveRoom(room.address)}>Leave</button>`
        : html`<button class="primary" onClick=${() => store.joinRoom(room)}>Join</button>`}
    </header>
    ${state.pinnedEvent &&
    policy(state.pinnedEvent.pubkey) !== 'blocked' &&
    html`<div class="pinned" title="Pinned message">
      <b>Pinned</b> <span><${Text} content=${state.pinnedEvent.content} links=${policy(state.pinnedEvent.pubkey) === 'trusted'} /></span>
    </div>`}
    <${MessageList}
      messages=${state.messages}
      policy=${policy}
      badge=${(pk) => (pk === room.owner ? 'owner' : '')}
      onReply=${setReplyTo}
      header=${html`<div class="older">
        ${state.exhausted
          ? html`<span class="muted small">Start of room history</span>`
          : html`<button class="link" disabled=${older.busy} onClick=${() => older.run(() => store.loadOlderRoomMessages(room.address))}>
              ${older.busy ? 'Loading…' : 'Load older messages'}
            </button>`}
      </div>`}
    />
    <${Composer}
      placeholder="Public message — anyone can read this"
      replyTo=${replyTo}
      onCancelReply=${() => setReplyTo(null)}
      onSend=${async (text) => {
        await store.sendRoomMessage(room.address, text, replyTo);
        if (!joined) store.joinRoom(room);
        setReplyTo(null);
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
  </div>`;
}

const root = document.getElementById('app');
render(html`<p class="boot muted">Loading…</p>`, root);
store.restoreSession().finally(() => render(html`<${App} />`, root));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
