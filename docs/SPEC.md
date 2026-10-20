# nostr.chat interoperability profile

What nostr.chat puts on the wire and what it accepts. This is written from the code
(`js/nostr.js`, `js/store.js`, `js/transport.js`, `js/ndr*.js`) and is meant for anyone
who wants to talk to a nostr.chat user from another client, a bot, or a server, without
reading the client. It is a profile of existing Nostr specifications, not a new protocol:
where this document and a NIP disagree, that is a bug here.

Status: describes the client as deployed at https://nostr.chat on 2026-10-20. Sections are
numbered so other documents can cite them. "MUST", "SHOULD" and "MAY" are used in the
usual sense for what *this client* does; a line marked **Tolerated** describes input the
client accepts beyond what it sends.

Contents

1. Identity
2. Relays and the transport scopes
3. Direct messages (NIP-17)
4. Public rooms (Anagram public groups)
5. Private lists and settings
6. Media
7. Double-ratchet binding (optional)
8. Message requests, trust and policy
9. Conformance summary
10. Known gaps

---

## 1. Identity

1.1 A person is a secp256k1 public key, written as `did:nostr:<64 hex>` in links, copy
buttons and documents. `npub1…` is display only. Inputs accept, in this order: a
`did:nostr:` URI, bare hex, `npub`, `nprofile`, a `nostr:` prefixed form of any of those,
a `name@domain` NIP-05 address, and profile links of the forms
`https://nostr.social/<hex>` and `https://nostr.chat/#/dm/did:nostr:<hex>`.

1.2 Profiles are kind 0. When reading, the newest of (relay copies from the `index`
scope, the signed kind 0 returned by nostr.social `/api/profile/<hex>`) wins. Every
directory answer is a full signed event and is verified locally; an unsigned DID
document profile is only a display hint until a signed kind 0 arrives.

1.3 Publishing a profile MUST start from the newest copy the client could read (1.2),
merge the edited fields over it, and set `created_at` to at least `previous + 1`. If no
previous copy could be read and the account is not brand new, the client refuses to
publish rather than overwrite blind. `name` is mirrored into `display_name`.

1.4 NIP-05 verification fetches `https://<domain>/.well-known/nostr.json?name=<name>`.
It runs automatically only for the account itself, its contacts and people it has
messaged; for anyone else it runs on an explicit tap. A name is shown as verified only if
the domain maps it to this exact key.

1.5 The DID document for a key is resolved from `https://nostr.social/.well-known/did/nostr/<hex>.json`
(`/api/did/<hex>` returns the same document plus follower and following counts). The
client checks `id` equals `did:nostr:<hex>` and whether a verification method ends in
the hex key. Service entries, `alsoKnownAs` and `follows` are read from it when present.

## 2. Relays and the transport scopes

2.1 All relay access goes through one module (`js/transport.js`). Code above it names a
**scope**, never a relay list. A future HTTP transport (NIP-98 signed requests to one
base URL) must offer the same scopes; nothing above the transport changes.

