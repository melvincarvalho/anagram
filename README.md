# Anagram lite

A no-build Preact client for private Nostr DMs and public chat rooms, wire-compatible with [Anagram](https://github.com/lnbits/anagram).

- **Identity:** people are addressed by [did:nostr](https://did-nostr.com) (`did:nostr:<hex pubkey>`) in links and copy buttons. `npub` is display only.
- **DMs:** NIP-17 kind 14 rumors, sealed (kind 13) and gift-wrapped (kind 1059) with NIP-44. Sent to the recipient's kind 10050 inbox relays plus the default relays. Decrypted messages are cached in IndexedDB.
- **Optional Iris DMs:** choose **Double ratchet (Iris)** under a person’s chat info to use `nostr-double-ratchet`. NIP-17 stays the default, and both transports are received side by side. The optional library loads only after activation; this registers a local device through your existing signer. Device keys, sessions and queued encrypted events stay in IndexedDB.
- **Contacts:** Anagram's private contact list (kind 30000, `d=contacts`, NIP-44 to self), read on login and extended when you message someone new.
- **Rooms:** Anagram's public groups, i.e. NIP-72 `kind:34550` definitions with NIP-C7 `kind:9` messages and `q` replies. The owner's `trusted`/`blocked` tags are honoured: blocked authors are hidden, and only trusted authors get clickable links. "Anagram rants" is preloaded.
- **Media:** photos, video and audio upload to a Blossom server (default `blossom.nostr.build`, as Anagram) with a kind 24242 auth event, and are sent as NIP-92 `imeta` attachments. In rooms only trusted members may post media.
- **Login:** nsec (kept in localStorage), NIP-07 extension (needs NIP-44), or a NIP-46 `bunker://` signer.

## Run

Serve the folder with any static server, e.g. `python3 -m http.server`, and open it. Preact, signals, htm and nostr-tools are vendored as pinned ES modules in `vendor/` (see its README) and wired up by the import map in `index.html`, so no third-party code runs and the CSP allows only same-origin scripts. The `gh-pages` branch is the site.

Not included yet: calls, private groups (NIP-171), push notifications when the tab is closed.

## Double-ratchet messaging

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
Relay backfill is bounded to 200 matching events per subscription; this is not a
full history import.

Private groups, device-history synchronization, typing/read receipts and Iris’s
separate encrypted-file transfer format are outside this integration.

Maintainers can run `npm ci && npm test` for protocol, persistence and transport
selection tests. `npm run vendor:ndr` reproducibly refreshes the optional pinned
vendor file; serving the website still requires no install or build. See
[`vendor/README.md`](vendor/README.md) for provenance and size.
