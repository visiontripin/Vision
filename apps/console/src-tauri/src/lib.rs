//! Vision Server — запуск сервера и админка.
//!
//! Одна оболочка на две платформы: окно Windows и приложение Android. Сама
//! панель — обычная веб-сборка (`apps/console/dist`), внутри неё только HTTP к
//! API. Здесь — то, чего не умеет браузер: подсказки и подготовка «сервер на
//! этом устройстве».
//!
//! Запускать Node из-под оболочки мы намеренно не пытаемся: на Windows сервер
//! ставят отдельным шагом (Termux на Android, служба/`npm start` на ПК), и
//! приложение лишь проверяет, что он отвечает, и объясняет, что делать.

use serde::Serialize;

/// Платформа, на которой открыта панель: подсказки на экране подключения.
#[derive(Serialize)]
pub struct Platform {
    /// windows | android | linux | macos
    os: &'static str,
    /// Подсказка «где обычно живёт сервер» для этой платформы.
    hint: &'static str,
}

#[tauri::command]
fn platform() -> Platform {
    let os = std::env::consts::OS;
    let hint = match os {
        "android" => "Сервер в Termux: введите адрес телефона и порт 4000, например 192.168.1.10:4000",
        "windows" => "Сервер на этом ПК: http://127.0.0.1:4000. На другой машине — её адрес в Wi-Fi",
        _ => "Укажите адрес сервера: host:4000 в локальной сети или HTTPS-туннель",
    };
    Platform { os, hint }
}

/// Точка входа для мобильных платформ (Android): `tauri android build` ищет
/// символ `mobile_entry_point` в библиотеке и без него отказывается упаковывать
/// APK. На Windows/Linux этот код не собирается — там `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![platform])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Vision Server");
}