| Scope | Resolves to | Used for |
|---|---|---|
| `'app'` | the shared app relays | fallback for everything |
| `'index'` | app relays + indexers (purplepag.es, indexer.coracle.social, relay.nos.social) | anyone's kind 0, 10002, 10050, follow lists |
| `'self'` | the account's own inbox relays (kind 10050) + app relays + indexers | the account's gift wraps, private lists, settings |
| `{ room }` | the room definition's `relay` tags + app relays | room definition, kind 9, room reactions and deletions |
| `{ peer, relays }` | the recipient's relays + app relays | a DM to that person |
| `{ relays, index? }` | an explicit list + app relays (+ indexers) | publishing relay lists |
| `'ndr'` / `{ ndr: true, relays }` | own inbox relays + app relays + relay.snort.social (+ a recipient's inbox) | double-ratchet discovery and envelopes (section 7) |

App relays today: relay.nostr.com, relay.damus.io, nostr.mom, nostr.bitcoiner.social, nos.lol.

2.2 Every read has a deadline (6 s). A relay that never answers must not stall the
client.

2.3 **Publish success** means at least one relay in scope accepted the event, with one
exception: for a `{ peer }` scope, success requires acceptance by one of the
recipient's own relays whenever the recipient has published any. Acceptance by shared
relays only is reported as *partial*: the event exists, but not where the recipient
reads. The UI shows this as ⚠ with retry, never as ✓.

2.4 **Recipient relay selection**, in order: the recipient's kind 10050 `relay` tags;
if none, the read relays (`r` tags without a marker or marked `read`, at most 8) from
their newest kind 10002, taken from nostr.social `/api/relays/<hex>` and the `index`
scope; if still none, the app relays alone (and then 2.3's exception does not apply).

2.5 **History paging** is per relay: each relay has its own `until` cursor per chat,
so a slow or sparse relay cannot hide events another relay holds. DMs page the
account's gift wraps 500 at a time; rooms page kind 9 100 at a time.

2.6 **AUTH** (NIP-42) is answered with the account's signer when a relay asks. A relay
that rejects the answer is logged once and otherwise ignored; publishes to it fail
normally.

2.7 **Own relay lists.** On new-account setup (the first three app relays) and whenever
the inbox relays are edited, the client publishes kind 10050 (`relay` tags) and kind
10002 (`r` tags, read+write; best effort) to the chosen relays plus the indexers, so other clients and the DID document learn where
to reach the account. Relay URLs are normalised to `wss://` with a trailing slash;
`ws://` is rejected (the page's CSP would block it anyway).

## 3. Direct messages (NIP-17)

3.1 **Rumor.** An unsigned event `{ pubkey, created_at, kind, tags, content }` with
`id = sha256` of the serialised event. Kinds sent: 14 (text), 7 (reaction), 5
(deletion). **Tolerated**: kind 15 (file message) is received and rendered (3.9); it is
never sent.

3.2 **Seal and wrap.** The rumor is NIP-44 encrypted to the recipient inside a signed
kind 13 seal, which is NIP-44 encrypted to the recipient inside a kind 1059 gift wrap
signed by a fresh random key, with one `['p', recipient]` tag. Seal and wrap
`created_at` are each fuzzed up to two days into the past. The sender always makes a
second wrap addressed to itself (the "own copy") unless the recipient is itself. The
recipient's wrap is published to `{ peer, relays }` (2.3, 2.4); the own copy to
`'self'` and its failure is ignored.

3.3 **Unwrapping.** Wraps larger than 200 000 bytes are rejected. The seal must be a
valid signed kind 13; the rumor's `pubkey` must equal the seal's `pubkey`; `created_at`
and `kind` must be safe integers and `tags` an array. The rumor's own `id` field is
ignored and recomputed. A wrap that fails for a permanent reason is marked done; one
that fails because the signer was unavailable is retried next session.

3.4 **Peer.** The chat a rumor belongs to is the one key among `{ rumor.pubkey, all p tags }`
that is not the account. If there is more than one such key the rumor is dropped: group
DMs are out of scope. A rumor with no other key is the note-to-self chat.

3.5 **Text message (kind 14).** Tags, in this order:
`['p', recipient]`; `['e', <id>, '', 'reply']` when replying; `['e', <previous id>, '', 'edit']`
when editing (3.6); then any attachment tags (6.2). Content is plain text. Mentions are
written as `nostr:nprofile1…` (no relay hints) inside the text; `did:nostr:` and
`nostr:npub…` are also rendered as mentions when received.

3.6 **Edits** (Anagram's convention). A replacement is a new kind 14 whose
`created_at` equals the original's, with `['e', <id of the version being replaced>, '', 'edit']`.
The client collapses the chain and shows the newest version marked "edited". Only a
replacement from the same `pubkey` as the original is honoured.

3.7 **Reactions (kind 7).** Tags: `['p', recipient]`, `['e', <id of the root message>]`,
`['p', <message author>]`, `['k', <kind of the message, usually 14>]`. Content is the
emoji; `+` or empty means 👍, `-` means 👎. Reacting with the same emoji again sends a
deletion (3.8) of the earlier reaction instead. Reactions target the *root* id of an
edited message; earlier ids are mapped to it.

3.8 **Deletions (kind 5).** Tags: `['p', recipient]`, one `['e', id]` per target,
`['k', <kind>]`. Empty content. A deletion is honoured only for targets whose author
equals the deletion's `pubkey`; anyone else's deletion request for an id is recorded
but has no effect on display. Deleting an edited message deletes every version.

3.9 **File messages (kind 15), received only.** Content is the file URL; tags
`file-type`, `encryption-algorithm` (only `aes-gcm` is supported), `decryption-key`
and `decryption-nonce` (hex) are used to fetch and decrypt on tap.

3.10 **Inbox subscription.** `{ kinds: [1059], '#p': [self] }` on the `'self'` scope,
with `since = last sync − 3 days` (covering the two-day fuzz) or `limit: 1000` on first
run, kept open for live delivery. Decrypted messages are cached locally; wraps are
remembered by id so nothing is decrypted twice.

3.11 **Timestamps.** Rumor `created_at` is the real send time (not fuzzed) and is what
the UI orders by. The client treats `created_at` more than 5 minutes in the future as
invalid for double-ratchet events; NIP-17 rumors are shown as received.

## 4. Public rooms (Anagram public groups)

4.1 **Definition**: kind 34550 signed by the owner. Required tags: `['d', <slug>]`
(1–128 chars of `[a-zA-Z0-9_-]`), `['anagram-room', '1']`, one `['name', …]` (1–100
chars), at least one `['relay', wss://…]` (at most 8 are used). Optional:
`['description', …]` (up to 2000 chars kept), `['image', https://…]`, any number of
`['trusted', hex]` and `['blocked', hex]`, one `['pinned', <event id>]`, and
`successor` / `predecessor` and any unknown tags, which are preserved verbatim when the
owner edits the room from this client. Duplicate single-value tags make the definition
invalid. The address is `34550:<owner>:<slug>`; links are `naddr` with the relays.

4.2 **Newest definition wins.** When editing, `created_at` is `max(now, previous + 1)`
and every tag not being changed is copied from the previous definition.

4.3 **Policy** (4.1's tags): the owner is always `trusted`; a key in `blocked` is
`blocked` (the owner cannot be blocked); a key in `trusted` is `trusted`; everyone else
is `plain`. Blocked authors' messages are not shown. For `plain` authors, URLs in text
are shown as non-clickable plain text and attachments are not loaded; only `trusted`
authors may post media from this client. A room definition that cannot be refreshed is
used from cache, and the client still goes live on its relays.

4.4 **Message**: kind 9 with exactly one `['a', <room address>]`, content 1–8000 chars,
`created_at` no more than 60 s in the future. Replies carry
`['q', <id of the root message>, <first room relay or ''>, <author>]`. Edits follow 3.6
with the same `created_at` as the original, `['e', <current id>, '', 'edit']`, plus
`['e', <root id>]` when the root differs, and copy the original's `q` and `imeta` tags.
Attachments follow 6.2.

4.5 **Reactions**: kind 7 with `['h', <address>]`, `['e', <id>, <relay>, <author>]`,
`['p', <author>]`, `['k', '9']`. **Deletions**: kind 5 with `['h', <address>]`,
`['k', '9' | '7']` and one `['e', id]` per target; honoured only from the target's
author.

4.6 **Subscriptions** on the `{ room }` scope: `{ kinds: [9], '#a': [address], limit: 100 }`
and `{ kinds: [5, 7], '#h': [address], limit: 500 }`, both kept live. Older history
pages per relay (2.5).

4.7 **Starter room.** The client ships one owner-signed definition ("Anagram rants") so
a first run shows a room before any relay answers; it is refreshed like any other.

## 5. Private lists and settings

All three are encrypted to the account's own key with NIP-44 and published on the
`'self'` scope. Each is replaceable, so a publish always merges over the newest copy
the client could read and sets `created_at ≥ previous + 1`.

5.1 **Contacts**: kind 30000, tags `['d', 'contacts']`, `['title', 'Contacts']`,
content = NIP-44 of a JSON array of `['p', hex]`. When reading, public `p` tags on the
event are merged in as well. A person is added when the account first messages them
(never for note-to-self). The client refuses to publish if it could not read the
current list.

5.2 **Mute list**: kind 10000. Private entries in the encrypted content: `['bp', hex]`
means blocked by this client; `['p', hex]` and any other entries (words, threads) are
preserved untouched. Public tags are copied as-is. Blocking removes a `['p', hex]`
duplicate for the same key.

5.3 **Settings sync**: kind 30078 with `['d', 'nostr.chat']`. Anagram's own
preferences live under `d=1` with a different schema and are never read or written.
Content (NIP-44 to self), version 1:

```json
{ "v": 1,
  "read":   { "<peer hex or room address>": <last read created_at>, ... },   // max 400, newest kept
  "pinned": { "<chat key>": { "on": true|false, "at": <unix seconds> }, ... },
  "muted":  { "<chat key>": { "on": true|false, "at": <unix seconds> }, ... },
  "hidden": [ "<event id>", ... ] }                                             // max 500, newest kept
```

Merge rules: `read` takes the maximum per key; `pinned` and `muted` take the entry with
the newer `at` per key; `hidden` is a union. The client publishes a few seconds after a
change (and when the tab is hidden) and subscribes to its own kind 30078 so other
devices' copies merge live.

## 6. Media

6.1 **Upload** goes to a Blossom server (default `https://blossom.nostr.build`, any
`https://` origin may be configured): `PUT /upload` with the file as body,
`Content-Type`, `X-SHA-256`, and `Authorization: Nostr <base64 JSON>` of a kind 24242
event with tags `['t', 'upload']`, `['expiration', now + 15 min]`, `['server', host]`,
`['x', sha256]`. Only `image/*`, `video/*`, `audio/*` up to 20 MiB. The response must be
JSON with an `https://` `url`.

6.2 **Attachment**: like Anagram, the URL goes into the message text and an
`['imeta', 'url <url>', 'm <mime>', 'size <bytes>', 'x <sha256>']` tag is added. When
rendering, `imeta` mime types are authoritative (so `audio/webm` is audio); a bare URL
in text is classified by extension. Voice notes are `audio/webm` sent this way.

6.3 **Delete**: `DELETE /<sha256>` with a kind 24242 auth whose tags are
`['t', 'delete']`, `['expiration', …]`, `['x', sha256]` (used by tests; not exposed in
the UI yet).

6.4 Media and avatars load with `Referrer-Policy: no-referrer`. Inline media loads
automatically only from contacts and trusted room members; otherwise on tap.

## 7. Double-ratchet binding (optional)

The protocol is Martti Malmi's *Nostr Double Ratchet* (NIP draft 117/118,
`nostr-double-ratchet` library, pinned at 0.0.179 in `vendor/`). This section only
describes how nostr.chat binds to it; the protocol itself is specified there.

7.1 **Discovery.** A person is "compatible" when their newest owner-signed kind 37368
roster (`['type', 'app_keys_roster_snapshot']`, `['schema', '1']`,
`['owner_pubkey', <hex>]`, a UUID `['i', …, 'subject']` tag, `device` tags with hex
keys and integer timestamps, at most 100) lists at least one device. The client checks
this on the `'ndr'` scope with `{ kinds: [37368], authors: [peer], limit: 10 }` when a
chat in Auto mode is opened, keeps the subscription live while the chat is open, and
waits up to 3 s for the first answer.

7.2 **Modes** (per account, stored locally as `lite:prefer-ndr`): `ask` (default:
discovery runs, a compatible peer raises an offer, nothing is published until
accepted), `on` (compatible Auto chats upgrade as soon as found), `off` (no discovery at
all; existing sessions keep running). A per-chat choice of `auto` / `nip17` / `ndr`
overrides the mode; choosing `ndr` before the browser has ever registered asks for
confirmation and pins the current mode so the account is not silently switched to `on`.

7.3 **Registration** publishes a signed kind 37368 roster for the account that adds
this browser's device key and keeps every device already listed. Before registering,
the roster is read with a confirmed query: only a real EOSE counts, and an empty answer
is accepted only from at least two relays. Registration also publishes the device's
invite (signed by the device key).

7.4 **Messages** inside a session are rumors of kind 14 (text, with `['p', peer]`,
`['ms', <milliseconds>]`, optional `['e', <root id>]` for replies and attachment tags
per 6.2), 1009 (edit: content = new text, exactly one `['e', <root id>]`, `['k', '14']`,
optional `ms`), 7 (reaction, as 3.7) and 5 (deletion, as 3.8). A rumor is accepted only
when its `pubkey` equals the verified session owner, its hash equals its `id`, its
`created_at` is within 5 minutes of now, and an `expiration` tag, if present, is in the
future. Rumors with an `l` tag (private groups) are ignored.

7.5 **Rules.** A chat that has used double ratchet never downgrades automatically.
Reactions, edits and deletions always use the transport of the message they refer to.
A failed ratchet send is queued durably and retried; it never falls back to NIP-17.
The ✓ tick on a ratchet message means a relay accepted an envelope, not a read receipt.
Session state lives in the browser that registered. New messages (sent and received) are also delivered to the account's other registered devices by the protocol; a device registered later does not receive earlier history.

7.6 **Relays.** Discovery, registration and envelopes use the `'ndr'` scope
(own inbox relays, app relays, relay.snort.social, plus the recipient's inbox relays for
a send). This is the only place the client contacts relay.snort.social.

## 8. Message requests, trust and policy

8.1 A DM sender is **known** if they are the account itself, in the contact list
(5.1), in the account's follow list (its kind 3, as indexed by nostr.social
`/api/follows/<hex>` and verified locally), previously accepted, or someone the account
has already written to. Messages from unknown senders are shown under "Requests", do
not trigger notifications, and the chat moves to the main list on Accept (which adds
the contact) or disappears on Block (5.2).

8.2 Blocking (5.2) hides the person's messages everywhere and removes their chat;
unblocking restores it. "Delete for me" hides a single message locally and syncs the
id (5.3) without publishing a deletion.

8.3 Deletions are honoured only from the target's author (3.8, 4.5). Nobody can hide or
resurrect someone else's message by publishing kind 5.

8.4 Notifications are per account: DMs on/off, rooms off / mentions / all; muted chats
never notify. A message mentions the account when a `p` or `q` tag names its key (as
the tag's value or as the author field of a `q` tag), or the text contains its
`did:nostr:`, `npub` or an `nprofile` that decodes to it.

## 9. Conformance summary

To exchange messages with a nostr.chat user, a client or bot needs to:

- Address people by hex key; accept `did:nostr:<hex>` as an alias of it.
- Send NIP-17 as in 3.1–3.5 and deliver the recipient's wrap to one of their kind 10050
  relays (2.4). Fuzzing is expected but not required on receive.
- Mark replies with `['e', id, '', 'reply']` and edits with `['e', id, '', 'edit']` and the
  original's `created_at` (3.5, 3.6).
- Use `['imeta', …]` for attachments and put the URL in the text (6.2).
- For rooms, follow 4.1 and 4.4 exactly; unknown definition tags are fine.
- Treat kind 5 as a request that only the author may make (3.8).
- Optionally, publish a kind 37368 roster and speak Nostr Double Ratchet (7) to reach a
  user who has turned it on; otherwise NIP-17 always works.

What nostr.chat tolerates beyond what it sends: kind 15 file messages (3.9); `p` tags
on the contact list event (5.1); relay lists with `ws://` are read but not used;
unknown tags everywhere.

## 10. Known gaps

- Group DMs (more than one other `p` tag) are dropped (3.4).
- Kind 15 files are received, not sent (3.9); Blossom delete is not in the UI (6.3).
- A device registered later does not receive earlier ratchet history (7.5). Iris fills
  this with a device-to-device history reconciliation (Negentropy over a ratchet session
  between one's own devices); this client does not implement it yet.
- There is no server of ours yet; sections 2.1–2.5 are the contract the planned NIP-98
  HTTP transport has to meet, including a confirmed-empty read for 7.3.
- No push notifications while the tab is closed.
