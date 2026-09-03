mod binaries;
mod commands;
mod error;
mod settings;

use settings::SettingsHandle;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = settings::load();

    tauri::Builder::default()
        .manage(SettingsHandle(Mutex::new(settings)))
        .manage(commands::PingState {
            count: std::sync::atomic::AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::settings_get,
            commands::settings_save,
            commands::app_version,
            commands::binaries::binaries_status,
            commands::binaries::binaries_install,
            commands::binaries::binaries_update,
            commands::binaries::binaries_check_latest,
            commands::binaries::binaries_set_custom_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
