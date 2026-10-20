// One bounded roster subscription for the open Auto chat. Negative discovery
// resolves promptly but stays live, so a peer can enable Iris later in the chat.
import { verifyEvent } from '../vendor/nostr-tools.mjs';

export function watchNdrCapability({ peer, subscribe, onCapability, timeoutMs = 3000,
  loadParser = () => import('./ndr.js').then((module) => module.hasNdrDevices) }) {
  let closed = false, ready = false, newest, supported = false, unsubscribe;
  let pending = Promise.resolve();
  let resolveInitial;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const newer = (event) => !newest || event.created_at > newest.created_at ||
    event.created_at === newest.created_at && event.id < newest.id;
  const finish = () => {
    if (closed) return;
    pending.then(() => {
      if (closed || ready) return;
      ready = true;
      clearTimeout(timer);
      onCapability(supported);
      resolveInitial(supported);
    });
  };
  const timer = setTimeout(finish, timeoutMs);
  const onevent = (event) => {
    // Cheap checks keep the optional library out of ordinary NIP-17 sessions.
    if (closed || event.pubkey !== peer || event.kind !== 37368 || event.content !== '' ||
        !Number.isSafeInteger(event.created_at) || event.created_at < 0 || event.created_at > Date.now() / 1000 + 300 ||
        !Array.isArray(event.tags) || !event.tags.some((t) => t[0] === 'type' && t[1] === 'app_keys_roster_snapshot') ||
        event.tags.find((t) => t[0] === 'schema')?.[1] !== '1' ||
        event.tags.find((t) => t[0] === 'owner_pubkey')?.[1] !== peer ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.tags.find((t) => t[0] === 'i' && t[2] === 'subject')?.[1] ?? '') ||
        !verifyEvent(event)) return;
    pending = pending.then(async () => {
      if (closed || !newer(event)) return;
      let compatible = false;
      const devices = event.tags.filter((t) => t[0] === 'device');
      if (devices.length) {
        if (devices.length > 100 || devices.some((t) => !/^[a-f0-9]{64}$/.test(t[1]) || !/^\d+$/.test(t[2]) || !Number.isSafeInteger(Number(t[2])))) return;
        try { compatible = (await loadParser())(event); } catch { return; }
      }
      if (closed) return;
      newest = event;
      supported = compatible;
      if (ready) onCapability(supported);
    });
  };
  try { unsubscribe = subscribe({ kinds: [37368], authors: [peer], limit: 10 }, { onevent, oneose: finish, onclose: finish }); }
  catch { finish(); }
  return {
    initial,
    close() { closed = true; clearTimeout(timer); unsubscribe?.(); resolveInitial(false); },
  };
}
