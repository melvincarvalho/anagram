// The transport: the only module that talks to relays. Everything above it asks for a
// *scope* (what the data is about), never for relay URLs, so swapping the relay pool for
// NIP-98-authenticated HTTP endpoints later is a change to this file alone.
//
// Scopes
//   'app'                  the shared app relays
//   'index'                app relays + indexers (profiles, follow and relay lists of anyone)
//   'self'                 your own inbox relays + app relays + indexers (your lists and settings)
//   'ndr' | { ndr: true, relays? } your inbox + shared ratchet relays, optionally a recipient's inbox
//   { room }               a public room's relays + app relays
//   { peer, relays }       a DM recipient: their inbox relays (+ app relays); a publish
//                          succeeds only if one of THEIR relays accepts (partial otherwise)
//   { relays, index? }     an explicit list (+ app relays, + indexers when index: true)
import { SimplePool } from 'nostr-tools';

export const APP_RELAYS = [
  'wss://relay.nostr.com',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://nostr.bitcoiner.social',
  'wss://nos.lol',
];
export const INDEXERS = ['wss://purplepag.es', 'wss://indexer.coracle.social', 'wss://relay.nos.social'];
// Shared with Iris for device discovery and ratcheted messages only.
export const NDR_RELAYS = [...APP_RELAYS, 'wss://relay.snort.social'];

export const uniq = (list) => [...new Set(list.filter(Boolean))];

// Reads always have a deadline; a relay that never answers must not stall the app.
const RELAY_WAIT = 6000;

// Exported for tests, which stub pool.publish; application code never touches it.
export const pool = new SimplePool({ enableReconnect: true });

let ownRelays = []; // the account's inbox relays (kind 10050), set by the store

export function setOwnRelays(list) {
  ownRelays = uniq(list ?? []);
}

export function resolve(scope) {
  if (scope === 'app') return [...APP_RELAYS];
  if (scope === 'index') return uniq([...APP_RELAYS, ...INDEXERS]);
  if (scope === 'self') return uniq([...ownRelays, ...APP_RELAYS, ...INDEXERS]);
  if (scope === 'ndr' || scope?.ndr) return uniq([...ownRelays, ...NDR_RELAYS, ...(scope.relays ?? [])]);
  if (scope?.room) return uniq([...scope.room.relays, ...APP_RELAYS]);
  if (scope?.peer) return uniq([...(scope.relays ?? []), ...APP_RELAYS]);
  if (scope?.relays) return uniq([...scope.relays, ...APP_RELAYS, ...(scope.index ? INDEXERS : [])]);
  throw new Error(`Unknown transport scope: ${JSON.stringify(scope)}`);
}

const withWait = (params) => ({ maxWait: RELAY_WAIT, ...(params ?? {}) });

export const get = (scope, filter, params) => pool.get(resolve(scope), filter, withWait(params));
export const query = (scope, filter, params) => pool.querySync(resolve(scope), filter, withWait(params));

// Device registration must distinguish an empty roster from unavailable relays.
// Only a real EOSE counts; a failed connection or timeout cannot authorize it.
export async function queryConfirmed(scope, filter) {
  const results = await Promise.allSettled(resolve(scope).map(async (url) => {
    const relay = await pool.ensureRelay(url, { connectionTimeout: 5000 });
    return new Promise((resolve, reject) => {
      const events = [];
      let sub, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(sub?.eoseTimeoutHandle);
        sub?.close();
        if (error) reject(error); else resolve(events);
      };
      const timer = setTimeout(() => finish(new Error('Relay discovery timed out')), 5000);
      sub = relay.subscribe([filter], {
        // nostr-tools otherwise synthesizes EOSE after 4.4s; our own deadline
        // must reject that silent connection instead of accepting an empty roster.
        eoseTimeout: 2147483647,
        onevent: (event) => events.push(event),
        oneose: () => finish(),
        onclose: () => finish(new Error('Relay discovery unavailable')),
      });
    });
  }));
  const available = results.filter((result) => result.status === 'fulfilled');
  if (!available.length) throw new Error('Connect to a relay before enabling encrypted messaging.');
  return available.flatMap((result) => result.value);
}

// Live subscription; returns { close() }.
export const subscribe = (scope, filter, { onevent, oneose } = {}) => pool.subscribe(resolve(scope), filter, { onevent, oneose });

// Publish to every relay in scope and resolve as soon as one accepts (the rest carry on).
// For a { peer } scope, success means one of the recipient's own relays accepted: if only
// the shared relays did, the error carries `partial: true` (the event is out there, but
// not where the recipient reads).
export async function publish(scope, event, signer) {
  const relays = resolve(scope);
  const required = scope?.peer ? uniq(scope.relays ?? []) : [];
  const onauth = signer ? (t) => signer.sign(t) : undefined;
  const attempts = pool.publish(relays, event, { onauth }).map((p, i) => p.then(() => relays[i]));
  const needed = required.length ? attempts.filter((_, i) => required.includes(relays[i])) : attempts;
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

// ---------- History paging ----------
// Each relay is paged on its own cursor, so a slow or sparse relay can't make us skip
// events another relay has (Anagram pages per relay too). Cursors are kept per `key`
// (a chat) for the life of the session, or until reset().

const paging = new Map(); // key -> { cursors: Map<relay, oldest created_at>, done: Set<relay> }

// `before`: for a relay with no cursor yet, start below this timestamp (the oldest
// message already on screen) instead of re-fetching the newest page.
export async function pageOlder(scope, filter, key, limit, before) {
  if (!paging.has(key)) paging.set(key, { cursors: new Map(), done: new Set() });
  const { cursors, done } = paging.get(key);
  const relays = resolve(scope);
  const pages = await Promise.all(
    relays
      .filter((r) => !done.has(r))
      .map(async (relay) => {
        const until = cursors.get(relay) ?? before;
        const events = await pool
          .querySync([relay], { ...filter, limit, ...(until ? { until: until - 1 } : {}) }, withWait())
          .catch(() => null);
        if (!events) return []; // relay failed: try it again next time
        if (!events.length) done.add(relay);
        else cursors.set(relay, Math.min(...events.map((e) => e.created_at)));
        return events;
      }),
  );
  return { events: pages.flat(), finished: relays.every((r) => done.has(r)) };
}

export const resetPaging = (key) => (key ? paging.delete(key) : paging.clear());

// ---------- Connection status & lifecycle ----------

// True when at least one relay connection is open.
export const up = () => [...pool.listConnectionStatus().values()].some(Boolean);

// Answer relay AUTH challenges (NIP-42) with the account's signer. nostr-tools rethrows a
// failed challenge answer with nothing to catch it, so the error is tagged and logged once
// here and app.js swallows the tagged rejection (publishes that needed AUTH still fail
// normally through their own promises).
let authWarned = false;
export function setAuthSigner(signer) {
  pool.automaticallyAuth = signer
    ? (relay) => (t) =>
        signer.sign(t).catch((e) => {
          if (!authWarned) console.warn(`[nostr] could not answer AUTH for ${relay.url}: ${e.message}`);
          authWarned = true;
          e.relayAuth = true;
          throw e;
        })
    : undefined;
}

// Drop every connection and cursor: used when switching accounts, since open
// connections carry the old account's AUTH and would link the two.
export function reset() {
  pool.close([...pool.relays.keys()]);
  paging.clear();
  ownRelays = [];
  setAuthSigner(null);
}
