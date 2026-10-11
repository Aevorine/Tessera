#!/usr/bin/env node
// Generates the third-party component inventory shown in the About screen and prints a markdown
// table for THIRD-PARTY-NOTICES.md. Generated, not hand-written: a stale attribution list is an
// inaccurate legal claim (LICENSING.md promises it covers bundled components).
// Scope: renderer production deps, Go modules linked into the crossdevice sidecar (shipped as an
// extraResource), plus hand-listed platform components npm cannot see (PLATFORM_COMPONENTS).
// Android's dependencies are deliberately excluded: they ship in the APK, not this exe.
//   node scripts/gen-third-party-notices.mjs           # write + print
//   node scripts/gen-third-party-notices.mjs --check    # fail if out of date

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_JSON = path.join(UI_DIR, 'src', 'generated', 'third-party.json')

// Bundled components invisible to npm (inside Electron, Python wheels, PyInstaller); kept here so
// the About screen shows them too.
const PLATFORM_COMPONENTS = [
  // Electron is a devDependency (electron-builder packages it), so the dependencies-only scan never
  // sees it, yet it is the largest third-party code in the exe.
  { name: 'Electron', license: 'MIT', url: 'https://github.com/electron/electron', group: 'platform' },
  { name: 'Chromium', license: 'BSD-3-Clause and others', url: 'https://www.chromium.org/', group: 'platform' },
  { name: 'Node.js', license: 'MIT', url: 'https://nodejs.org/', group: 'platform' },
  { name: 'CPython', license: 'PSF-2.0', url: 'https://www.python.org/', group: 'platform' },
  { name: 'PyInstaller bootloader', license: 'GPL-2.0-or-later WITH bootloader-exception', url: 'https://pyinstaller.org/', group: 'platform' },
  { name: 'OpenSSL', license: 'Apache-2.0', url: 'https://www.openssl.org/', group: 'crypto' },
  { name: 'SQLCipher', license: 'BSD-style (Zetetic LLC)', url: 'https://www.zetetic.net/sqlcipher/', group: 'crypto' },
  { name: 'SQLite', license: 'Public domain', url: 'https://sqlite.org/', group: 'crypto' },
  { name: 'sqlcipher3', license: 'Zlib', url: 'https://github.com/coleifer/sqlcipher3', group: 'crypto' },
  { name: 'cryptography', license: 'Apache-2.0 OR BSD-3-Clause', url: 'https://github.com/pyca/cryptography', group: 'crypto' },
  { name: 'keyring', license: 'MIT', url: 'https://github.com/jaraco/keyring', group: 'crypto' },
  { name: 'pyotp', license: 'MIT', url: 'https://github.com/pyauth/pyotp', group: 'crypto' },
  { name: 'requests', license: 'Apache-2.0', url: 'https://requests.readthedocs.io/', group: 'python' },
  { name: 'qrcode (Python)', license: 'BSD-3-Clause', url: 'https://github.com/lincolnloop/python-qrcode', group: 'python' },
  { name: 'Pillow', license: 'MIT-CMU (HPND)', url: 'https://python-pillow.org/', group: 'python' },
  { name: 'psutil', license: 'BSD-3-Clause', url: 'https://github.com/giampaolo/psutil', group: 'python' },
  { name: 'pywin32', license: 'PSF-2.0', url: 'https://github.com/mhammond/pywin32', group: 'python' },
  { name: 'winrt-Windows.*', license: 'MIT', url: 'https://github.com/pywinrt/pywinrt', group: 'python' },
  { name: 'Tesseract OCR trained data', license: 'Apache-2.0', url: 'https://github.com/tesseract-ocr/tesseract', group: 'content' },
]

// Go modules carry no machine-readable licence, so it is declared here (read from LICENSE files
// in the module cache).
// Versions come from go.mod; collectGo() hard-fails on any module missing here, so a new Go
// dependency cannot ship without a declared licence.
const GO_LICENSES = {
  'github.com/flynn/noise': 'BSD-3-Clause',
  'github.com/fxamacker/cbor/v2': 'MIT',
  'github.com/grandcat/zeroconf': 'MIT',
  'github.com/quic-go/quic-go': 'MIT',
  'golang.org/x/crypto': 'BSD-3-Clause',
  'golang.org/x/text': 'BSD-3-Clause',
  'lukechampine.com/blake3': 'MIT',
  'github.com/cenkalti/backoff': 'MIT',
  'github.com/klauspost/cpuid/v2': 'MIT',
  'github.com/miekg/dns': 'BSD-3-Clause',
  'github.com/x448/float16': 'MIT',
  'golang.org/x/mobile': 'BSD-3-Clause',
  'golang.org/x/mod': 'BSD-3-Clause',
  'golang.org/x/net': 'BSD-3-Clause',
  'golang.org/x/sync': 'BSD-3-Clause',
  'golang.org/x/sys': 'BSD-3-Clause',
  'golang.org/x/tools': 'BSD-3-Clause',
}

