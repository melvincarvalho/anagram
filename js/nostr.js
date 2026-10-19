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

export const uniq = (list) => [...new Set(list.filter(Boolean))];
export const now = () => Math.floor(Date.now() / 1000);

export function normalizeRelay(url) {
  try {
    const u = new URL(url.trim());
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password) return '';
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
export const profileUrl = (hex) => `https://nostr.social/${did(hex)}`;
export const npub = (hex) => nip19.npubEncode(hex);
export const shortKey = (hex) => {
  const n = npub(hex);
  return `${n.slice(0, 10)}…${n.slice(-4)}`;
};

export function decodePubkey(value) {
  value = value.trim().replace(/^nostr:/, '');
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

export async function fetchInboxRelays(pubkey) {
  const event = await pool.get(uniq([...APP_RELAYS, ...INDEXERS]), {
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

export async function fetchProfiles(pubkeys) {
  if (!pubkeys.length) return [];
  const events = await pool.querySync(uniq([...APP_RELAYS, ...INDEXERS]), {
    kinds: [0],
    authors: pubkeys,
  });
  const newest = new Map();
  for (const e of events)
    if (!newest.has(e.pubkey) || newest.get(e.pubkey).created_at < e.created_at)
      newest.set(e.pubkey, e);
  return [...newest.values()].flatMap((e) => {
    try {
      const m = JSON.parse(e.content);
      return [
        {
          pubkey: e.pubkey,
          created_at: e.created_at,
          name: String(m.display_name || m.name || '').slice(0, 80),
          picture: /^https:\/\//.test(m.picture ?? '') ? m.picture : '',
          nip05: typeof m.nip05 === 'string' ? m.nip05.slice(0, 120) : '',
          about: typeof m.about === 'string' ? m.about.slice(0, 600) : '',
          website: /^https:\/\//.test(m.website ?? '') ? m.website.slice(0, 200) : '',
        },
      ];
    } catch {
      return [];
    }
  });
}

// Publish to all relays and resolve once at least one accepts.
// Publish to all relays; resolve as soon as the first one accepts (the rest carry on).
export async function publish(relays, event, signer) {
  const onauth = signer ? (t) => signer.sign(t) : undefined;
  try {
    await Promise.any(pool.publish(relays, event, { onauth }));
  } catch (e) {
    const reasons = (e.errors ?? []).map((r) => r?.message ?? String(r));
    throw new Error(reasons.join('; ') || 'No relay accepted the event.');
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
  // The recipient's copy is what matters; our own copy only restores history.
  await publish(uniq([...recipientRelays, ...APP_RELAYS]), theirs, signer);
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
export async function unwrap(signer, wrap) {
  if (wrap.kind !== 1059 || wrap.content.length > 200000) throw new Error('Not a gift wrap.');
  const seal = JSON.parse(await signer.decrypt(wrap.pubkey, wrap.content));
  if (seal.kind !== 13 || !verifyEvent(seal)) throw new Error('Invalid seal.');
  const raw = JSON.parse(await signer.decrypt(seal.pubkey, seal.content));
  if (raw.pubkey !== seal.pubkey) throw new Error('Rumor author does not match seal.');
  if (!Number.isSafeInteger(raw.created_at) || !Number.isSafeInteger(raw.kind) || !Array.isArray(raw.tags))
    throw new Error('Invalid rumor.');
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
  const events = await pool.querySync(uniq([...pointer.relays, ...APP_RELAYS]), {
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

export async function sendRoomMessage(signer, room, text, reply, edit, onSigned, extraTags = []) {
  const event = await signer.sign({
    kind: 9,
    // Edits keep the original timestamp so the message stays in place.
    created_at: edit?.created_at ?? now(),
    content: text,
    tags: [
      ['a', room.address],
      ...(edit ? [editTag(edit.id), ...edit.tags.filter((t) => t[0] === 'q')] : []),
      ...(reply && !edit ? [['q', reply.id, room.relays[0] ?? '', reply.pubkey]] : []),
      ...extraTags,
    ],
  });
  onSigned?.(event);
  return publish(uniq([...room.relays, ...APP_RELAYS]), event, signer);
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
  return pool.get(relays, { ids: [id] });
}

// ---------- Private contact list (Anagram: kind 30000, d=contacts, NIP-44 to self) ----------

export async function fetchContactList(signer, relays) {
  const event = await pool.get(relays, { kinds: [30000], authors: [signer.pubkey], '#d': ['contacts'] });
  if (!event) return { event: null, pubkeys: [] };
  const tags = event.content.trim() ? JSON.parse(await signer.decrypt(signer.pubkey, event.content)) : [];
  const pubkeys = uniq(
    [...(Array.isArray(tags) ? tags : []), ...event.tags]
      .filter((t) => Array.isArray(t) && t[0] === 'p' && HEX.test(t[1]))
      .map((t) => t[1]),
  );
  return { event, pubkeys };
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

export async function sendRoomReaction(signer, room, message, emoji) {
  const event = await signer.sign({
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
  return publish(uniq([...room.relays, ...APP_RELAYS]), event, signer);
}

// NIP-09 deletion of our own room events (reactions: k=7, messages: k=9).
export async function sendRoomDeletion(signer, room, ids, kind) {
  const event = await signer.sign({
    kind: 5,
    created_at: now(),
    content: '',
    tags: [['h', room.address], ['k', String(kind)], ...ids.map((id) => ['e', id])],
  });
  return publish(uniq([...room.relays, ...APP_RELAYS]), event, signer);
}

export function enableAuth(signer) {
  pool.automaticallyAuth = () => (t) => signer.sign(t);
}
