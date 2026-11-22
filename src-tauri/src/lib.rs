//! VIBE CODE — the native side: terminals, files, git, Claude's session store, SQL Server, Zalo,
//! the built-in browser and the MCP server that lets each chat's Claude drive them.

pub mod core;
pub mod secure;

#[cfg(windows)]
mod adblock;
mod appcmds;
mod browser;
mod capture;
mod desktop;
mod extensions;
mod fsearch;
mod fsx;
mod git;
mod gmail;
mod mcp;
mod mssql;
mod office;
mod onlyoffice;
mod plugins;
mod pty;
mod sessions;
mod settings;
mod toast;
mod webdata;
mod windowing;
mod zalo;
mod zalo_tasks;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    core::fix_mac_path();

    tauri::Builder::default()
        // one instance: launching it again toggles the running window (Guake-style)
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| windowing::toggle()))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![windowing::HIDDEN_ARG])))
        .invoke_handler(tauri::generate_handler![
            // terminals + coding agents
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_visible,
            pty::claude_detect,
            pty::agents_detect,
            appcmds::claude_usage,
            appcmds::sys_memory,
            appcmds::claude_get_project_bypass,
            appcmds::claude_set_project_bypass,
            // built-in browser
            browser::web_open,
            browser::web_place,
            browser::web_set_active,
            browser::web_navigate,
            browser::web_history,
            browser::web_reload,
            browser::web_stop,
            browser::web_set_user_agent,
            browser::web_close,
            browser::web_adblock_status,
            extensions::web_extensions,
            extensions::web_extension_add,
            extensions::web_extension_enable,
            extensions::web_extension_remove,
            webdata::web_data,
            webdata::web_import_chrome,
            webdata::web_suggest,
            webdata::web_visit,
            webdata::web_title,
            // Claude session store
            sessions::sessions_list,
            sessions::sessions_images,
            sessions::sessions_context,
            sessions::sessions_tasks,
            sessions::sessions_files,
            sessions::sessions_log,
            sessions::sessions_delete,
            // SQL Server
            mssql::db_list,
            mssql::db_get,
            mssql::db_save,
            mssql::db_save_many,
            mssql::db_remove,
            mssql::db_test,
            mssql::db_build_conn,
            mssql::db_parse_conn,
            mssql::db_query,
            mssql::db_cancel,
            mssql::db_databases,
            mssql::db_objects,
            mssql::db_columns,
            mssql::db_scan_project,
            mssql::db_scan_ssms,
            // other apps on the desktop (Claude's vibe-desktop tools)
            desktop::desktop_set,
            // Gmail (read-only)
            gmail::gmail_state,
            gmail::gmail_login,
            gmail::gmail_logout,
            gmail::gmail_list,
            gmail::gmail_read,
            gmail::gmail_task_context,
            // Office → Sheet
            office::office_pick,
            office::office_read_file,
            office::office_write_file,
            office::office_recent,
            office::office_recent_add,
            office::office_backup,
            office::office_pending,
            office::office_reply,
            onlyoffice::onlyoffice_origin,
            onlyoffice::onlyoffice_install,
            onlyoffice::onlyoffice_download_size,
            // Zalo
            zalo::zalo_state,
            zalo::zalo_login,
            zalo::zalo_cancel,
            zalo::zalo_reconnect,
            zalo::zalo_logout,
            zalo::zalo_sync_all,
            zalo_tasks::zalo_tasks,
            zalo_tasks::zalo_tasks_analyze,
            zalo_tasks::zalo_task_status,
            zalo_tasks::zalo_task_context,
            zalo_tasks::zalo_task_remove,
            zalo_tasks::zalo_tasks_viewing,
            toast::toast_click,
            toast::toast_close,
            // window
            windowing::win_state,
            windowing::win_minimize,
            windowing::win_badge,
            windowing::win_toggle_maximize,
            windowing::win_close,
            windowing::win_hide,
            windowing::win_set_mode,
            // files + git
            fsx::fs_read_dir,
            fsx::fs_explore,
            fsx::fs_places,
            fsx::fs_read_file,
            fsx::fs_write_file,
            fsx::fs_list_files,
            fsx::fs_watch,
            fsx::fs_reveal,
            fsx::fs_open_path,
            fsx::fs_rename,
            fsx::fs_copy,
            fsx::fs_trash,
            fsx::fs_create,
            fsearch::fs_search,
            fsearch::fs_search_forget,
            git::git_state,
            git::git_original,
            git::git_init,
            git::git_show,
            git::git_log,
            git::git_commit_files,
            git::git_branches,
            git::git_checkout,
            git::git_discard,
            git::git_stage,
            git::git_commit,
            git::git_push,
            git::git_pull,
            // app
            appcmds::app_settings,
            appcmds::app_remember_folder,
            appcmds::app_set_settings,
            appcmds::app_pick_folder,
            appcmds::app_pick_files,
            appcmds::app_file_info,
            appcmds::app_open_external,
            appcmds::app_clear_browser_cache,
            appcmds::app_relaunch,
            appcmds::app_check_update,
            appcmds::app_install_update,
            capture::capture_start,
            capture::capture_frame,
            capture::capture_ready,
            capture::capture_cancel,
            capture::capture_done,
            appcmds::app_save_image,
            appcmds::app_clipboard_files,
            appcmds::app_voice_typing,
        ])
        .setup(|app| {
            core::init(app.handle());
            plugins::init();
            // before any chat starts: chats get the MCP server's address at launch
            tauri::async_runtime::block_on(mcp::start())?;
            windowing::init(app)?;
            tauri::async_runtime::spawn(async {
                browser::start_adblock().await;
                extensions::install_defaults().await;
            });
            zalo::init();
            zalo_tasks::init();
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == core::MAIN {
                windowing::on_event(window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building VIBE CODE")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                pty::kill_all();
                mssql::cancel_all();
                let _ = app.get_webview_window(core::MAIN);
            }
        });
}
