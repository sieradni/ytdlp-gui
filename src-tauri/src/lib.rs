mod binaries;
mod commands;
mod engine;
mod error;
mod migrate;
mod settings;
mod store;

use settings::SettingsHandle;
use std::sync::{Arc, Mutex};
use store::Db;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut settings = settings::load();

    // sqlite: history metadata + persistent queue (§5.3, §5 queue model)
    let db = Arc::new(Db::open(&store::db_path()).expect("failed to open history.db"));
    db.normalize_after_restart()
        .expect("failed to normalize job states after restart (D35)");

    // v1 migration (§11, D43): one-shot (settings.migrated_from_v1 marks it
    // done) — runs before anything reads the settings; persisted below. a
    // failure here must never block startup.
    let mut migrated_composer_defaults: Option<engine::args::JobOptions> = None;
    let mut migration_report: Option<migrate::MigrationReport> = None;
    if !settings.migrated_from_v1 {
        match migrate::apply(&db, &mut settings, &mut migrated_composer_defaults) {
            Ok(report) => {
                if report.config_applied {
                    settings.migrated_from_v1 = true;
                    let _ = settings::save(&settings);
                    migration_report = Some(report.clone());
                    eprintln!(
                        "v1 migration: config applied, {} ids seeded into history{}",
                        report.history_seeded,
                        report
                            .dropped_keys
                            .is_empty()
                            .then(String::new)
                            .unwrap_or_else(|| format!(", dropped: {:?}", report.dropped_keys))
                    );
                }
            }
            Err(e) => eprintln!("v1 migration skipped: {e}"),
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SettingsHandle(Mutex::new(settings)))
        .manage(commands::PingState {
            count: std::sync::atomic::AtomicU64::new(0),
        })
        .manage(commands::metadata::Memo::default())
        .manage(migrated_composer_defaults)
        .manage(migration_report)
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
            commands::migration_status,
            commands::metadata::metadata_resolve,
            commands::history::history_list,
            commands::history::history_import_archive,
            commands::history::history_relink,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
