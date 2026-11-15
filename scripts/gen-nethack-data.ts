/**
 * Regenerates server/src/assistant/knowledge/lookup/nethack-5.0.json (the data behind the nethack_lookup tool) from a
 * clean NetHack 5.0.0 source tree; see lookup/build.ts for what is extracted. Needs a C preprocessor (`cpp`).
 *
 *   node scripts/gen-nethack-data.ts [path/to/nethack-src]      (default: $NETHACK_SRC_DIR or .cache/nethack-src)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLookupData, serializeLookupData } from '../server/src/assistant/knowledge/lookup/build.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] ?? process.env.NETHACK_SRC_DIR ?? path.join(ROOT, '.cache/nethack-src'));
const OUT = path.join(ROOT, 'server/src/assistant/knowledge/lookup/nethack-5.0.json');

const data = buildLookupData(SRC);
fs.writeFileSync(OUT, serializeLookupData(data));
const count = (k: string) => data.entries.filter((e) => e.kind === k).length;
console.log(
  `wrote ${path.relative(ROOT, OUT)}: ${count('monster')} monsters, ${count('object')} objects, ${count('artifact')} artifacts, ` +
    `${count('appearance')} appearances, ${count('role')} roles, ${count('race')} races`,
);