// The Go standard library and runtime are compiled into the sidecar too, and
// no go.mod line ever mentions them.
const GO_RUNTIME = {
  name: 'Go runtime and standard library',
  license: 'BSD-3-Clause',
  url: 'https://go.dev/',
  group: 'go',
}

function goModuleUrl(modulePath) {
  if (modulePath.startsWith('github.com/')) return `https://${modulePath.replace(/\/v\d+$/, '')}`
  if (modulePath.startsWith('golang.org/x/')) return `https://pkg.go.dev/${modulePath}`
  return `https://pkg.go.dev/${modulePath}`
}

/**
 * Parses crossdevice/go.mod, both `require (...)` blocks: "// indirect" modules are linked into
 * the binary just like direct ones.
 */
function collectGo() {
  const goMod = path.join(UI_DIR, '..', 'crossdevice', 'go.mod')
  if (!fs.existsSync(goMod)) {
    console.error('! crossdevice/go.mod not found - Go components omitted')
    return []
  }
  const rows = []
  const undeclared = []
  for (const raw of fs.readFileSync(goMod, 'utf8').split('\n')) {
    // Matches both block form ("\tpath v1.2.3 // indirect") and single-line "require path v1.2.3";
    // ignores module/go/tool/replace and bare parens.
    const m = /^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}\/[^\s]+)\s+(v[^\s]+)/i.exec(raw)
    if (!m) continue
    const [, modulePath, version] = m
    const license = GO_LICENSES[modulePath]
    if (!license) {
      undeclared.push(modulePath)
      continue
    }
    rows.push({ name: modulePath, version, license, url: goModuleUrl(modulePath), group: 'go' })
  }
  if (undeclared.length) {
    console.error(`! go.mod modules with no declared licence: ${undeclared.join(', ')}`)
    console.error('  add them to GO_LICENSES in this script (read the LICENSE file, do not guess)')
    process.exit(1)
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return [GO_RUNTIME, ...rows]
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]) return pkg.licenses[0].type || 'UNKNOWN'
  return 'UNKNOWN'
}

function urlOf(pkg, name) {
  if (typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http')) return pkg.homepage
  const repo = pkg.repository
  const raw = typeof repo === 'string' ? repo : repo && repo.url
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')
    if (cleaned.startsWith('http')) return cleaned
    if (/^[\w-]+\/[\w.-]+$/.test(cleaned)) return `https://github.com/${cleaned}`
  }
  return `https://www.npmjs.com/package/${name}`
}

function collect() {
  const pkg = readJson(path.join(UI_DIR, 'package.json'))
  // Production dependencies only; devDependencies are not shipped (listed in the markdown's
  // build-time section instead).
  const names = Object.keys(pkg.dependencies || {}).sort()
  const rows = []
  const missing = []
  for (const name of names) {
    const p = path.join(UI_DIR, 'node_modules', name, 'package.json')
    if (!fs.existsSync(p)) {
      missing.push(name)
      continue
    }
    const meta = readJson(p)
    // @types/* are compile-time only; they leave no code in the bundle.
    if (name.startsWith('@types/')) continue
    rows.push({ name, version: meta.version, license: licenseOf(meta), url: urlOf(meta, name), group: 'ui' })
  }
  if (missing.length) {
    console.error(`! not installed, skipped: ${missing.join(', ')}`)
    console.error('  run `npm install` first for a complete inventory')
  }
  return [...PLATFORM_COMPONENTS, ...collectGo(), ...rows]
}

function main() {
  const components = collect()
  const payload = {
    // Not a timestamp: a timestamp makes this file churn on every run and
    // turns --check into a permanent false positive.
    generatedBy: 'scripts/gen-third-party-notices.mjs',
    count: components.length,
    components,
  }
  const text = JSON.stringify(payload, null, 2) + '\n'

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT_JSON) ? fs.readFileSync(OUT_JSON, 'utf8') : ''
    if (current !== text) {
      console.error('third-party.json is out of date - run: node scripts/gen-third-party-notices.mjs')
      process.exit(1)
    }
    console.log(`third-party.json up to date (${components.length} components)`)
    return
  }

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  fs.writeFileSync(OUT_JSON, text)
  console.log(`wrote ${path.relative(UI_DIR, OUT_JSON)} (${components.length} components)`)

  // Print every group, not just 'ui': printing only npm was how Go and platform components stayed
  // out of THIRD-PARTY-NOTICES.md.
  console.log('\n--- markdown, for THIRD-PARTY-NOTICES.md ---')
  const GROUP_TITLES = {
    platform: 'Platform / runtime',
    crypto: 'Cryptography and storage',
    python: 'Python',
    content: 'Bundled content',
    go: 'Cross-device sidecar (Go)',
    ui: 'Desktop UI (npm, production)',
  }
  for (const [group, title] of Object.entries(GROUP_TITLES)) {
    const rows = components.filter((c) => c.group === group)
    if (rows.length === 0) continue
    console.log(`\n### ${title}\n`)
    console.log('| Component | Version | Licence |')
    console.log('|---|---|---|')
    for (const c of rows) {
      console.log(`| [${c.name}](${c.url}) | ${c.version ?? '—'} | ${c.license} |`)
    }
  }
}

main()
