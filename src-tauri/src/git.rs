//! Git through the `git` CLI (the user's own config, credentials and hooks apply).

use std::{collections::HashMap, path::Path};

use serde::Serialize;

use crate::core::{Res, command, err};

async fn git(cwd: &str, args: &[&str]) -> Res<String> {
    let out = command("git").args(args).current_dir(cwd).output().await?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Git's explanation of a failed command (some, like "nothing to commit", go to stdout).
fn failure(out: &std::process::Output) -> crate::core::Error {
    let stderr = String::from_utf8_lossy(&out.stderr);
    err(if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr }.trim().to_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    rel: String,
    abs: String,
    status: &'static str,
    staged: bool,
    added: u32,
    deleted: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    is_repo: bool,
    root: Option<String>,
    branch: Option<String>,
    files: Vec<GitFile>,
    /// the branch it pushes to / pulls from (e.g. `origin/master`), and how far apart they are
    /// as of the last fetch
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// any remote at all (a branch without upstream can still be published)
    has_remote: bool,
}

/// `## master...origin/master [ahead 1, behind 2]` → (upstream, ahead, behind).
fn branch_header(h: &str) -> (Option<String>, u32, u32) {
    let Some((_, rest)) = h.split_once("...") else { return (None, 0, 0) };
    let (up, counts) = rest.split_once(" [").unwrap_or((rest, ""));
    let count = |word: &str| counts.split(", ").find_map(|p| p.trim_end_matches(']').strip_prefix(word)?.trim().parse().ok()).unwrap_or(0);
    (Some(up.to_owned()), count("ahead"), count("behind"))
}

/// `added\tdeleted\tpath` records of `--numstat -z` → path → (added, deleted), summed.
fn numstats<'a>(outs: impl IntoIterator<Item = &'a str>) -> HashMap<String, (u32, u32)> {
    let mut stats: HashMap<String, (u32, u32)> = HashMap::new();
    for out in outs {
        for rec in out.split('\0') {
            let mut it = rec.splitn(3, '\t');
            let (Some(a), Some(d), Some(p)) = (it.next(), it.next(), it.next()) else { continue };
            if p.is_empty() {
                continue;
            }
            let e = stats.entry(p.to_owned()).or_default();
            e.0 += a.parse().unwrap_or(0);
            e.1 += d.parse().unwrap_or(0);
        }
    }
    stats
}

#[tauri::command]
pub async fn git_state(folder: String) -> Res<GitState> {
    let Ok(root) = git(&folder, &["rev-parse", "--show-toplevel"]).await.map(|s| s.trim().to_owned()) else {
        return Ok(GitState { is_repo: false, root: None, branch: None, files: vec![], upstream: None, ahead: 0, behind: 0, has_remote: false });
    };
    let (branch, status, num, num_cached) = tokio::join!(
        git(&root, &["branch", "--show-current"]),
        // no index refresh: that write fires the watcher, which runs yet another status
        git(&root, &["--no-optional-locks", "status", "--porcelain=v1", "--branch", "-z", "-uall"]),
        git(&root, &["diff", "--numstat", "-z"]),
        git(&root, &["diff", "--numstat", "--cached", "-z"]),
    );
    let (status, num, num_cached) = (status.unwrap_or_default(), num.unwrap_or_default(), num_cached.unwrap_or_default());
    let stats = numstats([num.as_str(), num_cached.as_str()]);

    let mut files = Vec::new();
    let mut recs = status.split('\0').peekable();
    let (upstream, ahead, behind) = match recs.next_if(|r| r.starts_with("## ")) {
        Some(h) => branch_header(h),
        None => (None, 0, 0),
    };
    while let Some(rec) = recs.next() {
        if rec.len() < 4 {
            continue;
        }
        let b = rec.as_bytes();
        let (x, y) = (b[0], b[1]);
        let rel = &rec[3..];
        if x == b'R' || x == b'C' {
            recs.next(); // the original path
        }
        let status = match (x, y) {
            (b'?', b'?') => "?",
            (b'U', _) | (_, b'U') => "U",
            (b'D', _) | (_, b'D') => "D",
            (b'A', _) => "A",
            (b'R', _) => "R",
            _ => "M",
        };
        let (added, deleted) = stats.get(rel).copied().unwrap_or_default();
        files.push(GitFile {
            abs: Path::new(&root).join(rel).to_string_lossy().into_owned(),
            rel: rel.to_owned(),
            status,
            staged: x != b' ' && x != b'?',
            added,
            deleted,
        });
    }
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    let branch = branch.map(|b| b.trim().to_owned()).ok().filter(|b| !b.is_empty()).unwrap_or_else(|| "HEAD".into());
    let has_remote = upstream.is_some() || git(&root, &["remote"]).await.is_ok_and(|r| !r.trim().is_empty());
    Ok(GitState { is_repo: true, root: Some(root), branch: Some(branch), files, upstream, ahead, behind, has_remote })
}

