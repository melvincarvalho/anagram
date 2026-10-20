// New message / join or create a room.
import { useState, useEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, html, useAction } from './common.js';
const { me, profiles } = store;

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

export function NewThing() {
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
