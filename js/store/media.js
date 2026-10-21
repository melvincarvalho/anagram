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

// Remove the files one of our messages uploaded from the servers they live on. The
// message itself stays; deleting it is a separate action. Resolves to the file count.
export async function deleteMedia(message) {
  if (message.pubkey !== me.value.pubkey) throw new Error('You can only remove your own files.');
  const files = nostr.uploadsOf(message);
  if (!files.length) throw new Error('This message has no uploaded file.');
  await Promise.all(files.map((f) => nostr.deleteBlossom(me.value, f.url, f.sha256)));
  return files.length;
}
