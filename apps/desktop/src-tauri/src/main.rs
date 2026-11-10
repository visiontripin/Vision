// Prevent console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Пункт «Играть/Пауза» в трее: текст обновляется из фронтенда (команда `player_state`).
struct TrayMenu {
    play_pause: MenuItem<tauri::Wry>,
}

/// Показать окно из трея: свернуть в трей — штатное закрытие окна.
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

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

/// Трей: воспроизведение, переключение треков, показ окна и выход.
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let play_pause = MenuItem::with_id(app, "play-pause", "Играть/Пауза", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Предыдущий", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующий", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Показать окно", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &play_pause,
            &prev,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    app.manage(TrayMenu {
        play_pause: play_pause.clone(),
    });

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Vision Audio")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "play-pause" => {
                let _ = app.emit("media:play-pause", ());
            }
            "prev" => {
                let _ = app.emit("media:prev", ());
            }
            "next" => {
                let _ = app.emit("media:next", ());
            }
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

/// Состояние плеера из фронтенда: подпись пункта меню и подсказка в трее.
#[tauri::command]
fn player_state(
    app: tauri::AppHandle,
    menu: tauri::State<'_, TrayMenu>,
    playing: bool,
    title: Option<String>,
    artist: Option<String>,
) {
    let _ = menu.play_pause.set_text(if playing { "Пауза" } else { "Играть" });

    let label = match (title.as_deref(), artist.as_deref()) {
        (Some(title), Some(artist)) if !artist.is_empty() => format!("{title} — {artist}"),
        (Some(title), _) => title.to_string(),
        _ => "Ничего не играет".to_string(),
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(format!("Vision Audio · {label}")));
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![player_state])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            if let Err(error) = setup_tray(app.handle()) {
                eprintln!("tray: {error}");
            }
            if let Err(error) = media_shortcuts(app.handle()) {
                eprintln!("global shortcuts: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // закрытие окна сворачивает приложение в трей; выход — только из меню трея
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Vision Audio");
}
