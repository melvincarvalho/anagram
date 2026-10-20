// Settings: account, messaging, inbox relays, appearance, profile, media server,
// blocked, notifications.
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, copy, fail, html, setTheme, shareLink, theme, useAction } from './common.js';
import { playSound } from './sounds.js';
const { me, profiles, inboxRelays } = store;

function MessagingDevices({ owner }) {
  const [state, setState] = useState({ owner, loading: true, devices: [], error: '' });
  const request = useRef(0);
  const refresh = async () => {
    const current = ++request.current;
    setState({ owner, loading: true, devices: [], error: '' });
    try {
      const { loadMessagingDevices } = await import('../messaging-devices.js');
      const devices = await loadMessagingDevices(owner);
      if (request.current === current) setState({ owner, loading: false, devices, error: '' });
    } catch {
      if (request.current === current) setState({ owner, loading: false, devices: [], error: 'Could not load devices. Try refreshing.' });
    }
  };
  // Reading the roster contacts the ratchet relays (relay.snort.social included), so it
  // happens by itself only once this browser has registered; otherwise on request.
  const [wanted, setWanted] = useState(store.ndrActivated.value);
  useEffect(() => {
    if (wanted) refresh();
    else setState({ owner, loading: false, devices: [], error: '' });
    return () => { request.current++; };
  }, [owner, wanted]);
  const visible = state.owner === owner ? state : { loading: true, devices: [], error: '' };
  if (!wanted)
    return html`<div data-testid="messaging-devices">
      <h4>Messaging devices</h4>
      <p class="muted small">This browser has not registered as a device.</p>
      <button class="link" onClick=${() => setWanted(true)}>Show devices registered by other clients</button>
    </div>`;
  return html`<div data-testid="messaging-devices">
    <h4>Messaging devices</h4>
    ${visible.loading ? html`<p class="muted small" role="status">Loading devices…</p>`
      : visible.error ? html`<p class="muted small" role="status">${visible.error}</p>`
      : visible.devices.length ? html`<ul>${visible.devices.map((device) => html`<li key=${device.pubkey}>
          ${device.current ? 'This browser · ' : ''}<span class="mono" title=${device.pubkey}>${device.pubkey.slice(0, 8)}…${device.pubkey.slice(-8)}</span>
        </li>`)}</ul>`
      : html`<p class="muted small">No authorized messaging devices found.</p>`}
    <button class="link" disabled=${visible.loading} onClick=${refresh}>Refresh devices</button>
  </div>`;
}

export function Settings() {
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
        <h3>Messaging</h3>
        <label class="check">Double ratchet (Iris-compatible)
          <select value=${store.doubleRatchetMode.value} onChange=${(e) => store.setDoubleRatchetMode(e.target.value)}>
            <option value="ask">Ask me when someone supports it</option>
            <option value="on">Use it whenever available</option>
            <option value="off">Never</option>
          </select>
        </label>
        <p class="muted small">Double-ratchet chats are readable only in clients that support it (Iris and this app), not in Anagram. Messages reach every device you have registered, but a device registered later does not receive earlier history, and clearing this browser's data loses what it holds. Turning it on registers this browser as a messaging device on your account, which publishes a signed event. Chats that already use it keep it, and once registered this browser keeps its sessions running even under "Never"; each chat's info panel can override this.</p>
        <${MessagingDevices} owner=${signer.pubkey} />
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
    <label class="check"><input type="checkbox" checked=${n.sound} onChange=${(e) => store.setNotifySettings({ sound: e.target.checked })} /> Sounds
      <button type="button" class="link" title="Play the message sound" onClick=${() => playSound('dm', { force: true })}>Preview</button></label>
    ${permission === 'granted'
      ? html`<p class="muted small">Desktop notifications are on (shown when the tab is in the background).</p>`
      : permission === 'denied'
        ? html`<p class="muted small">Desktop notifications are blocked in your browser's site settings.</p>`
        : permission === 'unsupported'
          ? html`<p class="muted small">This browser doesn't support desktop notifications.</p>`
          : html`<button onClick=${() => Notification.requestPermission().then(setPermission)}>Enable desktop notifications</button>`}
  </div>`;
}
