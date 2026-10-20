// In-tab notifications: sound and desktop notification for messages in chats you are
// not looking at. Side-effect module: importing it registers the listener.
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { previewText } from './text.js';
import { playSound } from './sounds.js';
const { route, profiles } = store;

const chatHash = (chat) => (chat.room ? `#/room/${nostr.encodeRoomLink(chat.room)}` : `#/dm/${nostr.did(chat.peer)}`);
const viewing = (chat) => {
  const r = route.value;
  if (document.visibilityState !== 'visible') return false;
  if (chat.room) {
    try {
      return r.kind === 'room' && nostr.decodeRoomLink(r.id).address === chat.room.address;
    } catch {
      return false; // malformed room link in the URL
    }
  }
  return r.kind === 'dm' && nostr.decodePubkey(r.id) === chat.peer;
};

let lastBeep = 0;
store.onIncoming((chat, m) => {
  if (viewing(chat)) return;
  if (store.notifySettings.value.sound && Date.now() - lastBeep > 1500) {
    lastBeep = Date.now();
    playSound(chat.room ? 'room' : 'dm');
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const who = store.displayName(m.pubkey);
  const note = new Notification(chat.room ? `${who} in ${chat.room.name}` : who, {
    body: previewText(m.content).slice(0, 200),
    icon: chat.room?.picture || profiles.value[m.pubkey]?.picture || 'icon.svg',
    tag: chat.room?.address ?? chat.peer, // one notification per chat, replaced by newer ones
  });
  note.onclick = () => {
    window.focus();
    location.hash = chatHash(chat);
    note.close();
  };
});
