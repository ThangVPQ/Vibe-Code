//! Ad blocking for the Web tabs: uBlock Origin Lite (github.com/uBlockOrigin/uBOL-home), loaded into WebView2 as a
//! browser extension. Its newest release is downloaded on first launch and again whenever a newer
//! one is out; browser.rs adds it to the Web tabs' profile and turns it on / off with the setting.

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde_json::Value;

use crate::core::{command, user_data};

const REPO: &str = "uBlockOrigin/uBOL-home";
/// Extension name in its manifest: how it is found again among the profile's extensions.
pub const NAME: &str = "uBlock Origin Lite";
/// What earlier versions loaded (the full uBlock Origin): taken out of the profile.
pub const OLD_NAME: &str = "uBlock Origin";

fn root() -> PathBuf {
    user_data().join("ubol")
}

/// The release now on disk: (tag, unpacked extension folder).
pub fn installed() -> Option<(String, PathBuf)> {
    let dirs = std::fs::read_dir(root()).ok()?;
    for d in dirs.flatten() {
        let tag = d.file_name().to_string_lossy().into_owned();
        if tag.ends_with(".part") || !d.path().is_dir() {
            continue;
        }
        if let Some(ext) = manifest_dir(&d.path()) {
            return Some((tag, ext));
        }
    }
    None
}

/// The folder holding manifest.json: the archive's root or its only subfolder.
fn manifest_dir(dir: &Path) -> Option<PathBuf> {
    if dir.join("manifest.json").is_file() {
        return Some(dir.to_owned());
    }
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.join("manifest.json").is_file())
}

/// Downloads the newest release unless it is already on disk; true when a new one was installed.
pub async fn update() -> anyhow::Result<bool> {
    let http = reqwest::Client::new();
    let rel: Value = http
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("User-Agent", "vibe-code")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let tag = rel["tag_name"].as_str().context("release without a tag")?.to_owned();
    if installed().is_some_and(|(t, _)| t == tag) {
        return Ok(false);
    }
    let url = rel["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(".chromium.zip")))
        .and_then(|a| a["browser_download_url"].as_str())
        .context("no Chromium build in the release")?;
    let zip = http.get(url).header("User-Agent", "vibe-code").send().await?.error_for_status()?.bytes().await?;

    let root = root();
    tokio::fs::create_dir_all(&root).await?;
    let (file, part, done) = (root.join(format!("{tag}.zip")), root.join(format!("{tag}.part")), root.join(&tag));
    tokio::fs::write(&file, &zip).await?;
    let _ = tokio::fs::remove_dir_all(&part).await;
    let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "''"));
    let out = command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Expand-Archive -LiteralPath {} -DestinationPath {} -Force", quote(&file), quote(&part))])
        .output()
        .await?;
    let _ = tokio::fs::remove_file(&file).await;
    if !out.status.success() || manifest_dir(&part).is_none() {
        let _ = tokio::fs::remove_dir_all(&part).await;
        bail!("could not unpack {NAME} {tag}: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    tokio::fs::rename(&part, &done).await?;
    // older releases: the profile may still have one loaded until the next launch, so a failed
    // delete is retried then
    for d in std::fs::read_dir(&root)?.flatten() {
        if d.path().is_dir() && d.file_name().to_string_lossy() != tag.as_str() {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
    // the full uBlock Origin earlier versions downloaded
    let _ = std::fs::remove_dir_all(user_data().join("ublock"));
    Ok(true)
}

/// Tag of the release last added to the Web tabs' profile (a newer one replaces it).
pub fn loaded_tag() -> Option<String> {
    std::fs::read_to_string(root().join("loaded.txt")).ok().map(|s| s.trim().to_owned())
}

pub fn set_loaded_tag(tag: &str) {
    let _ = std::fs::write(root().join("loaded.txt"), tag);
}
