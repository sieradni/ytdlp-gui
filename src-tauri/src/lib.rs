mod binaries;
mod commands;
mod engine;
mod error;
mod settings;
mod store;

use settings::SettingsHandle;
use std::sync::{Arc, Mutex};
use store::Db;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = settings::load();

    // sqlite: history metadata + persistent queue (§5.3, §5 queue model)
    let db = Arc::new(Db::open(&store::db_path()).expect("failed to open history.db"));
    db.normalize_after_restart()
        .expect("failed to normalize job states after restart (D35)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SettingsHandle(Mutex::new(settings)))
        .manage(commands::PingState {
            count: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(commands::metadata::Memo::default())
        .setup(move |app| {
            // queue + dispatcher live for the whole app lifetime
            let queue = engine::queue::JobQueue::new(app.handle().clone(), Arc::clone(&db));
            app.manage(commands::jobs::QueueHandle::new(queue));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::settings_get,
            commands::settings_save,
            commands::app_paths,
            commands::app_version,
            commands::binaries::binaries_status,
            commands::binaries::binaries_install,
            commands::binaries::binaries_update,
            commands::binaries::binaries_check_latest,
            commands::binaries::binaries_set_custom_path,
            commands::jobs::job_add,
            commands::jobs::job_stop,
            commands::jobs::job_retry,
            commands::jobs::job_remove,
            commands::jobs::queue_list,
            commands::jobs::queue_pause,
            commands::jobs::queue_resume,
            commands::metadata::metadata_resolve,
            commands::history::history_list,
            commands::history::history_import_archive,
            commands::history::history_relink,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
