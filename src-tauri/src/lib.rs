use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

/// Shared app state. M1: placeholder with a monotonically increasing
/// request counter; engine/queue state lands in M2/M3.
pub struct AppState {
    ping_count: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pong {
    pub message: String,
    pub ping_count: u64,
}

#[tauri::command]
fn ping(state: tauri::State<'_, AppState>, message: Option<String>) -> Result<Pong, String> {
    let count = state.ping_count.fetch_add(1, Ordering::SeqCst) + 1;
    Ok(Pong {
        message: format!("pong: {}", message.as_deref().unwrap_or("(none)")),
        ping_count: count,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            ping_count: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
