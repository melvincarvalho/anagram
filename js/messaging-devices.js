// Read-only Settings view: no runtime, signer, device creation or relay publishing.
import { verifyEvent } from '../vendor/nostr-tools.mjs';
import * as nostr from './nostr.js';
import * as db from './db.js';

export async function loadMessagingDevices(owner, {
  relays = nostr.NDR_RELAYS,
  fetchEvents = (filter) => nostr.fetchNdrEvents(relays, filter),
  readCurrentDevice = (account) => db.ndrStorage(account).get('v1/device-manager/identity-public-key'),
  loadParser = () => import('../vendor/nostr-double-ratchet.mjs').then((module) => module.AppKeys),
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error('Invalid account.');
  const [events, currentDevice] = await Promise.all([
    fetchEvents({ kinds: [37368], authors: [owner], limit: 10 }),
    readCurrentDevice(owner),
  ]);
  const candidates = events.filter((event) => {
    try {
      return event.kind === 37368 && event.pubkey === owner && event.content === '' &&
        Number.isSafeInteger(event.created_at) && event.created_at >= 0 && event.created_at <= Date.now() / 1000 + 300 &&
        event.tags.some((tag) => tag[0] === 'type' && tag[1] === 'app_keys_roster_snapshot') && verifyEvent(event);
    } catch { return false; }
  }).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
  if (!candidates.length) return [];
  const AppKeys = await loadParser();
  for (const event of candidates) {
    try {
      const devices = AppKeys.fromEvent(event).getAllDevices();
      if (devices.some((device) => !/^[a-f0-9]{64}$/.test(device.identityPubkey))) continue;
      return devices.map((device) => ({
        pubkey: device.identityPubkey,
        current: device.identityPubkey === currentDevice,
      })).sort((a, b) => Number(b.current) - Number(a.current) || a.pubkey.localeCompare(b.pubkey));
    } catch { /* Ignore malformed or unsupported snapshots, never trust their device tags. */ }
  }
  return [];
}
