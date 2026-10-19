// Nostr protocol layer: relays, signers, NIP-17 gift wraps, NIP-72 public rooms.
// Wire formats match Anagram (github.com/lnbits/anagram) so both clients interoperate.
import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  getEventHash,
  verifyEvent,
  nip05,
  nip19,
  nip44,
} from 'nostr-tools';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';

export const APP_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const INDEXERS = ['wss://purplepag.es', 'wss://indexer.coracle.social', 'wss://relay.nos.social'];
export const ROOM_KIND = 34550;
const HEX = /^[a-f0-9]{64}$/;
const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

export const pool = new SimplePool({ enableReconnect: true });

// Relay reads always have a deadline; a relay that never answers must not stall the app.
const RELAY_WAIT = 6000;
const withWait = (params) => ({ maxWait: RELAY_WAIT, ...(params ?? {}) });
export const relayGet = (relays, filter, params) => pool.get(relays, filter, withWait(params));
export const relayQuery = (relays, filter, params) => pool.querySync(relays, filter, withWait(params));

export const uniq = (list) => [...new Set(list.filter(Boolean))];
export const now = () => Math.floor(Date.now() / 1000);

export function normalizeRelay(url) {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'wss:' || u.username || u.password) return '';
    return u.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

// ---------- Signers ----------
// Every signer exposes { pubkey, sign(template), encrypt(peer, text), decrypt(peer, payload) }.

function localSigner(sk) {
  const keys = new Map();
  const key = (peer) => {
    if (!keys.has(peer)) keys.set(peer, nip44.getConversationKey(sk, peer));
    return keys.get(peer);
  };
  return {
    type: 'nsec',
    sk,
    pubkey: getPublicKey(sk),
    sign: async (t) => finalizeEvent(t, sk),
    encrypt: async (peer, text) => nip44.encrypt(text, key(peer)),
    decrypt: async (peer, payload) => nip44.decrypt(payload, key(peer)),
  };
}

export function nsecSigner(input) {
  const value = input.trim();
  let sk;
  if (value.startsWith('nsec1')) {
    const decoded = nip19.decode(value);
    if (decoded.type !== 'nsec') throw new Error('Not an nsec key.');
    sk = decoded.data;
  } else if (HEX.test(value)) sk = hexToBytes(value);
  else throw new Error('Enter an nsec1… or 64-character hex private key.');
  return localSigner(sk);
}

export function newKeySigner() {
  return localSigner(generateSecretKey());
}

export function exportNsec(signer) {
  return signer.sk ? nip19.nsecEncode(signer.sk) : '';
}

export async function extensionSigner() {
  const ext = window.nostr;
  if (!ext) throw new Error('No Nostr extension found (NIP-07).');
  if (!ext.nip44) throw new Error('Your extension does not support NIP-44 encryption.');
  const pubkey = await ext.getPublicKey();
  return {
    type: 'extension',
    pubkey,
    sign: (t) => ext.signEvent(t),
    encrypt: (peer, text) => ext.nip44.encrypt(peer, text),
    decrypt: (peer, payload) => ext.nip44.decrypt(peer, payload),
  };
}

function wrapBunker(bunker, pubkey, clientKey) {
  return {
    type: 'bunker',
    pubkey,
    bunker: { pointer: bunker.bp, clientKey },
    sign: (t) => bunker.signEvent(t),
    encrypt: (peer, text) => bunker.nip44Encrypt(peer, text),
    decrypt: (peer, payload) => bunker.nip44Decrypt(peer, payload),
  };
}

export async function bunkerSigner(input, onauth) {
  const pointer = await parseBunkerInput(input.trim());
  if (!pointer) throw new Error('Enter a bunker:// link or NIP-05 address.');
  const clientKey = generateSecretKey();
  const bunker = BunkerSigner.fromBunker(clientKey, pointer, {
    onauth: (url) => onauth?.(url),
  });
  await bunker.connect();
  return wrapBunker(bunker, await bunker.getPublicKey(), bytesToHex(clientKey));
}

// Saved sessions reconnect without the user re-entering anything.
export async function restoreSigner(saved) {
  if (saved.type === 'nsec') return localSigner(hexToBytes(saved.sk));
  if (saved.type === 'extension') return extensionSigner();
  if (saved.type === 'bunker') {
    const bunker = BunkerSigner.fromBunker(hexToBytes(saved.clientKey), saved.pointer, {});
    return wrapBunker(bunker, saved.pubkey, saved.clientKey);
  }
  throw new Error('Unknown session.');
}

export function serializeSigner(signer) {
  if (signer.type === 'nsec') return { type: 'nsec', sk: bytesToHex(signer.sk) };
  if (signer.type === 'bunker')
    return { type: 'bunker', pubkey: signer.pubkey, ...signer.bunker };
  return { type: signer.type };
}

// ---------- Identifiers ----------

