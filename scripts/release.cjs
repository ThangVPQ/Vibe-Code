// Builds a new version and publishes its installer as a GitHub release, which the app's
// Update button installs.  `npm run release` bumps the patch version; `npm run release 0.3.0` sets one.
// Token: GITHUB_TOKEN, else the one git already stores for github.com.
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const run = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: 'inherit', ...opts })
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const write = (f, s) => fs.writeFileSync(path.join(root, f), s)

const current = JSON.parse(read('src-tauri/tauri.conf.json')).version
const version =
  process.argv[2] ||
  current
    .split('.')
    .map((n, i) => (i === 2 ? Number(n) + 1 : n))
    .join('.')
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`bad version: ${version}`)

const repo = execSync('git remote get-url origin', { cwd: root, encoding: 'utf8' })
  .trim()
  .match(/github\.com[:/](.+?)(?:\.git)?$/)[1]
const token =
  process.env.GITHUB_TOKEN ||
  execSync('git credential fill', { cwd: root, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' }).match(/^password=(.*)$/m)[1]

async function gh(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'vibe-code-release', ...init.headers }
  })
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${url}: ${r.status} ${await r.text()}`)
  return r.json()
}

async function main() {
  console.log(`Releasing ${current} -> ${version}`)
  write('package.json', read('package.json').replace(/"version": "[^"]+"/, `"version": "${version}"`))
  write('src-tauri/tauri.conf.json', read('src-tauri/tauri.conf.json').replace(/"version": "[^"]+"/, `"version": "${version}"`))
  write('src-tauri/Cargo.toml', read('src-tauri/Cargo.toml').replace(/^version = "[^"]+"/m, `version = "${version}"`))

  run('npm run build')

  const exe = path.join(root, 'src-tauri/target/release/bundle/nsis', `VIBE CODE_${version}_x64-setup.exe`)
  if (!fs.existsSync(exe)) throw new Error(`installer not found: ${exe}`)

  run(`git commit -m "Release v${version}" -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`)
  run('git push')

  const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim()
  const rel = await gh(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    body: JSON.stringify({ tag_name: `v${version}`, target_commitish: branch, name: `v${version}` })
  })
  // same name every release, so releases/latest/download/vibe-code_x64-setup.exe always gets the newest
  const name = 'vibe-code_x64-setup.exe'
  await gh(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(exe)
  })
  console.log(`Published ${rel.html_url}`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
