import { execFileSync } from 'child_process'
import { homedir } from 'os'

/**
 * Apps opened from Finder/Dock on macOS get launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so `claude`, `node`, Homebrew tools… are not found. Take the PATH the user's login shell builds
 * (~/.zshrc, ~/.zprofile) and add the usual install folders as a fallback.
 */
export function fixMacPath(): void {
  if (process.platform !== 'darwin') return
  const parts: string[] = []
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000 })
    const m = /__PATH__(.*)__PATH__/.exec(out)
    if (m) parts.push(...m[1].split(':'))
  } catch {
    // a broken shell profile shouldn't stop the app; the fallbacks below still apply
  }
  const home = homedir()
  parts.push(
    ...(process.env.PATH ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.npm-global/bin`,
    `${home}/.bun/bin`
  )
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(':')
}
