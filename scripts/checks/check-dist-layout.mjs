// check-dist-layout.mjs - the DISTRIBUTION feature's own tracked check.
//
// Why this exists: a distribution is a COPY of this repository produced by two
// independent halves (scripts/dist.ps1 on Windows, scripts/dist.sh everywhere
// else), and the failure mode that matters is the quiet one - a bundle added
// under packages/ that the ship list does not carry, a skip rule that lets 200 MB
// of build inputs into the archive, or one half learning a flag the other never
// heard of. None of that needs a build to detect, so none of it needs a runner
// either: this is Node only, identical on every platform, and it says what it
// checked.
//
// Run:  node scripts/checks/check-dist-layout.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
const failures = []
const notes = []

function fail(message) { failures.push(message) }
function note(message) { notes.push(message) }

/**
 * A file's lines with its comments removed.
 *
 * Several checks below are about what a launcher DOES, and these files document
 * themselves heavily - install.sh says "NOT PowerShell, ever" and theme.sh's own
 * header names the bashisms it must avoid. Testing the raw text would fail every
 * one of them on its own explanation, so the checks that are about behaviour read
 * the code with `#`, `rem` and `::` lines dropped.
 */
function code(text) {
  return text.split(/\r?\n/).filter((line) => !/^\s*(#|rem\b|::)/i.test(line)).join('\n')
}

function read(relative) {
  const file = path.join(repo, relative)
  if (!existsSync(file)) {
    fail(`${relative} is missing.`)
    return null
  }
  return readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------------------
// 1. The ship list, and the two halves that read it
// ---------------------------------------------------------------------------
const manifest = read('scripts/dist-manifest.txt')
const ps = read('scripts/dist.ps1')
const sh = read('scripts/dist.sh')
const bat = read('distribute.bat')
const distributeSh = read('distribute.sh')
const gitignore = read('.gitignore')

/** The manifest's rules, as { kind, path }. */
function parseManifest(text) {
  const rules = []
  for (const line of text.split(/\r?\n/)) {
    const text2 = line.trim()
    if (!text2 || text2.startsWith('#')) continue
    const match = /^(include|skipdir|skippath|skipfile)\s+(\S+)$/.exec(text2)
    if (!match) {
      fail(`dist-manifest.txt: cannot read the rule '${text2}'.`)
      continue
    }
    rules.push({ kind: match[1], path: match[2] })
  }
  return rules
}

if (manifest) {
  const rules = parseManifest(manifest)
  const includes = rules.filter((rule) => rule.kind === 'include').map((rule) => rule.path)
  const skipdirs = rules.filter((rule) => rule.kind === 'skipdir').map((rule) => rule.path)

  // Everything the application needs to RUN, or the folder is not a distribution.
  for (const required of ['packages', '.dsh-version.json', 'scripts', 'README.md', 'LICENSE', 'docs']) {
    if (!includes.includes(required)) fail(`dist-manifest.txt does not ship '${required}'.`)
  }

  // node_modules is 200 MB of build INPUTS for artifacts that are already
  // committed under lib/vendor/ - losing this rule multiplies the archive by
  // twenty. target/ is the shell's Rust build tree. Both are load-bearing.
  for (const required of ['node_modules', 'target', 'gen', 'dist']) {
    if (!skipdirs.includes(required)) fail(`dist-manifest.txt lost its 'skipdir ${required}' rule.`)
  }

  // No rule may reach outside the repository.
  for (const rule of rules) {
    if (rule.path.includes('..')) fail(`dist-manifest.txt: '${rule.path}' reaches outside the repository.`)
  }

  // --- every registered bundle must be carried by an include -----------------
  // A package is a bundle when its package.json declares dsh.bundle. Anything
  // under packages/ that is a bundle and is NOT under an included tree would be
  // silently missing from every distribution.
  let packages = []
  try {
    packages = readdirSync(path.join(repo, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch { fail('packages/ cannot be read.') }

  const bundles = []
  for (const name of packages) {
    const manifestPath = path.join(repo, 'packages', name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let json = null
    try { json = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { }
    if (json && json.dsh && json.dsh.bundle) bundles.push({ name, dir: `packages/${name}` })
  }
  if (bundles.length === 0) fail('No bundle found under packages/ (a package.json with dsh.bundle).')
  for (const bundle of bundles) {
    const covered = includes.some((include) => include === 'packages' || bundle.dir === include || bundle.dir.startsWith(`${include}/`))
    if (!covered) fail(`The bundle '${bundle.name}' (${bundle.dir}) is not under any include rule - it would not ship.`)
  }

  // --- every bundle in the pin manifest must exist as a package -------------
  // .dsh-version.json is the pack's own registry of what it contains; a bundle
  // listed there but missing from packages/ means the manifest is stale.
  const pinText = read('.dsh-version.json')
  if (pinText) {
    let pin = null
    try { pin = JSON.parse(pinText) } catch { fail('.dsh-version.json does not parse.') }
    if (pin && pin.packages) {
      for (const name of Object.keys(pin.packages)) {
        if (!bundles.some((bundle) => bundle.name === name)) {
          fail(`.dsh-version.json lists '${name}', which is not an installed bundle under packages/.`)
        }
      }
    }
    if (pin && !pin.dsh) fail('.dsh-version.json has no "dsh" pin - the shell has no fallback for it.')
  }

  note(`${bundles.length} bundles, ${includes.length} include rules, ${rules.length - includes.length} skip rules`)
}

// ---------------------------------------------------------------------------
// 2. The two halves must not drift
// ---------------------------------------------------------------------------
if (ps && sh) {
  // Both read the ONE ship list rather than carrying their own.
  for (const [name, text] of [['scripts/dist.ps1', ps], ['scripts/dist.sh', sh]]) {
    if (!text.includes('dist-manifest.txt')) fail(`${name} does not read scripts/dist-manifest.txt.`)
  }

  // The same flags, both halves. A flag only one half knows is a run that fails
  // on half the matrix.
  const flags = ['-Version', '-SkipBuild', '-NoZip', '-Run', '-Verify', '-KeepVerifyHome', '-Clean', '-NoPause', '-Help']
  for (const flag of flags) {
    if (!ps.includes(flag)) fail(`scripts/dist.ps1 does not handle ${flag}.`)
    if (!sh.includes(flag)) fail(`scripts/dist.sh does not handle ${flag}.`)
  }

  // The same files generated for the distribution.
  for (const generated of ['START-HERE', 'DIST-README.txt', 'BUILD-INFO.json', 'SHA256SUMS.txt']) {
    if (!ps.includes(generated)) fail(`scripts/dist.ps1 never generates ${generated}.`)
    if (!sh.includes(generated)) fail(`scripts/dist.sh never generates ${generated}.`)
  }

  // The sentinel list - one entry per shipped family, the guard that catches a
  // copy that flattened or nested a tree - must be the SAME list in both halves.
  const sentinelsOf = (text) => new Set(
    text.match(/(?:^|[\s'"])(?:\.dsh-version\.json|app\/[^\s'"]+|assets\/[^\s'"]+|docs\/[^\s'"]+|packages\/[^\s'"]+|scripts\/[^\s'"]+)/gm)
      ?.map((value) => value.trim().replace(/^['"]/, '')) ?? [],
  )
  const psSentinels = sentinelsOf(ps)
  const shSentinels = sentinelsOf(sh)
  const wanted = [
    'packages/dsh-vn-master/package.json',
    'packages/dsh-pdf/lib/vendor/pdf.min.mjs',
    'packages/dsh-diagrams/lib/vendor/mermaid.min.js',
    'packages/dsh-editor/lib/vendor/cm6.min.js',
    'packages/dsh-terminal/lib/vendor/xterm.js',
    'app/src-tauri/src/main.rs',
    'assets/vn-harness.svg',
  ]
  for (const sentinel of wanted) {
    if (!psSentinels.has(sentinel)) fail(`scripts/dist.ps1 does not check the sentinel '${sentinel}'.`)
    if (!shSentinels.has(sentinel)) fail(`scripts/dist.sh does not check the sentinel '${sentinel}'.`)
  }

  // The launch token is a live credential: both halves must redact it in
  // anything they print from the ready line, and neither may echo the raw line.
  for (const [name, text] of [['scripts/dist.ps1', ps], ['scripts/dist.sh', sh]]) {
    if (!/token=REDACTED/.test(text)) fail(`${name} does not redact the launch token.`)
  }
  if (!/Test-LoopbackUrl|127\.0\.0\.1:\*/.test(ps) || !/loopback/.test(sh)) {
    fail('A distribution half does not refuse a ready line that is not a loopback address.')
  }
}

// ---------------------------------------------------------------------------
// 3. The entry points, and the rule that keeps dist/ out of GitHub
// ---------------------------------------------------------------------------
if (bat) {
  // Batch only, so Windows asks no execution-policy question before starting,
  // and it must forward to the same worker the workflow calls.
  if (!/scripts\\dist\.ps1/.test(bat)) fail('distribute.bat does not call scripts\\dist.ps1.')
  if (/^\s*(pwsh|powershell)\s+-Command/m.test(bat)) fail('distribute.bat runs PowerShell inline instead of a file.')
}
if (distributeSh && !/scripts\/dist\.sh/.test(distributeSh)) {
  fail('distribute.sh does not call scripts/dist.sh.')
}

if (gitignore && !/^dist\/?$/m.test(gitignore)) {
  fail('.gitignore does not ignore dist/ - the distribution must never be committed.')
}

// ---------------------------------------------------------------------------
// 4. The workflow: one matrix, the same scripts, three operating systems
// ---------------------------------------------------------------------------
const workflow = read('.github/workflows/distribute.yml')
if (workflow) {
  // The matrix's own `os:` values, and nothing else. The comments above the
  // matrix name the retired labels on purpose - to record why they left - so a
  // plain text search over the file would fail on its own explanation.
  const matrixOs = [...workflow.matchAll(/^\s*-\s+os:\s*(\S+)\s*$/gm)].map((match) => match[1])
  if (matrixOs.length === 0) fail('.github/workflows/distribute.yml has no readable matrix of `- os:` entries.')

  // The labels a build MUST have. These are the images GitHub publishes today;
  // `macos-13` used to be here and was retired, which is the failure this list
  // exists to catch - a label that no longer resolves fails the whole run at
  // scheduling time, before any step can report why.
  for (const runner of ['windows-2022', 'macos-15-intel', 'macos-15', 'ubuntu-22.04']) {
    if (!matrixOs.includes(runner)) fail(`.github/workflows/distribute.yml does not build on ${runner}.`)
  }

  // ...and the labels it must NOT have, because GitHub has retired them. Naming
  // a dead image is not a style question: the run never starts.
  for (const retired of ['macos-13', 'macos-12', 'macos-11', 'windows-2019', 'ubuntu-20.04']) {
    if (matrixOs.includes(retired)) {
      fail(`.github/workflows/distribute.yml builds on '${retired}', a retired runner image.`)
    }
  }

  // The ARM64 legs exist to produce artifacts no other leg can, and they are
  // allowed to fail while their toolchains settle - but they must be MARKED as
  // allowed to, or a preview-image surprise blocks a release.
  if (!workflow.includes('windows-11-arm') || !workflow.includes('ubuntu-22.04-arm')) {
    note('the ARM64 legs (windows-11-arm / ubuntu-22.04-arm) are not in the matrix')
  } else if (!/continue-on-error:\s*\$\{\{\s*matrix\.experimental/.test(workflow) || !workflow.includes('experimental: true')) {
    fail('.github/workflows/distribute.yml has ARM64 legs but does not mark them experimental / continue-on-error.')
  }

  for (const script of ['scripts/dist.ps1', 'scripts/dist.sh']) {
    if (!workflow.includes(script)) fail(`.github/workflows/distribute.yml never runs ${script}.`)
  }
  // The end-to-end check the local run also makes.
  if (!workflow.includes('-Verify')) fail('.github/workflows/distribute.yml does not run the end-to-end verify.')
  // Artifacts always; the workflow_dispatch trigger is how a run is inspected
  // without pushing a tag.
  if (!workflow.includes('workflow_dispatch')) fail('.github/workflows/distribute.yml has no workflow_dispatch trigger.')
  if (!workflow.includes('upload-artifact')) fail('.github/workflows/distribute.yml uploads no artifacts.')

  // --- every entry point that ships must be able to trigger a rebuild --------
  // The push filter is a list of paths, and a file missing from it means a change
  // to it builds nothing - silent, and only visible as a stale artifact later.
  // The list is read from the workflow's own `paths:` block, not re-typed.
  const pathsBlock = /^\s*paths:\s*\n((?:\s*-\s*'[^']+'\s*\n)+)/m.exec(workflow)
  const watched = pathsBlock
    ? pathsBlock[1].split(/\r?\n/).map((line) => /-\s*'([^']+)'/.exec(line)?.[1]).filter(Boolean)
    : []
  if (watched.length === 0) fail('.github/workflows/distribute.yml has no readable paths: filter.')
  // Every root entry point is named individually in that filter, and each has to
  // be there; `scripts/**` covers the console helpers and the workers.
  for (const entry of ['install.bat', 'install.sh', 'uninstall.bat', 'uninstall.sh',
    'run-web.bat', 'run-web.sh', 'run-desktop.bat', 'distribute.bat', 'distribute.sh']) {
    if (!watched.includes(entry)) {
      fail(`.github/workflows/distribute.yml's paths: filter does not watch '${entry}' - a change to it would build nothing.`)
    }
  }
}

// ---------------------------------------------------------------------------
// 5. The console contract: one shared layer, five entry points, two hosts
// ---------------------------------------------------------------------------
// The entry points are the only files a person double-clicks, and the failure
// mode this section exists for is drift: a sixth launcher, or an edit to one of
// the five, that quietly stops asking the shared layer how to behave and starts
// deciding for itself. Everything below is a property that must hold in EVERY
// entry point, so it is asserted in a loop rather than five times by hand.
const consoleFiles = {
  adapt: 'scripts/console/adapt.cmd',
  themePs: 'scripts/console/theme.ps1',
  themeSh: 'scripts/console/theme.sh',
}
const consoleText = {}
for (const [key, file] of Object.entries(consoleFiles)) {
  consoleText[key] = read(file)
  if (consoleText[key] !== null && consoleText[key].trim().length === 0) fail(`${file} is empty.`)
}

const windowsEntries = ['install.bat', 'uninstall.bat', 'run-web.bat', 'run-desktop.bat', 'distribute.bat']
const posixEntries = ['install.sh', 'uninstall.sh', 'run-web.sh', 'distribute.sh']

for (const entry of windowsEntries) {
  const text = read(entry)
  if (text === null) continue

  // It must consult the shared layer...
  if (!text.includes('scripts\\console\\adapt.cmd')) {
    fail(`${entry} does not call scripts\\console\\adapt.cmd - its console behaviour is its own.`)
  }

  // ...using the documentation's exact three lines, in order.
  if (!/if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%\*"/.test(text)) {
    fail(`${entry} is missing the 'if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"' guard.`)
  }

  // The guard exists for ONE reason: after the Windows Terminal relaunch `%*` is
  // only the --from-terminal marker, so anything that forwards `%*` a second
  // time would replace the caller's real flags with it. Exactly one occurrence
  // of `%*` is therefore allowed, and it is the guard's.
  const stars = text.split('%*').length - 1
  if (stars !== 1) {
    fail(`${entry} mentions %* ${stars} times; only the VN_HARNESS_ARGV guard may, or the relaunched run loses its flags.`)
  }

  // Flags are forwarded from VN_HARNESS_ARGS, which is what the guard protects.
  if (!text.includes('%VN_HARNESS_ARGS%')) {
    fail(`${entry} never forwards %VN_HARNESS_ARGS% - it cannot be passing the real flags.`)
  }

  // The pause is a WINDOW decision owned by the shared layer.
  if (!/%VN_HARNESS_PAUSE%/.test(text)) {
    fail(`${entry} ignores VN_HARNESS_PAUSE - it would hold a scripted run open.`)
  }

  // The preflight failure the shared layer reports must be handled, not ignored.
  if (!/errorlevel 2/.test(text)) {
    fail(`${entry} does not handle adapt.cmd's exit 2 (no PowerShell on this machine).`)
  }
  if (!/errorlevel 10/.test(text)) {
    fail(`${entry} does not handle adapt.cmd's exit 10 (a Windows Terminal window owns the run).`)
  }

  // Every one of them answers help, whether by routing to a worker (-Help) or by
  // owning the text itself (run-desktop.bat, which has no worker).
  if (!/-Help/.test(text)) fail(`${entry} never mentions -Help.`)
}

for (const entry of posixEntries) {
  const text = read(entry)
  if (text === null) continue
  if (!text.includes('console/theme.sh')) {
    fail(`${entry} does not source scripts/console/theme.sh - its colour policy is its own.`)
  }
  // The POSIX half must never reach for PowerShell: that is a standing rule, and
  // it is about what the script RUNS, not about what its comments explain.
  if (/powershell|pwsh/i.test(code(text))) {
    fail(`${entry} runs PowerShell; the macOS/Linux half must never require it.`)
  }
}

// The sh workers must ACCEPT the entry points' flags. An unknown option is a
// hard error in all of them (exit 2), so a flag the entry forwards and the
// worker has never heard of breaks the run rather than being ignored.
for (const worker of ['scripts/install-all.sh', 'scripts/uninstall-all.sh', 'scripts/dist.sh']) {
  const text = read(worker)
  if (text === null) continue
  for (const flag of ['-Help', '-NoPause']) {
    if (!text.includes(flag)) fail(`${worker} does not accept ${flag}, which its entry point can forward.`)
  }
}

// adapt.cmd MUST NOT use setlocal: its whole job is to leave VN_HARNESS_PS,
// VN_HARNESS_ARGS and VN_HARNESS_PAUSE set for the caller, and setlocal would
// discard all three on return.
if (consoleText.adapt) {
  if (/^\s*setlocal\b/im.test(consoleText.adapt)) {
    fail('scripts/console/adapt.cmd uses setlocal - its decisions would vanish on return.')
  }
  // The relaunch marker is what stops an infinite window-opening loop.
  if (!consoleText.adapt.includes('VN_HARNESS_CONSOLE')) {
    fail('scripts/console/adapt.cmd has no VN_HARNESS_CONSOLE marker - the relaunch could loop.')
  }
  // A failed wt.exe must fall back to this console rather than losing the run.
  if (!/fellthrough|continuing in this window/i.test(consoleText.adapt)) {
    fail('scripts/console/adapt.cmd does not fall back when wt.exe fails to launch.')
  }
}

// theme.sh is sourced by scripts that run under dash and macOS sh, so bashisms
// are defects: `[[ ]]`, `function`, arrays and `local` outside a function would
// work on the machine of whoever wrote them and fail on somebody else's.
if (consoleText.themeSh) {
  const shCode = code(consoleText.themeSh)
  for (const [pattern, what] of [[/\[\[/, '[[ ]]'], [/^\s*function\s/m, 'the `function` keyword'], [/\$\{?[A-Za-z_]+\[@\]/, 'an array']]) {
    if (pattern.test(shCode)) fail(`scripts/console/theme.sh uses ${what}, which is not POSIX sh.`)
  }
}

// A root entry point that exists but does not ship is a launcher nobody gets -
// and one that SHIPS but should not is the factory landing inside the product.
if (manifest) {
  const rules = parseManifest(manifest)
  const shipped = rules.filter((rule) => rule.kind === 'include').map((rule) => rule.path)
  const skippedPaths = rules.filter((rule) => rule.kind === 'skippath').map((rule) => rule.path)

  for (const entry of [...windowsEntries, ...posixEntries]) {
    // The distributer is deliberately NOT shipped: it builds distributions, and
    // a distribution is the product, not the workshop.
    if (entry === 'distribute.bat' || entry === 'distribute.sh') continue
    if (existsSync(path.join(repo, entry)) && !shipped.includes(entry)) {
      fail(`dist-manifest.txt does not ship '${entry}' - the folder would have no ${entry}.`)
    }
  }

  // ...and the exclusion must be explicit, because `include scripts` would
  // otherwise sweep scripts/dist.ps1 and scripts/dist.sh into every archive.
  for (const tool of ['scripts/dist.ps1', 'scripts/dist.sh']) {
    if (!skippedPaths.includes(tool)) {
      fail(`dist-manifest.txt does not exclude '${tool}' - the distributer would ship inside its own output.`)
    }
  }

  // scripts/console rides on `include scripts`; losing that include would take
  // the shared layer out from under every shipped launcher.
  if (!shipped.includes('scripts')) {
    fail('dist-manifest.txt does not ship scripts/ - the console layer and workers would be missing.')
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log('check-dist-layout: the ship list, the two halves, the entry points and the workflow')
for (const line of notes) console.log(`  - ${line}`)
if (failures.length > 0) {
  console.log('')
  for (const line of failures) console.log(`FAIL ${line}`)
  console.log(`\ncheck-dist-layout: ${failures.length} problem(s).`)
  process.exit(1)
}
console.log('\ncheck-dist-layout: OK')
