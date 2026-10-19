# Anagram lite

A no-build Preact client for private Nostr DMs and public chat rooms, wire-compatible with [Anagram](https://github.com/lnbits/anagram).

- **Identity:** people are addressed by [did:nostr](https://did-nostr.com) (`did:nostr:<hex pubkey>`) in links and copy buttons. `npub` is display only.
- **DMs:** NIP-17 kind 14 rumors, sealed (kind 13) and gift-wrapped (kind 1059) with NIP-44. Sent to the recipient's kind 10050 inbox relays plus the default relays. Decrypted messages are cached in IndexedDB.
- **Contacts:** Anagram's private contact list (kind 30000, `d=contacts`, NIP-44 to self), read on login and extended when you message someone new.
- **Rooms:** Anagram's public groups, i.e. NIP-72 `kind:34550` definitions with NIP-C7 `kind:9` messages and `q` replies. The owner's `trusted`/`blocked` tags are honoured: blocked authors are hidden, and only trusted authors get clickable links. "Anagram rants" is preloaded.
- **Login:** nsec (kept in localStorage), NIP-07 extension (needs NIP-44), or a NIP-46 `bunker://` signer.

## Run

Serve the folder with any static server, e.g. `python3 -m http.server`, and open it. Preact, signals, htm and nostr-tools are vendored as pinned ES modules in `vendor/` (see its README) and wired up by the import map in `index.html`, so no third-party code runs and the CSP allows only same-origin scripts. The `gh-pages` branch is the site.

Not included yet: calls, private groups (NIP-171), media uploads, push notifications when the tab is closed.
