import { execFile } from 'child_process'
import { join } from 'path'
import type { GitCommit, GitCommitFile, GitFile, GitFileStatus, GitState } from '../shared/types'

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export async function gitState(folder: string): Promise<GitState> {
  let root: string
  try {
    root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { isRepo: false, root: null, branch: null, files: [] }
  }

  const [branchOut, statusOut, numstat, numstatCached] = await Promise.all([
    git(root, ['branch', '--show-current']).catch(() => ''),
    git(root, ['status', '--porcelain=v1', '-z', '-uall']).catch(() => ''),
    git(root, ['diff', '--numstat', '-z']).catch(() => ''),
    git(root, ['diff', '--numstat', '--cached', '-z']).catch(() => '')
  ])

  const stats = new Map<string, { a: number; d: number }>()
  for (const out of [numstat, numstatCached]) {
    for (const rec of out.split('\0')) {
      const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      const prev = stats.get(m[3]) ?? { a: 0, d: 0 }
      stats.set(m[3], { a: prev.a + (parseInt(m[1]) || 0), d: prev.d + (parseInt(m[2]) || 0) })
    }
  }

  const files: GitFile[] = []
  const recs = statusOut.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const rel = rec.slice(3)
    if (x === 'R' || x === 'C') i++ // next record is the original path
    let status: GitFileStatus
    if (x === '?' && y === '?') status = '?'
    else if (x === 'U' || y === 'U') status = 'U'
    else if (x === 'D' || y === 'D') status = 'D'
    else if (x === 'A') status = 'A'
    else if (x === 'R') status = 'R'
    else status = 'M'
    const st = stats.get(rel)
    files.push({
      rel,
      abs: join(root, rel),
      status,
      staged: x !== ' ' && x !== '?',
      added: st?.a ?? 0,
      deleted: st?.d ?? 0
    })
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))

  return { isRepo: true, root, branch: branchOut.trim() || 'HEAD', files }
}

/** Content of a file at HEAD; empty string if it does not exist there. */
export async function gitOriginal(root: string, rel: string): Promise<string> {
  try {
    return await git(root, ['show', `HEAD:${rel}`])
  } catch {
    return ''
  }
}

export async function gitInit(folder: string): Promise<void> {
  await git(folder, ['init'])
}

/** Content of a file at any revision (e.g. `abc123`, `abc123^`); empty string if it does not exist there. */
export async function gitShow(root: string, rev: string, rel: string): Promise<string> {
  try {
    return await git(root, ['show', `${rev}:${rel}`])
  } catch {
    return ''
  }
}

/** Most recent commits on the current branch, newest first ([] for a repo with no commits yet). */
export async function gitLog(root: string, limit = 200): Promise<GitCommit[]> {
  let out: string
  try {
    out = await git(root, ['log', `-n${limit}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e'])
  } catch {
    return []
  }
  const commits: GitCommit[] = []
  for (const rec of out.split('\x1e')) {
    const [hash, short, author, at, subject] = rec.replace(/^\s+/, '').split('\x1f')
    if (!hash || !short) continue
    commits.push({ hash, short, author: author ?? '', date: (parseInt(at) || 0) * 1000, subject: subject ?? '' })
  }
  return commits
}

/** Files a commit touched, with line counts (first commit diffs against the empty tree). */
export async function gitCommitFiles(root: string, hash: string): Promise<GitCommitFile[]> {
  const base = ['diff-tree', '--root', '--no-commit-id', '-r', '--no-renames', '-z']
  const [names, nums] = await Promise.all([
    git(root, [...base, '--name-status', hash]).catch(() => ''),
    git(root, [...base, '--numstat', hash]).catch(() => '')
  ])
  const stats = new Map<string, { a: number; d: number }>()
  for (const rec of nums.split('\0')) {
    const m = rec.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m) stats.set(m[3], { a: parseInt(m[1]) || 0, d: parseInt(m[2]) || 0 })
  }
  const files: GitCommitFile[] = []
  const parts = names.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0]
    const rel = parts[i + 1]
    if (!code || !rel) continue
    const status: GitFileStatus = code === 'A' ? 'A' : code === 'D' ? 'D' : code === 'U' ? 'U' : 'M'
    const st = stats.get(rel)
    files.push({ rel, status, added: st?.a ?? 0, deleted: st?.d ?? 0 })
  }
  return files
}
