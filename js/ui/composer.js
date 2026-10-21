// The composer: drafts, @mention chips, emoji, attachments, voice notes, editing and replies.
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, autosize, html, touchKeyboard, useAction } from './common.js';
import { MENTION_RE, previewText } from './text.js';
import { EmojiPanel } from './messages.js';
import { playSound } from './sounds.js';
const { me, profiles } = store;

// Voice notes: MediaRecorder on the microphone; the browser picks the container
// (audio/webm;codecs=opus in Chrome/Firefox, audio/mp4 in Safari). Stopping resolves
// with the recorded file, or null when cancelled or too short.
const VOICE_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const state = useRef(null); // { recorder, chunks, stream, startedAt, timer, done }
  const cleanup = () => {
    const s = state.current;
    if (!s) return;
    clearInterval(s.timer);
    s.stream.getTracks().forEach((t) => t.stop());
    state.current = null;
    setRecording(false);
    setSeconds(0);
  };
  const start = async () => {
    if (state.current || typeof MediaRecorder === 'undefined') return false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = VOICE_MIME.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const s = { recorder, chunks: [], stream, startedAt: Date.now(), timer: 0, done: null };
    recorder.ondataavailable = (e) => e.data.size && s.chunks.push(e.data);
    recorder.onstop = () => {
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0];
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const file = new File(s.chunks, `voice-${new Date(s.startedAt).toISOString().replace(/[:.]/g, '-')}.${ext}`, { type });
      const long = Date.now() - s.startedAt >= 700 && file.size > 0;
      s.done?.(long ? file : null);
      cleanup();
    };
    s.timer = setInterval(() => setSeconds(Math.floor((Date.now() - s.startedAt) / 1000)), 250);
    state.current = s;
    recorder.start(250);
    setRecording(true);
    return true;
  };
  const stop = ({ cancel = false } = {}) =>
    new Promise((resolve) => {
      const s = state.current;
      if (!s) return resolve(null);
      s.done = cancel ? () => resolve(null) : resolve;
      // If the recorder never reports stopping (seen with dead audio sources), settle anyway.
      const fallback = setTimeout(() => state.current === s && s.recorder.onstop(), 3000);
      const finish = s.recorder.onstop;
      s.recorder.onstop = () => {
        clearTimeout(fallback);
        s.recorder.onstop = () => {};
        finish();
      };
      s.recorder.state === 'inactive' ? s.recorder.onstop() : s.recorder.stop();
    });
  useEffect(() => () => state.current && stop({ cancel: true }), []);
  return { recording, seconds, start, stop };
}

const canRecordVoice = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

