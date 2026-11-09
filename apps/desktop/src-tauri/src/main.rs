// Prevent console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Глобальные медиа-клавиши → события во фронтенд (плеер их слушает).
fn media_shortcuts(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let shortcuts = [
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
            "media:play-pause",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowRight),
            "media:next",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::ArrowLeft),
            "media:prev",
        ),
    ];

    for (shortcut, event) in shortcuts {
        let app_handle = app.clone();
        app.global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, press| {
                if press.state() == ShortcutState::Pressed {
                    let _ = app_handle.emit(event, ());
                }
            })?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            if let Err(error) = media_shortcuts(app.handle()) {
                eprintln!("global shortcuts: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vision Audio");
}