/// Push / pull: never wait on a password prompt in a terminal nobody sees (the credential
/// manager's own window still works).
async fn git_remote(cwd: &str, args: &[&str]) -> Res<()> {
    let out = command("git").args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").output().await?;
    if !out.status.success() {
        return Err(failure(&out));
    }
    Ok(())
}

/// Stage (`git add`) or unstage files.
#[tauri::command]
pub async fn git_stage(root: String, rels: Vec<String>, stage: bool) -> Res<()> {
    let with = |args: &[&'static str]| args.iter().copied().chain(["--"]).chain(rels.iter().map(String::as_str)).collect::<Vec<_>>();
    if stage {
        return git(&root, &with(&["add", "-A"])).await.map(drop);
    }
    // before the first commit there is no HEAD to restore the index from
    match git(&root, &with(&["restore", "--staged"])).await {
        Ok(_) => Ok(()),
        Err(_) => git(&root, &with(&["rm", "--cached", "-r", "-q"])).await.map(drop),
    }
}

/// Commit what is staged; with nothing staged, every change (like `git commit -a`, new files too).
#[tauri::command]
pub async fn git_commit(root: String, message: String) -> Res<()> {
    // exits 1 when something is staged
    if git(&root, &["diff", "--cached", "--quiet"]).await.is_ok() {
        git(&root, &["add", "-A"]).await?;
    }
    git(&root, &["commit", "-m", &message]).await.map(drop)
}

/// Push; a branch without upstream is published to `origin` (or the only remote) and tracks it.
#[tauri::command]
pub async fn git_push(root: String) -> Res<()> {
    if git(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.is_ok() {
        return git_remote(&root, &["push"]).await;
    }
    let remotes = git(&root, &["remote"]).await?;
    let remote = remotes.lines().find(|r| *r == "origin").or_else(|| remotes.lines().next()).ok_or_else(|| err(crate::settings::tr("This repository has no remote to push to.", "Repository này không có remote để push lên.")))?;
    git_remote(&root, &["push", "-u", remote, "HEAD"]).await
}

/// Pull, fast-forward only: never makes a merge commit or touches local work; git explains when
/// the branches have diverged.
#[tauri::command]
pub async fn git_pull(root: String) -> Res<()> {
    git_remote(&root, &["pull", "--ff-only", "--no-rebase"]).await
}

/// File content at HEAD; '' when it does not exist there.
#[tauri::command]
pub async fn git_original(root: String, rel: String) -> Res<String> {
    Ok(git(&root, &["show", &format!("HEAD:{rel}")]).await.unwrap_or_default())
}

#[tauri::command]
pub async fn git_init(folder: String) -> Res<()> {
    git(&folder, &["init"]).await.map(drop)
}

#[tauri::command]
pub async fn git_show(root: String, rev: String, rel: String) -> Res<String> {
    Ok(git(&root, &["show", &format!("{rev}:{rel}")]).await.unwrap_or_default())
}

#[derive(Serialize)]
pub struct GitCommit {
    hash: String,
    short: String,
    author: String,
    date: u64,
    subject: String,
}

#[tauri::command]
pub async fn git_log(root: String) -> Res<Vec<GitCommit>> {
    let Ok(out) = git(&root, &["log", "-n200", "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e"]).await else {
        return Ok(vec![]);
    };
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let mut f = rec.trim_start().split('\x1f');
            let (hash, short) = (f.next()?, f.next()?);
            if hash.is_empty() || short.is_empty() {
                return None;
            }
            Some(GitCommit {
                hash: hash.into(),
                short: short.into(),
                author: f.next().unwrap_or_default().into(),
                date: f.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0) * 1000,
                subject: f.next().unwrap_or_default().into(),
            })
        })
        .collect())
}

