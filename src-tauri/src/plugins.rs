//! What the app adds to the user's Claude Code so chats start well equipped: the bundled
//! karpathy-guidelines skill and a few plugins from the official marketplace. Each is added once
//! and only when missing — a skill the user edited or a plugin they removed stays that way.

use std::path::PathBuf;

use crate::core::{clean_env, command, home, user_data, which};

const MARKETPLACE: &str = "claude-plugins-official";

/// Plugin, and the language server it needs on PATH (it is skipped until that is installed).
const PLUGINS: &[(&str, Option<&str>)] = &[
    ("context7", None),
    ("feature-dev", None),
    ("typescript-lsp", Some("typescript-language-server")),
    ("csharp-lsp", Some("csharp-ls")),
    ("php-lsp", Some("intelephense")),
];

pub fn init() {
    install_skill();
    tauri::async_runtime::spawn(install_plugins());
}

fn install_skill() {
    let dir = home().join(".claude").join("skills").join("karpathy-guidelines");
    let file = dir.join("SKILL.md");
    if !file.exists() && std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(file, include_str!("karpathy_guidelines.md"));
    }
}

async fn install_plugins() {
    // the plugins this app already installed, one per line: never installed a second time
    let done_file = user_data().join("plugins-installed.txt");
    let mut done = tokio::fs::read_to_string(&done_file).await.unwrap_or_default();
    let todo: Vec<&str> = PLUGINS
        .iter()
        .filter(|(name, needs)| !done.lines().any(|l| l == *name) && needs.is_none_or(|bin| which(bin).is_some()))
        .map(|(name, _)| *name)
        .collect();
    if todo.is_empty() {
        return;
    }
    let Some(mut claude) = crate::pty::claude_path().await else { return };
    // npm's extensionless sh shim: Windows needs the .cmd next to it
    if cfg!(windows) && claude.extension().is_none() {
        let cmd = PathBuf::from(format!("{}.cmd", claude.display()));
        if cmd.exists() {
            claude = cmd;
        }
    }
    for name in todo {
        let ok = command(&claude)
            .args(["plugin", "install", &format!("{name}@{MARKETPLACE}")])
            .env_clear()
            .envs(clean_env())
            .output()
            .await
            .is_ok_and(|o| o.status.success());
        if ok {
            done.push_str(name);
            done.push('\n');
            let _ = tokio::fs::write(&done_file, &done).await;
        }
    }
}