// did:nostr (did-nostr.com) is the canonical identifier; npub is display only.
export const did = (hex) => `did:nostr:${hex}`;
// nostr.social serves did:nostr profile pages at /<hex> (the DID document is at
// /.well-known/did/nostr/<hex>.json); /did:nostr:<hex> is not a route there.
export const profileUrl = (hex) => `https://nostr.social/${hex}`;
// Shareable chat link: https://nostr.chat/did:nostr:<hex> (404.html routes it into the app).
export const chatLink = (hex) => `${location.origin}${location.pathname.replace(/[^/]*$/, '')}#/dm/${did(hex)}`;
export const didDocumentUrl = (hex) => `https://nostr.social/.well-known/did/nostr/${hex}.json`;

// Resolve a did:nostr DID document over HTTP (did-nostr.com, served by nostr.social).
// Server-provided and unsigned: treat its profile as a display hint; signed kind 0 wins.
export async function resolveDid(hex) {
  if (!HEX.test(hex)) throw new Error('Not a did:nostr key.');
  // /api/did is the same conformant document plus graph counts (beacon).
  const res = await fetch(`${DIRECTORY}/api/did/${hex}`, {
    headers: { Accept: 'application/did+json, application/json' },
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`DID resolution failed (${res.status})`);
  const doc = await res.json();
  if (doc?.id !== did(hex)) throw new Error('DID document does not match the key.');
  const p = doc.profile && typeof doc.profile === 'object' ? doc.profile : {};
  const https = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : '');
  return {
    doc,
    profile: {
      pubkey: hex,
      created_at: Number.isSafeInteger(p.created_at) ? p.created_at : 0,
      name: String(p.display_name || p.name || '').slice(0, 80),
      picture: https(p.picture),
      nip05: typeof p.nip05 === 'string' ? p.nip05.slice(0, 120) : '',
      about: typeof p.about === 'string' ? p.about.slice(0, 600) : '',
      website: https(p.website),
      source: 'did',
    },
    follows: (Array.isArray(doc.follows) ? doc.follows : [])
      .map((d) => (typeof d === 'string' ? decodePubkey(d) : null))
      .filter(Boolean),
    alsoKnownAs: Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs.filter((x) => typeof x === 'string').slice(0, 20) : [],
    followers: Number.isSafeInteger(doc.followersCount) ? doc.followersCount : null,
    following: Number.isSafeInteger(doc.followingCount) ? doc.followingCount : null,
    keyMatches: (doc.verificationMethod ?? []).some((v) => typeof v.publicKeyMultibase === 'string' && v.publicKeyMultibase.endsWith(hex)),
    service: Array.isArray(doc.service) ? doc.service.slice(0, 20) : [],
  };
}
export const npub = (hex) => nip19.npubEncode(hex);
// Anagram's mention format inside message text.
export const mentionUri = (hex) => `nostr:${nip19.nprofileEncode({ pubkey: hex, relays: [] })}`;
export const shortKey = (hex) => {
  const n = npub(hex);
  return `${n.slice(0, 10)}…${n.slice(-4)}`;
};

