// Runs the same test suite against a copy of the code with one control
// removed. Passes only if the suite goes red on the expected test.
// The working tree is never modified.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const mutants = JSON.parse(readFileSync('mutants/mutants.json', 'utf8'));
let survived = 0;
for (const m of mutants) {
  const dir = mkdtempSync(join(tmpdir(), `mutant-${m.id}-`));
  for (const p of ['src', 'test', 'package.json']) cpSync(p, join(dir, p), { recursive: true });
  const file = join(dir, m.file);
  const source = readFileSync(file, 'utf8');
  if (source.split(m.remove).length !== 2) {
    console.error(`mutant ${m.id}: the line to remove is not found exactly once in ${m.file}`);
    process.exit(2);
  }
  writeFileSync(file, source.replace(m.remove, ''));
  console.log(`mutant ${m.id}: ${m.what}`);
  console.log(`removed from ${m.file}:\n- ${m.remove.trim()}\n`);
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'test/*.test.ts'], { cwd: dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  const out = run.stdout + run.stderr;
  const failing = [...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((x) => x[1]);
  const unique = [...new Set(failing)];
  console.log(out.split('\n').filter((l) => /^\s*[✔✖]|^ℹ (tests|pass|fail)/.test(l)).join('\n'));
  const at = out.indexOf(`✖ ${m.expect}`, out.indexOf('failing tests:'));
  if (at >= 0) console.log('\nfailure of the expected test:\n' + out.slice(at, at + 700).split('\n').slice(0, 12).join('\n'));
  if (run.status !== 0 && unique.includes(m.expect)) {
    console.log(`\ncaught: "${m.expect}" fails without the control (${unique.length} failing test(s)).`);
  } else {
    console.log(`\nSURVIVED: the suite did not fail on "${m.expect}".`);
    survived++;
  }
}
process.exit(survived ? 1 : 0);
