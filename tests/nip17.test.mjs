import test from 'node:test';
import assert from 'node:assert/strict';
import * as nostr from '../js/nostr.js';
import * as transport from '../js/transport.js';

test('existing NIP-17 DMs, replies, edits, reactions and deletions remain gift wrapped', async () => {
  const alice = nostr.newKeySigner();
  const bob = nostr.newKeySigner();
  const published = [];
  const original = transport.pool.publish;
  transport.pool.publish = (_relays, event) => { published.push(event); return [Promise.resolve()]; };
  try {
    const first = await nostr.sendDirectMessage(alice, bob.pubkey, 'Hello', [], null, null);
    const reply = await nostr.sendDirectMessage(bob, alice.pubkey, 'Reply', [], first.id, null);
    const edit = await nostr.sendDirectMessage(alice, bob.pubkey, 'Changed', [], null, first);
    const reaction = await nostr.sendRumor(bob, alice.pubkey, 7, '+', [['p', alice.pubkey], ['e', first.id]], []);
    const deletion = await nostr.sendRumor(alice, bob.pubkey, 5, '', [['p', bob.pubkey], ['e', first.id]], []);
    const received = [];
    for (const event of published) {
      assert.equal(event.kind, 1059);
      const signer = event.tags[0][1] === bob.pubkey ? bob : alice;
      received.push(await nostr.unwrap(signer, event));
    }
    for (const event of [first, reply, edit, reaction, deletion]) assert.ok(received.some((row) => row.id === event.id));
    assert.ok(reply.tags.some((tag) => tag[3] === 'reply'));
    assert.ok(nostr.isEdited(edit.tags));
    assert.equal(edit.created_at, first.created_at);
  } finally { transport.pool.publish = original; }
});