#[derive(Serialize)]
pub struct GitCommitFile {
    rel: String,
    status: &'static str,
    added: u32,
    deleted: u32,
}

#[tauri::command]
pub async fn git_commit_files(root: String, hash: String) -> Res<Vec<GitCommitFile>> {
    let base = ["diff-tree", "--root", "--no-commit-id", "-r", "--no-renames", "-z"];
    let names_args: Vec<&str> = base.iter().copied().chain(["--name-status", &hash]).collect();
    let num_args: Vec<&str> = base.iter().copied().chain(["--numstat", &hash]).collect();
    let (names, nums) = tokio::join!(git(&root, &names_args), git(&root, &num_args));
    let (names, nums) = (names.unwrap_or_default(), nums.unwrap_or_default());
    let stats = numstats([nums.as_str()]);
    let parts: Vec<&str> = names.split('\0').collect();
    Ok(parts
        .as_chunks::<2>().0.iter()
        .filter_map(|p| {
            let (code, rel) = (p[0].chars().next()?, p[1]);
            if rel.is_empty() {
                return None;
            }
            let status = match code {
                'A' => "A",
                'D' => "D",
                'U' => "U",
                _ => "M",
            };
            let (added, deleted) = stats.get(rel).copied().unwrap_or_default();
            Some(GitCommitFile { rel: rel.into(), status, added, deleted })
        })
        .collect())
}

#[derive(Serialize)]
pub struct GitBranch {
    name: String,
    current: bool,
    /// only on the remote (e.g. `origin/feature`): checking it out makes a local tracking branch
    remote: bool,
}

/// Local branches, then remote ones that have no local branch of the same name.
#[tauri::command]
pub async fn git_branches(root: String) -> Res<Vec<GitBranch>> {
    let out = git(&root, &["for-each-ref", "--sort=-committerdate", "--format=%(refname)%1f%(HEAD)", "refs/heads", "refs/remotes"]).await?;
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for line in out.lines() {
        let Some((refname, head)) = line.split_once('\x1f') else { continue };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local.push(GitBranch { name: name.into(), current: head == "*", remote: false });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/")
            && !name.ends_with("/HEAD")
        {
            remote.push(name.to_owned());
        }
    }
    for name in remote {
        let short = name.split_once('/').map_or(name.as_str(), |(_, b)| b);
        if !local.iter().any(|b| b.name == short) && !local.iter().any(|b| b.name == name) {
            local.push(GitBranch { name, current: false, remote: true });
        }
    }
    Ok(local)
}

/// Switch to a branch; a remote one (`origin/x`) becomes local `x` tracking it. Git refuses when
/// uncommitted changes would be overwritten: its message comes back as the error.
#[tauri::command]
pub async fn git_checkout(root: String, name: String, remote: bool) -> Res<()> {
    if remote {
        let local = name.split_once('/').map_or(name.as_str(), |(_, b)| b);
        git(&root, &["switch", "-c", local, "--track", &name]).await.map(drop)
    } else {
        git(&root, &["switch", &name]).await.map(drop)
    }
}

/// Throw away a file's uncommitted changes (staged and not): back to HEAD, or gone when HEAD
/// doesn't have it (new / untracked files).
#[tauri::command]
pub async fn git_discard(root: String, rel: String, status: String) -> Res<()> {
    match status.as_str() {
        "?" => Ok(tokio::fs::remove_file(Path::new(&root).join(&rel)).await?),
        "A" => git(&root, &["rm", "-f", "--", &rel]).await.map(drop),
        _ => git(&root, &["restore", "--source=HEAD", "--staged", "--worktree", "--", &rel]).await.map(drop),
    }
}
