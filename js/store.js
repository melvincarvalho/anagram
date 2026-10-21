// The store: app state as Preact signals, and every action the UI can take. This file is
// the public surface; the implementation lives in ./store/ by feature:
//   core      signals, storage, toast, routing, connection status
//   accounts  login/logout/switch, remembered accounts, teardown
//   prefs     read marks, pins/mutes, drafts, hidden messages, notifications, settings sync
//   people    profiles, did:nostr, NIP-05, contacts, blocking, requests, own relays
//   messages  edit chains, deletions, reactions, saving, send status, message actions
//   dms       NIP-17 inbox, unwrapping, paging, sending
//   rooms     public rooms and owner tools
//   ratchet   optional double-ratchet DMs
//   media     Blossom uploads
export {
  me,
  profiles,
  dms,
  inboxRelays,
  syncing,
  joinedRooms,
  roomState,
  route,
  toast,
  reactions,
  contacts,
  chatPrefs,
  blocked,
  clearedAt,
  drafts,
  readMarks,
  notify,
  go,
  connection,
} from './store/core.js';
export {
  accounts,
  addingAccount,
  switchAccount,
  login,
  restoring,
  restoreSession,
  logout,
} from './store/accounts.js';
export {
  hidden,
  isHidden,
  hideMessage,
  isPinned,
  isMuted,
  togglePinned,
  toggleMuted,
  setDraft,
  markRead,
  readPoint,
  unreadCount,
  unreadMentions,
  markAllRead,
  totalUnread,
  onIncoming,
  notifySettings,
  setNotifySettings,
  mentionsMe,
} from './store/prefs.js';
export {
  myFollows,
  accepted,
  isKnown,
  acceptRequest,
  isBlocked,
  toggleBlock,
  deleteChat,
  requestProfiles,
  displayName,
  rememberProfiles,
  followsOf,
  didDocs,
  resolveDid,
  nip05Verified,
  verifyNip05Now,
  verifiedNip05,
  nip05State,
  saveProfile,
  setUpNewAccount,
  publishDefaultInbox,
  saveInboxRelays,
  relayDirectory,
  loadRelayDirectory,
  conversations,
  chatList,
  requests,
} from './store/people.js';
export {
  deleteMedia,
  mediaServer,
  setMediaServer,
  uploadMedia,
} from './store/media.js';
export {
  searchMessages,
  editTarget,
  rootId,
  sendStatus,
  retrySend,
  toggleReaction,
  forwardMessage,
  deleteMessage,
  editMessage,
} from './store/messages.js';
export {
  dmHistoryDone,
  loadOlderDirectMessages,
  sendDirectMessage,
} from './store/dms.js';
export {
  openRoom,
  quotes,
  fetchQuote,
  loadUntil,
  loadOlderRoomMessages,
  joinRoom,
  updateRoom,
  setMemberPolicy,
  pinMessage,
  leaveRoom,
  createRoom,
  sendRoomMessage,
} from './store/rooms.js';
export {
  directProtocols,
  preferDoubleRatchet,
  ndrDecided,
  ndrOffer,
  ndrActivated,
  doubleRatchetMode,
  protocolChecking,
  directPreference,
  directProtocol,
  closeDirectChat,
  openDirectChat,
  setDoubleRatchetMode,
  setPreferDoubleRatchet,
  dismissNdrOffer,
  acceptNdrOffer,
  prepareDirectProtocol,
  setDirectProtocol,
} from './store/ratchet.js';
