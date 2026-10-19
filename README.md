# Anagram lite

A no-build Preact client for private Nostr DMs and public chat rooms, wire-compatible with [Anagram](https://github.com/lnbits/anagram).

- **Identity:** people are addressed by [did:nostr](https://did-nostr.com) (`did:nostr:<hex pubkey>`) in links and copy buttons. `npub` is display only.
- **DMs:** NIP-17 kind 14 rumors, sealed (kind 13) and gift-wrapped (kind 1059) with NIP-44. Sent to the recipient's kind 10050 inbox relays plus the default relays. Decrypted messages are cached in IndexedDB.
- **Contacts:** Anagram's private contact list (kind 30000, `d=contacts`, NIP-44 to self), read on login and extended when you message someone new.
- **Rooms:** Anagram's public groups, i.e. NIP-72 `kind:34550` definitions with NIP-C7 `kind:9` messages and `q` replies. The owner's `trusted`/`blocked` tags are honoured: blocked authors are hidden, and only trusted authors get clickable links. "Anagram rants" is preloaded.
- **Media:** photos, video and audio upload to a Blossom server (default `blossom.nostr.build`, as Anagram) with a kind 24242 auth event, and are sent as NIP-92 `imeta` attachments. In rooms only trusted members may post media.
- **Login:** nsec (kept in localStorage), NIP-07 extension (needs NIP-44), or a NIP-46 `bunker://` signer.

## Transport

`js/transport.js` is the only module that talks to relays. Everything above it (`nostr.js` protocol helpers, `store.js`) asks for a **scope** rather than relay URLs: `'app'`, `'index'` (profiles and lists of anyone), `'self'` (your own inbox relays, lists and settings), `{ room }`, `{ peer, relays }` (a DM recipient; a publish only counts if one of *their* relays accepts) or an explicit `{ relays }`. The transport resolves scopes to relay sets, runs reads with a deadline, keeps the per-relay history cursors, answers NIP-42 AUTH, reports whether anything is connected, and resets on account switch.

Relays are the interim transport. The plan is NIP-98-authenticated HTTP ([nip98.com](https://nip98.com)): one base URL where `query`/`subscribe`/`publish` become `GET`/`SSE`/`POST` with the scope as a parameter and a signed kind 27235 `Authorization` header from the account's signer. That swap is a change to `transport.js` alone; the scopes, the signers and everything in `store.js` stay as they are.

## Privacy

What leaves your device, and to whom. Nothing here is hidden from you; this is the list.

- **Relays** (`APP_RELAYS` in `js/nostr.js`, plus the inbox relays people publish in kind 10050 and a room's own relays) see your IP, the gift-wrapped DMs you send and receive (not their contents), and your public room messages. DM content is NIP-44 encrypted end to end; relays see only wrapped events with a random throwaway sender key.
- **nostr.social** (the did:nostr directory, `DIRECTORY` in `js/nostr.js`; source: [beacon](https://github.com/melvincarvalho/beacon)) is asked for the profiles of people you chat with and of room posters, for people search, and for follow lists on the New message screen. It therefore sees your IP and which public keys you look up. Everything it returns is a signed Nostr event that is verified locally; nothing is sent to it other than those lookups.
- **Blossom** (`blossom.nostr.build` by default, changeable in Settings) receives the files you choose to upload, with a kind 24242 auth event signed by your key.
- **Avatars and media hosts**: profile pictures load automatically from wherever the profile points (with `Referrer-Policy: no-referrer`). Images, video and audio inside messages load automatically only from trusted room members and your contacts; for anyone else you tap "Show media" first, because loading a file tells its host your IP.
- **NIP-05 addresses** (`name@domain`) are verified by fetching `https://domain/.well-known/nostr.json`. This happens automatically for yourself, your contacts and people you have messaged; for anyone else the address is shown unverified with a "verify" tap.
- **Your key** stays in this browser (localStorage) or in your NIP-07 extension / NIP-46 signer. No account server, no analytics, no third-party scripts (the CSP allows only same-origin code).

## Run

Serve the folder with any static server, e.g. `python3 -m http.server`, and open it. Preact, signals, htm and nostr-tools are vendored as pinned ES modules in `vendor/` (see its README) and wired up by the import map in `index.html`, so no third-party code runs and the CSP allows only same-origin scripts. The `gh-pages` branch is the site.

Not included yet: calls, private groups (NIP-171), push notifications when the tab is closed.
