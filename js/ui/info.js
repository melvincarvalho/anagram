// Chat info panels: person (profile, DID, encryption choice, block) and room (members,
// owner tools).
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, ConfirmButton, Field, RoomAvatar, copy, fail, html, infoOpen, openProfile, shareLink, useAction, viewer } from './common.js';
import { mediaOf } from './text.js';
const { me, profiles, joinedRooms } = store;

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

export function PersonInfo({ pubkey, messages }) {
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
    <${EncryptionChoice} peer=${pubkey} />
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

// Which transport new messages in this chat use. "Auto" follows the account setting and
// upgrades when the other person has a double-ratchet device; the explicit choices override it.
function EncryptionChoice({ peer }) {
  const current = store.directProtocol(peer);
  const choice = store.directPreference(peer);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false); // 'ndr' picked before the account ever registered
  const apply = async (value) => {
    setConfirming(false);
    setBusy(true);
    try {
      await store.setDirectProtocol(peer, value);
    } catch (err) {
      store.notify(`Encryption: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };
  const change = (e) => {
    if (e.target.value === 'ndr' && !store.ndrActivated.value) setConfirming(true);
    else apply(e.target.value);
  };
  return html`<section>
    <h4>Message encryption</h4>
    <p class="muted small">
      ${current === 'ndr'
        ? 'New messages use double ratchet (Iris-compatible). Only clients that support it can read them; a device you register later will not see earlier messages.'
        : 'New messages use NIP-17 gift wrap, readable in Anagram and other NIP-17 clients.'}
    </p>
    ${peer !== me.value.pubkey && html`<label class="check">
      <select value=${confirming ? 'ndr' : choice} disabled=${busy} onChange=${change}>
        <option value="auto">Auto${choice === 'auto' ? ` (${current === 'ndr' ? 'double ratchet' : 'NIP-17'})` : ''}</option>
        <option value="nip17">NIP-17 only</option>
        <option value="ndr">Double ratchet only</option>
      </select>
    </label>`}
    ${confirming && html`<p class="muted small">This registers this browser as a messaging device on your account (a signed event) Devices you register later will not receive this chat's earlier messages. The other person needs an Iris-compatible client.</p>
      <div class="actions"><button class="primary" onClick=${() => apply('ndr')}>Register and use double ratchet</button><button onClick=${() => setConfirming(false)}>Cancel</button></div>`}
  </section>`;
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

export function RoomInfo({ room, messages }) {
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

export function InfoPanel({ children }) {
  if (!infoOpen.value) return null;
  return html`<aside class="info">
    <header class="bar">
      <div class="title"><b>Info</b></div>
      <button class="link close" title="Close" onClick=${() => (infoOpen.value = false)}>✕</button>
    </header>
    <div class="info-body">${children}</div>
  </aside>`;
}
