# Vendored libraries

Pinned ES module builds from esm.sh, checked in so the app runs no third-party
code at runtime (CSP `script-src 'self'`). No build step: these are plain files.

| File | Source |
|---|---|
| preact.mjs | https://esm.sh/preact@10.24.3/es2022/preact.mjs |
| hooks.mjs | https://esm.sh/preact@10.24.3/es2022/hooks.mjs |
| signals.mjs | https://esm.sh/@preact/signals@1.3.0/X-ZXByZWFjdA/es2022/signals.mjs (signals-core import rewritten to `./signals-core.mjs`) |
| signals-core.mjs | https://esm.sh/@preact/signals-core@1.14.4/es2022/signals-core.mjs |
| htm.mjs | https://esm.sh/htm@3.1.1/es2022/htm.mjs |
| nostr-tools.mjs | https://esm.sh/nostr-tools@2.25.2/es2022/nostr-tools.bundle.mjs |
| nip46.mjs | https://esm.sh/nostr-tools@2.25.2/es2022/nip46.bundle.mjs |

`SHA256SUMS` records the checked-in contents (`sha256sum -c SHA256SUMS`). To upgrade,
download the new URLs over these files, re-apply the signals-core rewrite, update the
table and regenerate the sums.