// maxLength: a hard cap on the wire text (UTF-16 code units), shown as a counter when near.
export function Composer({ onSend, placeholder, replyTo, onCancelReply, editing, onEdit, onCancelEdit, draftKey, canUpload = true, mentionables = [], maxLength = 0 }) {
  const [text, setTextState] = useState(() => store.drafts.value[draftKey] ?? '');
  // Keep the per-chat draft in step with what is typed (not while editing a sent message).
  // Drafts reach the store after a pause in typing, so each keystroke doesn't re-render the sidebar.
  const draftTimer = useRef();
  const pendingDraft = useRef(null);
  // Resize whenever the text changes from code too (send clears it, drafts restore it);
  // field-sizing handles this natively where supported.
  useEffect(() => autosize(input.current), [text]);
  const setText = (value) => {
    setTextState(value);
    if (editing) return;
    pendingDraft.current = value;
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      store.setDraft(draftKey, value);
      pendingDraft.current = null;
    }, 400);
  };
  useEffect(
    () => () => {
      clearTimeout(draftTimer.current);
      if (pendingDraft.current !== null) store.setDraft(draftKey, pendingDraft.current);
    },
    [draftKey],
  );
  const input = useRef();
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (editing) setText(collapseMentions(editing.content));
    if (editing || replyTo) input.current?.focus();
  }, [editing?.id, replyTo?.id]);
  const cancel = () => {
    if (editing) {
      onCancelEdit();
      setTextState(store.drafts.value[draftKey] ?? '');
    } else onCancelReply?.();
  };
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    const wire = expandMentions(value); // @Name -> nostr:nprofile… (Anagram's mention format)
    if (editing && wire === editing.content.trim()) return cancel();
    if (maxLength && wire.length > maxLength)
      return store.notify(`Too long: ${wire.length.toLocaleString()} of ${maxLength.toLocaleString()} characters (mentions count in full).`);
    // Clear at once like Telegram; put the text back if sending fails outright.
    // After an edit, bring back whatever draft was there before.
    if (editing) setTextState(store.drafts.value[draftKey] ?? '');
    else setText('');
    run(async () => {
      try {
        await (editing ? onEdit(editing, wire) : onSend(wire, attachmentsFor(value)));
        if (!editing) playSound('sent');
      } catch (e) {
        setText(value);
        throw e;
      }
    });
  };
  const context = editing ?? replyTo;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Uploaded media: url -> imeta tag. Like Anagram, the URL goes into the text and only
  // URLs still present when sending become attachments.
  const uploads = useRef(new Map());
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef();
  const textRef = useRef(text);
  textRef.current = text;
  const upload = async (files) => {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    if (!canUpload) return store.notify('Only trusted members can post media in this room.');
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const tag = await store.uploadMedia(file);
        const url = tag[1].slice(4);
        uploads.current.set(url, tag);
        const current = textRef.current;
        setText(current + (current && !current.endsWith('\n') ? '\n' : '') + url);
      } catch (e) {
        store.notify(`Upload failed: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    input.current?.focus();
  };
  const voice = useRecorder();
  const startVoice = async () => {
    if (!canUpload) return store.notify('Only trusted members can post media in this room.');
    try {
      await voice.start();
    } catch (e) {
      store.notify(e.name === 'NotAllowedError' ? 'Microphone access was refused.' : `Could not record: ${e.message}`);
    }
  };
  // Stop, upload and send as a media message: the URL is the text, the imeta tag the attachment.
  const sendVoice = () =>
    run(async () => {
      const file = await voice.stop();
      if (!file) return store.notify('Voice note too short.');
      setUploading((n) => n + 1);
      try {
        const tag = await store.uploadMedia(file);
        await onSend(tag[1].slice(4), [tag]);
        playSound('sent');
      } catch (e) {
        store.notify(`Voice note failed: ${e.message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    });
  const attachmentsFor = (value) => {
    const tokens = new Set(value.split(/\s+/));
    return [...uploads.current].filter(([url]) => tokens.has(url)).map(([, tag]) => tag);
  };
  // @mention autocomplete: "@query" right before the caret suggests people in this chat.
  const [mention, setMention] = useState(null); // { start, query, index }
  const updateMention = (el) => {
    const before = el.value.slice(0, el.selectionStart);
    const m = /(^|\s)@([\p{L}\p{N}_.\-]{0,30})$/u.exec(before);
    setMention(m ? { start: before.length - m[2].length - 1, query: m[2].toLowerCase(), index: 0 } : null);
  };
  const candidates = mention
    ? nostr
        .uniq([...mentionables, ...store.contacts.value])
        .filter((pk) => pk !== me.value.pubkey && store.displayName(pk).toLowerCase().includes(mention.query))
        .slice(0, 6)
    : [];
  // The composer shows @Name; the wire format (nostr:nprofile…) is produced on send.
  const mentionMap = useRef(new Map()); // '@Name' -> pubkey
  const labelFor = (pk) => `@${store.displayName(pk).replace(/\s+/g, ' ').trim()}`;
  const expandMentions = (value) => {
    let out = value;
    for (const [label, pk] of [...mentionMap.current].sort((a, b) => b[0].length - a[0].length)) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}_])`, 'gu');
      out = out.replace(re, (_, before) => `${before}${nostr.mentionUri(pk)}`);
    }
    return out;
  };
  const collapseMentions = (value) =>
    value.replace(MENTION_RE, (m) => {
      const pk = nostr.decodePubkey(m);
      if (!pk) return m;
      const label = labelFor(pk);
      mentionMap.current.set(label, pk);
      return label;
    });
  const pickMention = (pk) => {
    const el = input.current;
    const end = el.selectionStart;
    const label = labelFor(pk);
    mentionMap.current.set(label, pk);
    const uri = `${label} `;
    setText(text.slice(0, mention.start) + uri + text.slice(end));
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(mention.start + uri.length, mention.start + uri.length);
    });
  };

  const insert = (e) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + e + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + e.length, start + e.length);
    });
  };
  return html`<footer
    class=${`composer${dragging ? ' dragging' : ''}`}
    onDragOver=${(e) => {
      if (!editing && e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        setDragging(true);
      }
    }}
    onDragLeave=${() => setDragging(false)}
    onDrop=${(e) => {
      setDragging(false);
      if (e.dataTransfer?.files?.length && !editing) {
        e.preventDefault();
        upload(e.dataTransfer.files);
      }
    }}
  >
    ${uploading > 0 && html`<div class="uploading">Uploading ${uploading} file${uploading > 1 ? 's' : ''} to ${new URL(store.mediaServer.value).host}…</div>`}
    ${emojiOpen && html`<${EmojiPanel} onPick=${insert} onClose=${() => setEmojiOpen(false)} />`}
    ${candidates.length > 0 &&
    html`<div class="mentions-popup" role="listbox">
      ${candidates.map(
        (pk, i) => html`<button role="option" aria-selected=${i === mention.index} class=${i === mention.index ? 'on' : ''}
          onMouseDown=${(e) => {
            e.preventDefault();
            pickMention(pk);
          }}>
          <${Avatar} pubkey=${pk} size=${28} /><span><b>${store.displayName(pk)}</b> <small>${profiles.value[pk]?.nip05 || ''}</small></span>
        </button>`,
      )}
    </div>`}
    ${context &&
    html`<div class="replying">
      <span class="what">${editing ? '✎ Edit message' : `↩ Reply to ${store.displayName(replyTo.pubkey)}`}</span>
      <span class="snippet">${previewText(context.content).slice(0, 80)}</span>
      <button class="link" title="Cancel" onClick=${cancel}>✕</button>
    </div>`}
    ${error && html`<p class="error">${error}</p>`}
    <div class="row">
      <button class="icon emoji-toggle" title="Emoji" aria-label="Emoji" onClick=${() => setEmojiOpen(!emojiOpen)}>🙂</button>
      ${!editing &&
      html`<button class="icon" title="Attach photo, video or audio" aria-label="Attach file" disabled=${uploading > 0} onClick=${() => fileInput.current.click()}>
          ${uploading ? '⏳' : '📎'}
        </button>
        <input ref=${fileInput} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange=${(e) => {
          upload(e.target.files);
          e.target.value = '';
        }} />`}
      <textarea
        ref=${input}
        aria-label=${placeholder}
        rows="1"
        placeholder=${placeholder}
        value=${text}
        onInput=${(e) => {
          setText(e.target.value);
          autosize(e.target);
          updateMention(e.target);
        }}
        onBlur=${() => setTimeout(() => setMention(null), 150)}
        onPaste=${(e) => {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length && !editing) {
            e.preventDefault();
            upload(files);
          }
        }}
        onKeyDown=${(e) => {
          if (candidates.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              return setMention({ ...mention, index: (mention.index + step + candidates.length) % candidates.length });
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              return pickMention(candidates[mention.index] ?? candidates[0]);
            }
            if (e.key === 'Escape') return setMention(null);
          }
          // On touch keyboards Enter makes a new line (like Telegram mobile); send with the button.
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchKeyboard) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape' && context) cancel();
          else if (e.key === 'ArrowUp' && !text && onEdit) onEdit(null);
        }}
      />
      ${maxLength > 0 && text.length > maxLength - 500 &&
      html`<span class=${`count${text.length > maxLength ? ' over' : ''}`} aria-live="polite">${text.length.toLocaleString()}/${maxLength.toLocaleString()}</span>`}
      ${!editing && !text.trim() && canRecordVoice()
        ? html`<button class="primary mic" disabled=${busy || voice.recording} title="Record a voice note" aria-label="Record a voice note" onClick=${startVoice}>
            ${busy ? '…' : '🎤'}
          </button>`
        : html`<button class="primary" disabled=${busy || !text.trim()} onClick=${send}>${busy ? '…' : editing ? 'Save' : 'Send'}</button>`}
    </div>
    ${voice.recording &&
    html`<div class="recording" role="status">
      <span class="rec-dot" aria-hidden="true" /> Recording ${String(Math.floor(voice.seconds / 60))}:${String(voice.seconds % 60).padStart(2, '0')}
      <button class="link" onClick=${() => voice.stop({ cancel: true })}>Cancel</button>
      <button class="primary" onClick=${sendVoice}>Send</button>
    </div>`}
  </footer>`;
}