export function decodePubkey(value) {
  value = value.trim().replace(/^nostr:/, '');
  // Profile links: nostr.social/<hex> and nostr.chat/#/dm/did:nostr:<hex>.
  const link = /^https?:\/\/[^/]+\/(?:#\/dm\/)?(did:nostr:[a-f0-9]{64}|[a-f0-9]{64}|npub1[02-9ac-hj-np-z]+)\/?$/i.exec(value);
  if (link) value = decodeURIComponent(link[1]);
  const fromDid = /^did:nostr:([a-f0-9]{64})$/.exec(value.toLowerCase());
  if (fromDid) return fromDid[1];
  if (HEX.test(value)) return value;
  try {
    const d = nip19.decode(value);
    if (d.type === 'npub') return d.data;
    if (d.type === 'nprofile') return d.data.pubkey;
  } catch {}
  return null;
}

export async function resolvePubkey(input) {
  const value = input.trim().replace(/^nostr:/, '');
  if (value.startsWith('nprofile1')) {
    const decoded = nip19.decode(value);
    if (decoded.type === 'nprofile') return decoded.data;
  }
  const pubkey = decodePubkey(value);
  if (pubkey) return { pubkey, relays: [] };
  if (value.includes('@')) {
    const profile = await nip05.queryProfile(value);
    if (profile) return profile;
  }
  throw new Error('Enter a did:nostr, name@domain, npub or hex key.');
}

// ---------- Relay lists & profiles ----------

// NIP-05: the name only counts if the domain's nostr.json maps it to this key.
export async function verifyNip05(pubkey, address) {
  if (!nip05.isNip05(address)) return false;
  return nip05.isValid(pubkey, address).catch(() => false);
}

export async function fetchInboxRelays(pubkey) {
  const event = await relayGet(uniq([...APP_RELAYS, ...INDEXERS]), {
    kinds: [10050],
    authors: [pubkey],
  });
  return uniq((event?.tags ?? []).filter((t) => t[0] === 'relay').map((t) => normalizeRelay(t[1])));
}

export async function publishInboxRelays(signer, relays) {
  const event = await signer.sign({
    kind: 10050,
    created_at: now(),
    tags: relays.map((r) => ['relay', r]),
    content: '',
  });
  return publish(uniq([...APP_RELAYS, ...INDEXERS, ...relays]), event);
}

// NIP-65 relay list (kind 10002): read+write for every relay given. Other clients and the
// did:nostr document (nostr.social adds them as service entries) learn our relays from it.
export async function publishRelayList(signer, relays) {
  const event = await signer.sign({
    kind: 10002,
    created_at: now(),
    tags: relays.map((r) => ['r', r]),
    content: '',
  });
  return publish(uniq([...APP_RELAYS, ...INDEXERS, ...relays]), event);
}

// Someone's NIP-65 read relays, for reaching people who never published a NIP-17 inbox
// list: nostr.social's indexed kind 10002 (signed, verified) first, then the relays.
export async function fetchReadRelays(hex) {
  if (!HEX.test(hex)) return [];
  const [directory, relay] = await Promise.allSettled([
    directoryGet(`/api/relays/${hex}`).then((raw) => verifiedFromDirectory(raw, 10002)),
    relayQuery(uniq([...APP_RELAYS, ...INDEXERS]), { kinds: [10002], authors: [hex] }),
  ]);
  const candidates = [directory.value, ...(relay.value ?? [])].filter((e) => e && e.pubkey === hex);
  const event = candidates.sort((a, b) => b.created_at - a.created_at)[0];
  if (!event) return [];
  return uniq(event.tags.filter((t) => t[0] === 'r' && (!t[2] || t[2] === 'read')).map((t) => normalizeRelay(t[1]))).slice(0, 8);
}

// nostr.social's relay health directory: public, online relays ranked by uptime and
// latency, for suggesting inbox relays. Fields: url, uptime (%), responseTime (ms),
// requiresAuth, requiresPayment.
export async function fetchRelayDirectory(limit = 40) {
  const data = await directoryGet(`/api/relays-directory?filter=public&sort=quality&limit=${limit}`);
  return (data?.relays ?? [])
    .map((r) => ({ url: normalizeRelay(r.relay), uptime: r.uptime, responseTime: r.responseTime, requiresAuth: !!r.requiresAuth, requiresPayment: !!r.requiresPayment, acceptsEvents: r.acceptsEvents !== false }))
    .filter((r) => r.url && r.acceptsEvents);
}

// Our own kind 0, raw, so edits keep fields other clients set (lud16, banner, ...).
// Our own kind 0 from relays and from nostr.social (signed; verified); the newest wins.
// Returns event: null only if neither source had one.
export async function fetchOwnProfile(pubkey) {
  const [relay, directory] = await Promise.allSettled([
    relayQuery(uniq([...APP_RELAYS, ...INDEXERS]), { kinds: [0], authors: [pubkey] }),
    directoryGet(`/api/profile/${pubkey}`).then((raw) => verifiedFromDirectory(raw, 0)),
  ]);
  const candidates = [...(relay.value ?? []), directory.value].filter((e) => e && e.pubkey === pubkey);
  const event = candidates.sort((a, b) => b.created_at - a.created_at)[0] ?? null;
  let data = {};
  try {
    data = event ? JSON.parse(event.content) : {};
  } catch {}
  return { event, data: data && typeof data === 'object' ? data : {} };
}

export async function publishProfile(signer, fields, previous, relays = []) {
  const data = { ...(previous?.data ?? {}) };
  for (const [key, value] of Object.entries(fields)) {
    if (value) data[key] = value;
    else delete data[key];
  }
  if (fields.name !== undefined) data.display_name = fields.name || undefined;
  const event = await signer.sign({
    kind: 0,
    // Replaceable: must beat the version we merged from.
    created_at: Math.max(now(), (previous?.event?.created_at ?? 0) + 1),
    tags: [],
    content: JSON.stringify(data),
  });
  await publish(uniq([...APP_RELAYS, ...INDEXERS, ...relays]), event, signer);
  return { event, data };
}

export async function fetchProfiles(pubkeys) {
  if (!pubkeys.length) return [];
  const events = await relayQuery(uniq([...APP_RELAYS, ...INDEXERS]), {
    kinds: [0],
    authors: pubkeys,
  });
  const newest = new Map();
  for (const e of events)
    if (!newest.has(e.pubkey) || newest.get(e.pubkey).created_at < e.created_at)
      newest.set(e.pubkey, e);
  return [...newest.values()].map(parseProfile).filter(Boolean);
}

// A kind 0 event (already signature-checked) -> the profile fields we display.
export function parseProfile(e) {
  try {
    const m = JSON.parse(e.content);
    return {
      pubkey: e.pubkey,
      created_at: e.created_at,
      name: String(m.display_name || m.name || '').slice(0, 80),
      picture: /^https:\/\//.test(m.picture ?? '') ? m.picture : '',
      nip05: typeof m.nip05 === 'string' ? m.nip05.slice(0, 120) : '',
      about: typeof m.about === 'string' ? m.about.slice(0, 600) : '',
      website: /^https:\/\//.test(m.website ?? '') ? m.website.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

// ---------- nostr.social (beacon: github.com/JavaScriptSolidServer/beacon) ----------
// The directory serves raw signed events, so we verify them here and then trust them
// exactly like relay data.
export const DIRECTORY = 'https://nostr.social';

// Keep only the signed fields of a stored event and check the signature.
export function verifiedFromDirectory(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  const event = { id: raw.id, pubkey: raw.pubkey, created_at: raw.created_at, kind: raw.kind, tags: raw.tags, content: raw.content, sig: raw.sig };
  return event.kind === kind && verifyEvent(event) ? event : null;
}

async function directoryGet(path) {
  const res = await fetch(`${DIRECTORY}${path}`, { referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`nostr.social ${res.status}`);
  return res.json();
}

export async function fetchDirectoryProfile(hex) {
  if (!HEX.test(hex)) return null;
  const event = verifiedFromDirectory(await directoryGet(`/api/profile/${hex}`), 0);
  return event && event.pubkey === hex ? parseProfile(event) : null;
}

// Who someone follows: their signed kind 3 from relays is authoritative; nostr.social's
// derived (unsigned) list is a fast fallback.
export async function fetchFollows(hex) {
  const [relay, directory] = await Promise.allSettled([
    relayQuery(uniq([...APP_RELAYS, ...INDEXERS]), { kinds: [3], authors: [hex] }, { maxWait: 4000 }),
    directoryGet(`/api/follows/${hex}`),
  ]);
  const signed = (relay.value ?? []).filter((e) => e.pubkey === hex).sort((a, b) => b.created_at - a.created_at)[0];
  if (signed) return uniq(signed.tags.filter((t) => t[0] === 'p' && HEX.test(t[1])).map((t) => t[1]));
  const list = directory.value?.pubkey === hex && Array.isArray(directory.value.follows) ? directory.value.follows : [];
  return uniq(list.filter((pk) => HEX.test(pk)));
}

// People search (full text over profiles, ranked by followers); every hit is verified.
export async function searchDirectory(q, limit = 20) {
  const hits = await directoryGet(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return (Array.isArray(hits) ? hits : [])
    .map((raw) => {
      const event = verifiedFromDirectory(raw, 0);
      const p = event && parseProfile(event);
      return p && { ...p, followers: Number(raw._counts?.followers) || 0 };
    })
    .filter(Boolean);
}

// Publish to all relays and resolve once at least one accepts.
// Publish to all relays; resolve as soon as the first one accepts (the rest carry on).
// Publish to all relays; resolve as soon as one accepts (the rest carry on). With
// `require`, success means one of THOSE relays accepted: if only others did, the error
// carries `partial: true` (the event is out there, but not where the recipient reads).
export async function publish(relays, event, signer, { require } = {}) {
  relays = uniq(relays);
  const onauth = signer ? (t) => signer.sign(t) : undefined;
  const attempts = pool.publish(relays, event, { onauth }).map((p, i) => p.then(() => relays[i]));
  const needed = require?.length ? attempts.filter((_, i) => require.includes(relays[i])) : attempts;
  try {
    await Promise.any(needed.length ? needed : attempts);
  } catch (e) {
    const reasons = (e.errors ?? []).map((r) => r?.message ?? String(r));
    const elsewhere = needed !== attempts && (await Promise.any(attempts).then(() => true, () => false));
    const error = new Error(elsewhere ? "Delivered to shared relays only; the recipient's inbox relays did not accept it." : reasons.join('; ') || 'No relay accepted the event.');
    error.partial = elsewhere;
    throw error;
  }
  return event;
}

// ---------- NIP-17 direct messages ----------

// Gift wraps hide their real time: up to two days in the past.
const fuzzedTime = () => now() - Math.floor(Math.random() * 2 * 24 * 60 * 60);

async function giftWrap(signer, rumor, recipient) {
  const seal = await signer.sign({
    kind: 13,
    created_at: fuzzedTime(),
    tags: [],
    content: await signer.encrypt(recipient, JSON.stringify(rumor)),
  });
  const ephemeral = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      created_at: fuzzedTime(),
      tags: [['p', recipient]],
      content: nip44.encrypt(JSON.stringify(seal), nip44.getConversationKey(ephemeral, recipient)),
    },
    ephemeral,
  );
}

// Wrap any rumor kind (14 message, 7 reaction, 5 deletion) to the recipient and to ourselves.
// recipientRelays may be a promise, so the rumor can be shown (onRumor) before relay lookup finishes.
export async function sendRumor(signer, recipient, kind, content, tags, recipientRelays, ownRelays, createdAt = now(), onRumor) {
  const rumor = { pubkey: signer.pubkey, created_at: createdAt, kind, tags, content };
  rumor.id = getEventHash(rumor);
  onRumor?.(rumor);
  recipientRelays = await recipientRelays;
  const [theirs, mine] = await Promise.all([
    giftWrap(signer, rumor, recipient),
    recipient === signer.pubkey ? null : giftWrap(signer, rumor, signer.pubkey),
  ]);
  // The recipient's copy is what matters: it must land on one of THEIR inbox relays
  // (when they have published any); our own copy only restores history.
  await publish(uniq([...recipientRelays, ...APP_RELAYS]), theirs, signer, { require: recipientRelays });
  if (mine) publish(uniq([...ownRelays, ...APP_RELAYS]), mine, signer).catch(() => {});
  return rumor;
}

// Anagram's edit link: replacement messages carry ['e', previousId, '', 'edit'].
export const editTag = (previousId) => ['e', previousId, '', 'edit'];
export const isEdited = (tags) => tags.some((t) => t[0] === 'e' && t[3] === 'edit');

export function sendDirectMessage(signer, recipient, text, recipientRelays, ownRelays, replyId, edit, onRumor, extraTags = []) {
  const tags = [
    ['p', recipient],
    ...(replyId ? [['e', replyId, '', 'reply']] : []),
    ...(edit ? [editTag(edit.id)] : []),
    ...extraTags,
  ];
  return sendRumor(signer, recipient, 14, text, tags, recipientRelays, ownRelays, edit?.created_at ?? now(), onRumor);
}

// NIP-25 shorthand: '+' or empty is a like, '-' a dislike.
export const normalizeEmoji = (content) =>
  !content || content === '+' ? '👍' : content === '-' ? '👎' : [...content].slice(0, 8).join('');

// Returns a verified rumor, or throws. Seal author must match the rumor author.
// Errors marked permanent can never succeed (bad data); others (a locked extension,
// a bunker timeout) may work later and must not cause the message to be dropped.
const permanent = (message) => Object.assign(new Error(message), { permanent: true });

async function decryptOrFlag(signer, peer, payload) {
  try {
    return await signer.decrypt(peer, payload);
  } catch (e) {
    // A local key failing to decrypt means the payload is bad; a remote signer may just be unavailable.
    if (signer.type === 'nsec') throw permanent(e.message);
    throw e;
  }
}

function parseOrFlag(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw permanent('Malformed gift wrap.');
  }
}

export async function unwrap(signer, wrap) {
  if (wrap.kind !== 1059 || wrap.content.length > 200000) throw permanent('Not a gift wrap.');
  const seal = parseOrFlag(await decryptOrFlag(signer, wrap.pubkey, wrap.content));
  if (seal?.kind !== 13 || !verifyEvent(seal)) throw permanent('Invalid seal.');
  const raw = parseOrFlag(await decryptOrFlag(signer, seal.pubkey, seal.content));
  if (raw?.pubkey !== seal.pubkey) throw permanent('Rumor author does not match seal.');
  if (!Number.isSafeInteger(raw.created_at) || !Number.isSafeInteger(raw.kind) || !Array.isArray(raw.tags))
    throw permanent('Invalid rumor.');
  const rumor = {
    pubkey: raw.pubkey,
    created_at: raw.created_at,
    kind: raw.kind,
    tags: raw.tags,
    content: String(raw.content ?? ''),
  };
  // Never trust the rumor's own id field.
  return { ...rumor, id: getEventHash(rumor) };
}

// ---------- NIP-72 public rooms (Anagram format) ----------

export function roomAddress(value) {
  const m = /^34550:([a-f0-9]{64}):([a-zA-Z0-9_-]{1,128})$/.exec(value);
  if (!m) throw new Error('Invalid room address.');
  return { address: value, owner: m[1], slug: m[2], relays: [] };
}

export function decodeRoomLink(value) {
  let input = value.trim();
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    const hash = url.hash.match(/^#\/(?:public|room)\/(.+)$/);
    if (hash) input = decodeURIComponent(hash[1]);
    else if (url.pathname.startsWith('/public/')) input = decodeURIComponent(url.pathname.slice(8));
    else throw new Error('Not a room link.');
  }
  input = input.replace(/^nostr:/, '');
  if (input.startsWith('34550:')) return roomAddress(input);
  const decoded = nip19.decode(input);
  if (decoded.type !== 'naddr' || decoded.data.kind !== ROOM_KIND)
    throw new Error('Paste a room link or naddr.');
  return {
    ...roomAddress(`${ROOM_KIND}:${decoded.data.pubkey}:${decoded.data.identifier}`),
    relays: (decoded.data.relays ?? []).map(normalizeRelay).filter(Boolean).slice(0, 8),
  };
}

export function encodeRoomLink(room) {
  return nip19.naddrEncode({
    kind: ROOM_KIND,
    pubkey: room.owner,
    identifier: room.slug,
    relays: room.relays.slice(0, 8),
  });
}

export function parseRoom(event, expected) {
  const single = (name) => {
    const tags = event.tags.filter((t) => t[0] === name);
    if (tags.length > 1) throw new Error(`Duplicate ${name}.`);
    return tags[0]?.[1];
  };
  if (event.kind !== ROOM_KIND) throw new Error('Not a room.');
  const address = roomAddress(`${ROOM_KIND}:${event.pubkey}:${single('d')}`);
  if (expected && address.address !== expected) throw new Error('Room address mismatch.');
  if (single('anagram-room') !== '1') throw new Error('Unsupported room format.');
  const name = single('name') ?? '';
  if (!name.trim() || name.length > 100) throw new Error('Invalid room name.');
  const keys = (tag) => uniq(event.tags.filter((t) => t[0] === tag && HEX.test(t[1])).map((t) => t[1]));
  const relays = uniq(event.tags.filter((t) => t[0] === 'relay').map((t) => normalizeRelay(t[1]))).slice(0, 8);
  if (!relays.length) throw new Error('Room has no relays.');
  const image = single('image') ?? '';
  return {
    ...address,
    event,
    name,
    about: (single('description') ?? '').slice(0, 2000),
    picture: /^https:\/\//.test(image) ? image : '',
    relays,
    trusted: keys('trusted'),
    blocked: keys('blocked').filter((k) => k !== event.pubkey),
    pinned: HEX.test(single('pinned') ?? '') ? single('pinned') : '',
  };
}

export function roomPolicy(room, pubkey) {
  if (pubkey === room.owner) return 'trusted';
  if (room.blocked.includes(pubkey)) return 'blocked';
  return room.trusted.includes(pubkey) ? 'trusted' : 'plain';
}

export async function fetchRoom(pointer) {
  const events = await relayQuery(uniq([...pointer.relays, ...APP_RELAYS]), {
    kinds: [ROOM_KIND],
    authors: [pointer.owner],
    '#d': [pointer.slug],
  });
  let best = null;
  for (const e of events) {
    try {
      const room = parseRoom(e, pointer.address);
      if (!best || e.created_at > best.event.created_at) best = room;
    } catch {}
  }
  if (!best) throw new Error('Room not found on its relays.');
  return best;
}

export async function createRoom(signer, { name, about, relays }) {
  const slug = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
  const event = await signer.sign({
    kind: ROOM_KIND,
    created_at: now(),
    content: '',
    tags: [
      ['d', slug],
      ['anagram-room', '1'],
      ['name', name.trim()],
      ['description', about.trim()],
      ...relays.map((r) => ['relay', r]),
    ],
  });
  await publish(uniq([...relays, ...APP_RELAYS]), event, signer);
  return parseRoom(event);
}

// Re-sign a room definition with some fields changed. Every other tag is kept as-is
// (relays, anagram-room, successor/predecessor, unknown extensions) so an edit from here
// never strips what Anagram or a newer client wrote. Only the owner can sign it.
export async function updateRoom(signer, room, changes) {
  if (signer.pubkey !== room.owner) throw new Error('Only the room owner can change it.');
  const replaced = new Set();
  const added = [];
  if (changes.name !== undefined) {
    const name = changes.name.trim();
    if (!name || name.length > 100) throw new Error('Room name must be 1-100 characters.');
    replaced.add('name');
    added.push(['name', name]);
  }
  if (changes.about !== undefined) {
    replaced.add('description');
    if (changes.about.trim()) added.push(['description', changes.about.trim().slice(0, 2000)]);
  }
  if (changes.picture !== undefined) {
    replaced.add('image');
    if (changes.picture) {
      if (!/^https:\/\//.test(changes.picture)) throw new Error('The picture must be an https:// URL.');
      added.push(['image', changes.picture]);
    }
  }
  if (changes.trusted) {
    replaced.add('trusted');
    added.push(...uniq(changes.trusted).filter((k) => HEX.test(k) && k !== room.owner).map((k) => ['trusted', k]));
  }
  if (changes.blocked) {
    replaced.add('blocked');
    added.push(...uniq(changes.blocked).filter((k) => HEX.test(k) && k !== room.owner).map((k) => ['blocked', k]));
  }
  if (changes.pinned !== undefined) {
    replaced.add('pinned');
    if (changes.pinned) {
      if (!HEX.test(changes.pinned)) throw new Error('Invalid pinned message id.');
      added.push(['pinned', changes.pinned]);
    }
  }
  const tags = [...room.event.tags.filter((t) => !replaced.has(t[0])), ...added];
  const event = await signer.sign({
    kind: ROOM_KIND,
    created_at: Math.max(now(), room.event.created_at + 1), // newest definition wins
    content: room.event.content ?? '',
    tags,
  });
  const next = parseRoom(event, room.address);
  await publish(roomRelays(room), event, signer);
  return next;
}

export function validRoomMessage(event, address) {
  const refs = event.tags.filter((t) => t[0] === 'a');
  return (
    event.kind === 9 &&
    event.content.length > 0 &&
    event.content.length <= 8000 &&
    event.created_at <= now() + 60 &&
    refs.length === 1 &&
    refs[0][1] === address
  );
}

export async function signRoomMessage(signer, room, text, reply, edit, extraTags = []) {
  const event = await signer.sign({
    kind: 9,
    // Edits keep the original timestamp so the message stays in place.
    created_at: edit?.created_at ?? now(),
    content: text,
    tags: [
      ['a', room.address],
      // Anagram: edit link to the current version, plus the original (root) when different.
      ...(edit
        ? [
            editTag(edit.id),
            ...(edit.prev?.length ? [['e', edit.prev[0]]] : []),
            ...edit.tags.filter((t) => t[0] === 'q' || t[0] === 'imeta'),
          ]
        : []),
      ...(reply && !edit ? [['q', reply.prev?.[0] ?? reply.id, room.relays[0] ?? '', reply.pubkey]] : []),
      ...extraTags,
    ],
  });
  return event;
}

export async function sendRoomMessage(signer, room, text, reply, edit, onSigned, extraTags = []) {
  const event = await signRoomMessage(signer, room, text, reply, edit, extraTags);
  onSigned?.(event);
  return publish(roomRelays(room), event, signer);
}

// Anagram's starter room, as an owner-signed snapshot so it shows before relays answer.
export const STARTER_ROOM = {
  content: '',
  created_at: 1791472906,
  id: '56964b136b3ff2b5d8c4927ca81099d7c2ccfd8382c57fb0523c0a254588d3a5',
  kind: 34550,
  pubkey: 'c1fc7771f5fa418fd3ac49221a18f19b42ccb7a663da8f04cbbf6c08c80d20b1',
  sig: '274bf172b03de87b6467ff0d69f83e76f7923465d3ccc74c451162593906c03e65d890b87f82ebaa8c8c0abe86f9db3e111a1c3e5681f61f718cd17a2f805cc4',
  tags: [
    ['d', 'c609a674-94c2-4af3-a810-ffbbdd7ac4cb'],
    ['anagram-room', '1'],
    ['name', 'Anagram rants'],
    ['description', ''],
    ['pinned', '01d30742542c215d8e01d17fe4ae1123d63d0e8c83b778230e82aac18f8c627e'],
    [
      'image',
      'https://npub1c878wu04lfqcl5avfy3p5x83ndpvedaxv0dg7pxthakq3jqdyzcs2n8avm.blossom.band/721d7e8ec095b4b132b8d1ed86d4a1987070e96b2c00af329979d02b6c5942c2.png',
    ],
    ['relay', 'wss://relay.nostr.com/'],
    ['relay', 'wss://relay.damus.io/'],
    ['relay', 'wss://nostr.mom/'],
    ['relay', 'wss://nostr.bitcoiner.social/'],
    ['relay', 'wss://nos.lol/'],
  ],
};

export function starterRoom() {
  return verifyEvent(STARTER_ROOM) ? parseRoom(STARTER_ROOM) : null;
}

export async function fetchEvent(relays, id) {
  return relayGet(relays, { ids: [id] });
}

// ---------- Private contact list (Anagram: kind 30000, d=contacts, NIP-44 to self) ----------

export async function fetchContactList(signer, relays) {
  const event = await relayGet(relays, { kinds: [30000], authors: [signer.pubkey], '#d': ['contacts'] });
  if (!event) return { event: null, pubkeys: [] };
  const tags = event.content.trim() ? JSON.parse(await signer.decrypt(signer.pubkey, event.content)) : [];
  const pubkeys = uniq(
    [...(Array.isArray(tags) ? tags : []), ...event.tags]
      .filter((t) => Array.isArray(t) && t[0] === 'p' && HEX.test(t[1]))
      .map((t) => t[1]),
  );
  return { event, pubkeys };
}

// ---------- Mute list (Anagram: kind 10000, private ['p'] muted / ['bp'] blocked, NIP-44 to self) ----------

export async function fetchMuteList(signer, relays) {
  const event = await relayGet(relays, { kinds: [10000], authors: [signer.pubkey] });
  if (!event) return { event: null, entries: [] };
  let entries = [];
  if (event.content.trim()) {
    const parsed = JSON.parse(await signer.decrypt(signer.pubkey, event.content));
    entries = Array.isArray(parsed) ? parsed.filter((t) => Array.isArray(t)) : [];
  }
  return { event, entries };
}

// Rewrites only the 'bp' (blocked) entries; everything else (muted, words, ...) and public tags are kept.
export async function publishMuteList(signer, blocked, previous, relays) {
  const kept = (previous?.entries ?? []).filter((t) => t[0] !== 'bp' && !(t[0] === 'p' && blocked.includes(t[1])));
  const entries = [...kept, ...uniq(blocked).map((pk) => ['bp', pk])];
  const event = await signer.sign({
    kind: 10000,
    created_at: Math.max(now(), (previous?.event?.created_at ?? 0) + 1),
    tags: previous?.event?.tags ?? [],
    content: await signer.encrypt(signer.pubkey, JSON.stringify(entries)),
  });
  await publish(relays, event, signer);
  return { event, entries };
}

// ---------- App settings sync (NIP-78 kind 30078, d=nostr.chat, NIP-44 to self) ----------
// Read marks, pinned/muted chats and hidden messages travel between devices in one
// encrypted event. Its d tag is ours alone: Anagram keeps its own preferences under d=1.

export const SETTINGS_D = 'nostr.chat';

export async function fetchSettings(signer, relays) {
  const event = await relayGet(relays, { kinds: [30078], authors: [signer.pubkey], '#d': [SETTINGS_D] });
  return event ? parseSettings(signer, event) : null;
}

export async function parseSettings(signer, event) {
  if (event.kind !== 30078 || event.pubkey !== signer.pubkey) return null;
  try {
    const data = JSON.parse(await signer.decrypt(signer.pubkey, event.content));
    return data && typeof data === 'object' ? { event, data } : null;
  } catch {
    return null;
  }
}

export async function publishSettings(signer, data, relays, previous) {
  const event = await signer.sign({
    kind: 30078,
    created_at: Math.max(now(), (previous?.created_at ?? 0) + 1),
    tags: [['d', SETTINGS_D]],
    content: await signer.encrypt(signer.pubkey, JSON.stringify(data)),
  });
  await publish(relays, event, signer);
  return event;
}

export async function publishContactList(signer, pubkeys, relays, previous) {
  const event = await signer.sign({
    kind: 30000,
    // Replaceable: must beat the version we merged from.
    created_at: Math.max(now(), (previous?.created_at ?? 0) + 1),
    tags: [
      ['d', 'contacts'],
      ['title', 'Contacts'],
    ],
    content: await signer.encrypt(signer.pubkey, JSON.stringify(uniq(pubkeys).map((pk) => ['p', pk]))),
  });
  return publish(relays, event, signer);
}

export const roomRelays = (room) => uniq([...room.relays, ...APP_RELAYS]);

export function signRoomReaction(signer, room, message, emoji) {
  return signer.sign({
    kind: 7,
    created_at: now(),
    content: emoji,
    tags: [
      ['h', room.address],
      ['e', message.id, room.relays[0] ?? '', message.pubkey],
      ['p', message.pubkey],
      ['k', '9'],
    ],
  });
}

// NIP-09 deletion of our own room events (reactions: k=7, messages: k=9).
export function signRoomDeletion(signer, room, ids, kind) {
  return signer.sign({
    kind: 5,
    created_at: now(),
    content: '',
    tags: [['h', room.address], ['k', String(kind)], ...ids.map((id) => ['e', id])],
  });
}

export async function sendRoomDeletion(signer, room, ids, kind) {
  return publish(roomRelays(room), await signRoomDeletion(signer, room, ids, kind), signer);
}

// ---------- Blossom media uploads (Anagram's format) ----------

export const DEFAULT_BLOSSOM = 'https://blossom.nostr.build';
const MAX_UPLOAD = 20 * 1024 * 1024;
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function normalizeBlossomServer(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// Upload a file; returns the NIP-92 imeta tag to attach (url, m, size, x).
export async function uploadBlossom(signer, file, server = DEFAULT_BLOSSOM) {
  if (!/^(image|video|audio)\//.test(file.type)) throw new Error('Only image, video and audio files are supported.');
  if (!file.size) throw new Error('The selected file is empty.');
  if (file.size > MAX_UPLOAD) throw new Error('Media uploads are limited to 20 MiB.');
  const origin = normalizeBlossomServer(server);
  if (!origin) throw new Error('The media server must be an https:// origin.');
  const host = new URL(origin).host;
  const sha256 = hexOf(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const created = now();
  const auth = await signer.sign({
    kind: 24242,
    created_at: created,
    content: `Authorize media upload to ${host}`,
    tags: [
      ['t', 'upload'],
      ['expiration', String(created + 15 * 60)],
      ['server', host],
      ['x', sha256],
    ],
  });
  const bytes = new TextEncoder().encode(JSON.stringify(auth));
  const res = await fetch(`${origin}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${btoa(String.fromCharCode(...bytes))}`,
      'Content-Type': file.type,
      'X-SHA-256': sha256,
    },
    body: file,
    referrerPolicy: 'no-referrer',
  });
  if (res.status !== 200 && res.status !== 201)
    throw new Error(res.headers.get('X-Reason') || (await res.text().catch(() => '')) || `${host} upload failed (${res.status})`);
  const blob = await res.json().catch(() => null);
  if (!blob?.url?.startsWith('https://')) throw new Error(`${host} returned an invalid upload response.`);
  return ['imeta', `url ${blob.url}`, `m ${blob.type || file.type}`, `size ${blob.size ?? file.size}`, `x ${blob.sha256 || sha256}`];
}

// Answer relay AUTH challenges with the account's signer. nostr-tools rethrows a failed
// challenge answer with nothing to catch it, so the error is tagged and logged once here
// and app.js swallows the tagged rejection (publishes that needed AUTH still fail normally).
let authWarned = false;
export function enableAuth(signer) {
  pool.automaticallyAuth = (relay) => (t) =>
    signer.sign(t).catch((e) => {
      if (!authWarned) console.warn(`[nostr] could not answer AUTH for ${relay.url}: ${e.message}`);
      authWarned = true;
      e.relayAuth = true;
      throw e;
    });
}
