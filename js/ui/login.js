// The signed-out screen: landing page around the sign-in card (extension, key, bunker,
// new account); the plain card when adding a second account.
import { useState } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { html, useAction } from './common.js';
const { me } = store;

export function Login() {
  const [mode, setMode] = useState(window.nostr ? 'extension' : 'nsec');
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [authUrl, setAuthUrl] = useState('');
  const [newName, setNewName] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const signer =
        mode === 'nsec'
          ? nostr.nsecSigner(value)
          : mode === 'extension'
            ? await nostr.extensionSigner()
            : mode === 'bunker'
              ? await nostr.bunkerSigner(value, setAuthUrl)
              : nostr.newKeySigner();
      await store.login(signer, remember);
      if (mode === 'new') store.setUpNewAccount(newName).catch((e) => store.notify(`Profile setup failed: ${e.message}`));
    });
  };

  const tabs = [
    ['extension', 'Extension'],
    ['nsec', 'Private key'],
    ['bunker', 'Bunker'],
    ['new', 'New account'],
  ];
  const adding = !!me.value;
  const form = html`<form class="card" onSubmit=${submit}>
      ${adding
        ? html`<h1>nostr.chat</h1><p class="muted">Add another account.</p>`
        : html`<h2>Open nostr.chat</h2><p class="muted">One tap with a signer extension, or bring a key. New here? Make an account in seconds.</p>`}
      <div class="tabs">
        ${tabs.map(
          ([id, label]) =>
            html`<button type="button" class=${mode === id ? 'on' : ''} onClick=${() => setMode(id)}>${label}</button>`,
        )}
      </div>
      ${mode === 'nsec' &&
      html`<input type="password" autocomplete="off" placeholder="nsec1…" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'bunker' &&
      html`<input placeholder="bunker://… or name@domain" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'extension' &&
      html`<p class="muted">${window.nostr ? 'Sign in with your browser extension (needs NIP-44).' : 'No extension detected.'}</p>`}
      ${mode === 'new' &&
      html`<input placeholder="Your name" maxlength="80" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <p class="muted">Generates a fresh key in this browser. Back it up from Settings afterwards.</p>`}
      ${mode !== 'extension' &&
      html`<label class="check"><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} /> Stay signed in on this device</label>`}
      ${mode === 'nsec' && remember && html`<p class="muted small">Your key will be stored unencrypted in this browser.</p>`}
      ${authUrl && html`<p>Approve in your signer: <a href=${authUrl} target="_blank" rel="noopener">${authUrl}</a></p>`}
      ${error && html`<p class="error">${error}</p>`}
      <button class="primary" disabled=${busy}>${busy ? 'Connecting…' : me.value ? 'Add account' : 'Sign in'}</button>
      ${me.value && html`<button type="button" onClick=${() => (store.addingAccount.value = false)}>Cancel</button>`}
    </form>`;
  if (adding) return html`<main class="login">${form}</main>`;
  return html`<main class="login landing">
    <div class="landing-wrap">
      <div class="landing-head"><img src="icon.svg" width="28" height="28" alt="" /> nostr.chat</div>
      <section class="hero">
        <div class="pitch">
          <h1>Private chat without a phone number.</h1>
          <p class="lead">End-to-end encrypted messages and public rooms on Nostr. No sign-up, no account server, nothing to install. Your identity is a key you own.</p>
          <div class="pills"><span>🔒 End-to-end DMs</span><span># Public rooms</span><span>🪪 did:nostr</span></div>
          <div class="mock" aria-hidden="true">
            <div class="mock-head"><span class="avatar" style="background:#e8762b">A</span><span><b>Ada</b><small>✓ ada@nostr.chat</small></span></div>
            <div class="mock-day">Today</div>
            <div class="mock-msg theirs">gm 👋 is this really end-to-end?<time>09:41</time></div>
            <div class="mock-msg mine">Yes. Sealed and gift-wrapped, so not even relays can read it.<time>09:42 ✓</time></div>
            <div class="mock-msg theirs">And no phone number? 🤯<time>09:42</time></div>
            <div class="mock-msg mine">Just your key. Same identity in every Nostr app.<time>09:43 ✓</time></div>
          </div>
        </div>
        ${form}
      </section>
      <section class="features">
        <div><h3>Private by default.</h3><p>Messages are encrypted end to end and gift-wrapped (NIP-17), so relays see neither the text nor who is talking to whom.</p></div>
        <div><h3>No registration.</h3><p>Your identity is a key made in your browser, with a <a href="https://did-nostr.com" target="_blank" rel="noopener">did:nostr</a> address. Or sign in with a key you already have, an extension, or a remote signer.</p></div>
        <div><h3>Nothing to install.</h3><p>Open the link and you're in. Add it to your home screen on a phone. It is static files served from one place, with no third-party scripts.</p></div>
        <div><h3>Part of Nostr, not a silo.</h3><p>The same wire format as <a href="https://github.com/lnbits/anagram" target="_blank" rel="noopener">Anagram</a>; rooms are public Nostr groups and your profile is your Nostr profile. Optional Iris-compatible double ratchet.</p></div>
        <div><h3>Anything can reach you.</h3><p>People, scripts and devices can message your DID with a plain NIP-17 event. No platform account, no API key.</p></div>
        <div><h3>Choose your servers.</h3><p>Pick the relays that hold your inbox, including your own. Your identity stays yours when you switch.</p></div>
      </section>
      <section class="faq">
        <h2>Questions</h2>
        <details><summary>Is this Anagram?</summary><p>It is a lighter client for the same protocol. Chats and rooms work across both; Anagram is the fuller app from LNbits.</p></details>
        <details><summary>Where are my messages?</summary><p>Encrypted copies sit on the relays you choose; decrypted copies are cached in this browser only. There is no server of ours in the middle.</p></details>
        <details><summary>What about double ratchet?</summary><p>It adds Signal-style forward secrecy for chats with Iris users. Such chats reach every device you have registered, but a device added later does not receive earlier history. By default the app only checks whether the other person supports it (a lookup on relay.snort.social) and asks before turning it on; "Never" in Settings stops the lookups. Everyone else keeps standard NIP-17.</p></details>
        <details><summary>What leaves my device?</summary><p>Only what the <a href="privacy">Privacy page</a> lists: relay traffic, profile lookups on nostr.social, and files you choose to upload.</p></details>
      </section>
      <p class="landing-partners">Works with <a href="https://github.com/lnbits/anagram" target="_blank" rel="noopener">Anagram</a>, <a href="https://irischat.org" target="_blank" rel="noopener">Iris</a> and other Nostr apps. One key, one network, your choice of app.</p>
      <footer class="landing-foot">
        <span>nostr.chat is free software. Encrypted with NIP-44 and NIP-17 gift wrap; optional double ratchet over Nostr.</span>
        <nav>
          <a href="https://github.com/melvincarvalho/anagram" target="_blank" rel="noopener">Source</a>
          <a href="privacy">Privacy</a>
          <a href="security">Security</a>
          <a href="https://nostr.social" target="_blank" rel="noopener">nostr.social</a>
          <a href="https://did-nostr.com" target="_blank" rel="noopener">did:nostr</a>
        </nav>
      </footer>
    </div>
  </main>`;
}
