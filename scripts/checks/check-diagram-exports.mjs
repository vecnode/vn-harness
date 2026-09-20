// Drift check for docs/diagrams/: compares the committed exports against the
// diagrams actually stored in $DSH_HOME/dsh-diagrams/library.json.
//
//   node scripts/checks/check-diagram-exports.mjs
//
// Exit 0 when every exported file matches the stored source byte for byte (or
// when the library is absent, which is normal on a machine that has never
// opened a diagram). Exit 1 when an export has drifted.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const exportDir = join(repo, 'docs', 'diagrams');

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const libPath = join(dshHome, 'dsh-diagrams', 'library.json');

const FILES = [
  ['jepa-model', 'mermaid', 'jepa-model.mmd'],
  ['jepa-model-tikz', 'tikz', 'jepa-model-tikz.tex'],
];

if (!existsSync(libPath)) {
  console.log(`skip: no diagram library at ${libPath} (nothing exported on this machine)`);
  process.exit(0);
}

let lib;
try {
  lib = JSON.parse(readFileSync(libPath, 'utf8'));
} catch (err) {
  console.error(`skip: could not read ${libPath}: ${err.message}`);
  process.exit(0);
}

// The exports are pinned to LF in .gitattributes, but a checkout that predates
// that rule (or a hand-edited file) can still carry CRLF; the stored source
// never does, so compare on normalised line endings and report that instead of
// a phantom drift.
const normalize = (text) => text.replace(/\r\n/g, '\n');

let bad = 0;
for (const [id, kind, file] of FILES) {
  const stored = lib.diagrams?.[id];
  const target = join(exportDir, file);
  if (!stored) {
    console.log(`MISSING  ${id}: not in the library`);
    bad++;
    continue;
  }
  if (stored.kind !== kind) {
    console.log(`KIND     ${id}: library says ${stored.kind}, export expects ${kind}`);
    bad++;
    continue;
  }
  if (!existsSync(target)) {
    console.log(`MISSING  ${file}: not in docs/diagrams/`);
    bad++;
    continue;
  }
  const onDisk = readFileSync(target, 'utf8');
  if (normalize(onDisk) === normalize(stored.source)) {
    console.log(`ok       ${file}  (library ${id} rev ${stored.revision}, ${Buffer.byteLength(onDisk, 'utf8')} bytes)`);
  } else {
    console.log(`DRIFT    ${file}  (library ${id} rev ${stored.revision}) - re-export the source from the tool`);
    bad++;
  }
}

if (bad > 0) {
  console.error(`\n${bad} exported diagram file(s) out of date.`);
  process.exit(1);
}
console.log('\nAll exported diagrams match the library.');
