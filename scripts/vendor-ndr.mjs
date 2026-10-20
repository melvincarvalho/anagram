// The website stays build-free. Run only when updating the optional NDR vendor file.
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await build({
  stdin: { contents: "export { NdrRuntime, createPersistentNostrOutbox, buildAppKeysFilter, AppKeys } from 'nostr-double-ratchet';", resolveDir: process.cwd() },
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'vendor/nostr-double-ratchet.mjs',
  legalComments: 'external',
});
const filename = 'nostr-double-ratchet.mjs';
const hash = createHash('sha256').update(await readFile(`vendor/${filename}`)).digest('hex');
const sums = (await readFile('vendor/SHA256SUMS', 'utf8')).split('\n').filter((line) => line && !line.endsWith(`  ${filename}`));
await writeFile('vendor/SHA256SUMS', `${[...sums, `${hash}  ${filename}`].join('\n')}\n`);
