# Anagram lite

A no-build Preact client for private Nostr DMs and public chat rooms, wire-compatible with [Anagram](https://github.com/lnbits/anagram).

- **Identity:** people are addressed by [did:nostr](https://did-nostr.com) (`did:nostr:<hex pubkey>`) in links and copy buttons. `npub` is display only.
- **DMs:** NIP-17 kind 14 rumors, sealed (kind 13) and gift-wrapped (kind 1059) with NIP-44. Sent to the recipient's kind 10050 inbox relays plus the default relays. Decrypted messages are cached in IndexedDB.
- **Iris-compatible DMs:** new chats use **Auto**, preferring `nostr-double-ratchet` when the peer advertises a compatible device and using NIP-17 otherwise. Existing chats retain their encryption. Settings → Messaging is per account: **Ask me** (default: a compatible contact brings up an offer before this browser registers as a device), **Use it whenever available**, or **Never** (no roster lookups; sessions that already exist keep running). Chat info shows the current protocol and can pin a chat to NIP-17 only or double ratchet only. Both transports are received side by side. The optional library loads only for activation or a verified compatible roster candidate; device registration uses your existing signer. Device keys, sessions and queued encrypted events stay in IndexedDB.
- **Contacts:** Anagram's private contact list (kind 30000, `d=contacts`, NIP-44 to self), read on login and extended when you message someone new.
- **Rooms:** Anagram's public groups, i.e. NIP-72 `kind:34550` definitions with NIP-C7 `kind:9` messages and `q` replies. The owner's `trusted`/`blocked` tags are honoured: blocked authors are hidden; links from untrusted authors are shown as plain text (not clickable) and their media is not loaded. "Anagram rants" is preloaded.
- **Media:** photos, video and audio upload to a Blossom server (default `blossom.nostr.build`, as Anagram) with a kind 24242 auth event, and are sent as NIP-92 `imeta` attachments. In rooms only trusted members may post media.
- **Login:** nsec (kept in localStorage), NIP-07 extension (needs NIP-44), or a NIP-46 `bunker://` signer.

## Transport

`js/transport.js` is the only module that talks to relays. Everything above it (`nostr.js` protocol helpers, `store.js`) asks for a **scope** rather than relay URLs: `'app'`, `'index'` (profiles and lists of anyone), `'self'` (your own inbox relays, lists and settings), `{ room }`, `{ peer, relays }` (a DM recipient; a publish only counts if one of *their* relays accepts) or an explicit `{ relays }`. The transport resolves scopes to relay sets, runs reads with a deadline, keeps the per-relay history cursors, answers NIP-42 AUTH, reports whether anything is connected, and resets on account switch.

Relays are the interim transport. The plan is NIP-98-authenticated HTTP ([nip98.com](https://nip98.com)): one base URL where `query`/`subscribe`/`publish` become `GET`/`SSE`/`POST` with the scope as a parameter and a signed kind 27235 `Authorization` header from the account's signer. That swap is a change to `transport.js` alone; the scopes, the signers and everything in `store.js` stay as they are. It must cover the `'ndr'` scope too: the double-ratchet runtime (`js/ndr.js`) only ever calls `transport.subscribe`, `transport.queryConfirmed` and `transport.publish`, so roster discovery and session envelopes move with the rest, but `queryConfirmed` needs an HTTP equivalent of "a real end-of-stored-events, not a timeout" before a device may be registered.

## Privacy

What leaves your device, and to whom. Nothing here is hidden from you; this is the list (also at [nostr.chat/privacy](https://nostr.chat/privacy), with [nostr.chat/security](https://nostr.chat/security) alongside).

- **Relays** (`APP_RELAYS` in `js/transport.js`, plus the inbox relays people publish in kind 10050 and a room's own relays) see your IP, the gift-wrapped DMs you send and receive (not their contents), and your public room messages. DM content is NIP-44 encrypted end to end; relays see only wrapped events with a random throwaway sender key.
- **relay.snort.social** (`NDR_RELAYS` in `js/transport.js`, shared with Iris) is additionally asked, when you open a chat in "Auto" encryption mode, whether that person has registered a double-ratchet device (their public kind 37368 roster), and carries double-ratchet envelopes once a chat uses them. It therefore sees your IP and which public keys you open chats with. Choosing "Never" under Settings → Messaging stops these lookups.
- **nostr.social** (the did:nostr directory, `DIRECTORY` in `js/nostr.js`; source: [beacon](https://github.com/melvincarvalho/beacon)) is asked for the profiles of people you chat with and of room posters, for people search, and for follow lists on the New message screen. It therefore sees your IP and which public keys you look up. Everything it returns is a signed Nostr event that is verified locally; nothing is sent to it other than those lookups.
- **Blossom** (`blossom.nostr.build` by default, changeable in Settings) receives the files you choose to upload, with a kind 24242 auth event signed by your key.
- **Avatars and media hosts**: profile pictures load automatically from wherever the profile points (with `Referrer-Policy: no-referrer`). Images, video and audio inside messages load automatically only from trusted room members and your contacts; for anyone else you tap "Show media" first, because loading a file tells its host your IP.
- **NIP-05 addresses** (`name@domain`) are verified by fetching `https://domain/.well-known/nostr.json`. This happens automatically for yourself, your contacts and people you have messaged; for anyone else the address is shown unverified with a "verify" tap.
- **Your key** stays in this browser (localStorage) or in your NIP-07 extension / NIP-46 signer. No account server, no analytics, no third-party scripts (the CSP allows only same-origin code).

## Run

Serve the folder with any static server, e.g. `python3 -m http.server`, and open it. Preact, signals, htm and nostr-tools are vendored as pinned ES modules in `vendor/` (see its README) and wired up by the import map in `index.html`, so no third-party code runs and the CSP allows only same-origin scripts. The `gh-pages` branch is the site.

Not included yet: calls, private groups (NIP-171), push notifications when the tab is closed.

## Double-ratchet messaging

Auto checks the open conversation's owner-signed device roster (kind 37368), with
at most ten historical roster events per relay and a three-second initial wait.
An absent or unavailable roster uses NIP-17; the subscription stays live while that
Auto chat is open and rechecks on reopening, so later support upgrades future
messages. Sending does not poll relays. NDR discovery and session traffic also use
`wss://relay.snort.social`, shared with Iris; ordinary NIP-17 and room defaults are unchanged. Once Auto selects double ratchet it never
automatically downgrades, including after failure or disabling the preference.
Existing conversations retain their saved encryption preference.
Chat info shows the current transport; a message's menu shows its own transport.
Settings also lists the account's authorized messaging devices, marking this browser
when its local identity is known. Opening or refreshing the list only reads the
signed roster and local public identity; it does not create or authorize a device.

The optional transport supports direct text messages, replies, reactions, edits and
NIP-92 attachment tags. Both people need a compatible client, such as Iris. New
messages and replies use the selected encryption; reactions, edits and deletions
use the original message’s transport. Failed sends never fall back to NIP-17.
A clock means queued (including when a recipient has not enabled a compatible
device); a check means a relay accepted an encrypted envelope, not a read receipt.

After activation the account listens for both transports on subsequent logins.
Only one tab per account may run the ratchet at a time, using Web Locks to prevent
concurrent writes to the device’s keys. Keep this browser’s data to retain its
sessions and history. Signing out removes its local keys, history and outbox;
clearing browser storage cannot recover old ratchet history from the account key.
Other clients’ device registrations are preserved when registering this browser.
The shared runtime sends new messages to the account’s other authorized devices,
including messages addressed to yourself. This does not import older history.
Relay backfill is bounded to 200 matching events per subscription; this is not a
full history import.

Private groups, importing older history from another device, typing/read receipts
and Iris’s separate encrypted-file transfer format are outside this integration.

Maintainers can run `npm ci && npm test` for protocol, persistence and transport
selection tests. `npm run vendor:ndr` reproducibly refreshes the optional pinned
vendor file; serving the website still requires no install or build. See
[`vendor/README.md`](vendor/README.md) for provenance and size.
