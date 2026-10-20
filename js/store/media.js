// Media uploads (Blossom).
import { signal } from '@preact/signals';
import * as nostr from '../nostr.js';
import { me, storage } from './core.js';

// ---------- Media uploads ----------

export const mediaServer = signal(storage.get('lite:blossom', nostr.DEFAULT_BLOSSOM));
export function setMediaServer(value) {
  const origin = nostr.normalizeBlossomServer(value);
  if (!origin) throw new Error('Enter an https:// server address without a path.');
  mediaServer.value = origin;
  storage.set('lite:blossom', origin);
}
export const uploadMedia = (file) => nostr.uploadBlossom(me.value, file, mediaServer.value);
