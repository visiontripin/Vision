//! Vision Server — отдельная Windows-админка для домашнего API.
//!
//! На Windows установщик регистрирует собственную службу `VisionServer` с
//! автоматическим запуском. Служба запускает поставляемый Node.js API отдельным
//! процессом; Tauri управляет службой через Windows Service Control Manager.
//! Мобильный плеер остаётся клиентом внешнего API.

use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const DEFAULT_PORT: u16 = 4000;
const SERVICE_NAME: &str = "VisionServer";
const LOG_TAIL_BYTES: u64 = 128 * 1024;
const LOG_TAIL_LINES: usize = 180;
const SERVICE_WAIT: Duration = Duration::from_secs(30);
const API_START_WAIT: Duration = Duration::from_secs(20);

/// Платформа, на которой открыта панель: подсказки на экране подключения.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
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
        "android" => "Сервер устанавливается отдельно в Termux: введите адрес телефона и порт 4000",
        "windows" => "Vision Server управляет собственной Windows-службой; телефоны подключаются по локальному IPv4",
        _ => "Укажите адрес отдельно установленного сервера: host:4000 в локальной сети или HTTPS-туннель",
    };
    Platform { os, hint }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedServerStatus {
    supported: bool,
    running: bool,
    managed: bool,
    owner_configured: bool,
    port: u16,
    base_url: String,
    data_dir: String,
    log_path: String,
    message: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct SavedManagerConfig {
    port: u16,
}

/// Для установленной службы данные общие для машины и остаются после обновления.
fn app_data_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let program_data = env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        Ok(program_data.join("VisionServer"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        _app.path()
            .app_local_data_dir()
            .map_err(|error| format!("Не удалось найти локальный каталог Vision Server: {error}"))
    }
}

fn server_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("data"))
}

fn server_logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("logs"))
}

fn manager_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("server-manager.json"))
}

fn saved_port(app: &AppHandle) -> u16 {
    let Ok(path) = manager_config_path(app) else {
        return DEFAULT_PORT;
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<SavedManagerConfig>(&text).ok())
        .map(|config| config.port)
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_PORT)
}

fn save_port(app: &AppHandle, port: u16) -> Result<(), String> {
    let path = manager_config_path(app)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Не удалось определить каталог настроек службы".to_string())?;
    fs::create_dir_all(dir).map_err(|error| format!("Не удалось создать {dir:?}: {error}"))?;
    let contents = serde_json::to_vec(&SavedManagerConfig { port })
        .map_err(|error| format!("Не удалось сериализовать порт сервера: {error}"))?;
    fs::write(&path, contents)
        .map_err(|error| format!("Не удалось сохранить настройки службы {path:?}: {error}"))
}

fn server_layout(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(resources) = app.path().resource_dir() {
            // Tauri обычно кладёт bundled resources прямо в resource_dir; второй
            // вариант покрывает layout, где упаковщик добавляет подкаталог resources.
            for base in [resources.clone(), resources.join("resources")] {
                let root = base.join("server");
                let node = base.join("node").join("node.exe");
                let entry = root.join("services").join("api").join("src").join("start.js");
                let admin_index = root.join("apps").join("console").join("dist").join("index.html");
                let service_exe = root
                    .join("service")
                    .join("VisionServer.exe");
                let service_xml = root
                    .join("service")
                    .join("VisionServer.xml");
                let service_exe_config = root
                    .join("service")
                    .join("VisionServer.exe.config");
                let ffmpeg = root.join("bin").join("ffmpeg.exe");
                if node.is_file()
                    && entry.is_file()
                    && admin_index.is_file()
                    && service_exe.is_file()
                    && service_xml.is_file()
                    && service_exe_config.is_file()
                    && ffmpeg.is_file()
                {
                    return Ok(());
                }
            }
        }

        Err("Не найдены ресурсы Windows-службы. Переустановите Vision Server из полного установщика.".into())
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Управление локальной службой доступно только в Windows-версии Vision Server.".into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsServiceState {
    Missing,
    Stopped,
    StartPending,
    StopPending,
    Running,
}

#[cfg(target_os = "windows")]
fn sc_executable() -> PathBuf {
    env::var_os("WINDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("sc.exe")
}

#[cfg(target_os = "windows")]
fn run_sc(args: &[&str]) -> Result<String, String> {
    let output = Command::new(sc_executable())
        .args(args)
        .output()
        .map_err(|error| format!("Не удалось запустить Windows Service Control: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = format!("{}{}", stdout.trim(), if stderr.trim().is_empty() { String::new() } else { format!("\n{}", stderr.trim()) });
    if output.status.success() {
        Ok(message)
    } else {
        Err(if message.is_empty() {
            format!("Команда sc.exe {:?} завершилась с кодом {:?}.", args, output.status.code())
        } else {
            message
        })
    }
}

#[cfg(target_os = "windows")]
fn windows_service_state() -> Result<WindowsServiceState, String> {
    let output = Command::new(sc_executable())
        .args(["query", SERVICE_NAME])
        .output()
        .map_err(|error| format!("Не удалось проверить Windows-службу: {error}"))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if text.contains("1060") {
        return Ok(WindowsServiceState::Missing);
    }
    if !output.status.success() {
        return Err(format!("Не удалось прочитать состояние службы {SERVICE_NAME}: {}", text.trim()));
    }
    let state_code = text
        .lines()
        .find(|line| line.trim_start().starts_with("STATE"))
        .and_then(|line| line.split(':').nth(1))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| format!("Windows вернула неизвестное состояние службы: {}", text.trim()))?;
    match state_code {
        1 => Ok(WindowsServiceState::Stopped),
        2 | 5 => Ok(WindowsServiceState::StartPending),
        3 | 6 => Ok(WindowsServiceState::StopPending),
        4 => Ok(WindowsServiceState::Running),
        _ => Ok(WindowsServiceState::Stopped),
    }
}

#[cfg(not(target_os = "windows"))]
fn windows_service_state() -> Result<WindowsServiceState, String> {
    Ok(WindowsServiceState::Missing)
}

fn service_is_running(state: WindowsServiceState) -> bool {
    matches!(
        state,
        WindowsServiceState::Running
            | WindowsServiceState::StartPending
            | WindowsServiceState::StopPending
    )
}

fn local_api_request(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(400))
        .map_err(|error| format!("Не удалось подключиться к локальному Vision API на порту {port}: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|error| format!("Не удалось настроить локальное соединение: {error}"))?;
    let body = body.unwrap_or("");
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n"
    );
    if let Some(token) = token {
        if token.contains('\r') || token.contains('\n') {
            return Err("Некорректный токен владельца.".into());
        }
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if body.is_empty() {
        request.push_str("Content-Length: 0\r\n\r\n");
    } else {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.as_bytes().len()
        ));
        request.push_str(body);
    }
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Не удалось отправить запрос локальному Vision API: {error}"))?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("Не удалось прочитать ответ локального Vision API: {error}"))?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Локальный Vision API вернул некорректный HTTP-ответ.".to_string())?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "Локальный Vision API вернул неизвестный HTTP-статус.".to_string())?;
    let response_body = String::from_utf8_lossy(&response[header_end + 4..]).into_owned();
    Ok((status, response_body))
}

fn api_is_healthy(port: u16) -> bool {
    matches!(local_api_request(port, "GET", "/api/health", None, None), Ok((200, _)))
}

fn owner_is_configured(port: u16) -> Option<bool> {
    let (status, body) = local_api_request(port, "GET", "/api/setup", None, None).ok()?;
    if status != 200 {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()?
        .get("configured")
        .and_then(serde_json::Value::as_bool)
}

fn initialize_owner_password(port: u16, password: &str) -> Result<(), String> {
    let body = serde_json::json!({ "password": password }).to_string();
    let (status, response) = local_api_request(port, "POST", "/api/setup", None, Some(&body))?;
    match status {
        201 | 409 => Ok(()), // 409 means it was configured before this window opened.
        _ => {
            let detail = serde_json::from_str::<serde_json::Value>(&response)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")?
                        .get("message")?
                        .as_str()
                        .map(|message| message.to_string())
                })
                .unwrap_or_else(|| response.trim().to_string());
            Err(format!("Не удалось настроить пароль владельца ({status}): {detail}"))
        }
    }
}

fn api_start_error(app: &AppHandle, port: u16) -> String {
    let logs = read_service_logs(app);
    let detail = if logs.is_empty() {
        "Журнал службы пока пуст.".to_string()
    } else {
        format!("Последние строки журнала:\n{logs}")
    };
    format!(
        "Vision API не ответил на порту {port} за 20 секунд. Проверьте службу и журнал.\n{detail}"
    )
}

fn wait_for_api(app: &AppHandle, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + API_START_WAIT;
    while Instant::now() < deadline {
        if api_is_healthy(port) {
            return Ok(());
        }
        let state = windows_service_state()?;
        if matches!(state, WindowsServiceState::Missing | WindowsServiceState::Stopped) {
            return Err(api_start_error(app, port));
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(api_start_error(app, port))
}

fn wait_for_service_stopped() -> Result<(), String> {
    let deadline = Instant::now() + SERVICE_WAIT;
    while Instant::now() < deadline {
        if matches!(windows_service_state()?, WindowsServiceState::Missing | WindowsServiceState::Stopped) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err("Windows-служба Vision Server не остановилась за 30 секунд.".into())
}

fn read_service_logs(app: &AppHandle) -> String {
    let Ok(dir) = server_logs_dir(app) else {
        return String::new();
    };
    let candidates = [
        "VisionServer.out.log",
        "VisionServer.err.log",
        "VisionServer.wrapper.log",
        "VisionServerService.out.log",
        "VisionServerService.err.log",
        "VisionServerService.wrapper.log",
    ];
    let mut parts = Vec::new();
    for name in candidates {
        let path = dir.join(name);
        let tail = tail_log_file(&path);
        if !tail.is_empty() {
            parts.push(format!("--- {name} ---\n{tail}"));
        }
    }
    parts.join("\n\n")
}

fn make_status(
    app: &AppHandle,
    supported: bool,
    running: bool,
    managed: bool,
    owner_configured: bool,
    port: u16,
    message: Option<String>,
) -> ManagedServerStatus {
    let data_dir = server_data_dir(app).unwrap_or_default();
    let log_path = server_logs_dir(app).unwrap_or_default();
    ManagedServerStatus {
        supported,
        running,
        managed,
        owner_configured,
        port,
        base_url: format!("http://127.0.0.1:{port}"),
        data_dir: data_dir.to_string_lossy().into_owned(),
        log_path: log_path.to_string_lossy().into_owned(),
        message,
    }
}

#[tauri::command]
fn managed_server_status(app: AppHandle) -> Result<ManagedServerStatus, String> {
    let port = saved_port(&app);
    if let Err(message) = server_layout(&app) {
        return Ok(make_status(&app, false, false, false, false, port, Some(message)));
    }
    let service = windows_service_state()?;
    if service == WindowsServiceState::Missing {
        return Ok(make_status(
            &app,
            true,
            false,
            false,
            false,
            port,
            Some("Служба не установлена. Повторно запустите Vision Server Setup от имени администратора.".into()),
        ));
    }
    let running = service_is_running(service);
    let healthy = running && api_is_healthy(port);
    let owner_configured = healthy && owner_is_configured(port).unwrap_or(false);
    let message = if running && !healthy {
        Some("Служба запущена, но локальный API ещё не отвечает. Откройте журнал службы или обновите состояние через несколько секунд.".into())
    } else if healthy && !owner_configured {
        Some("Первый запуск: задайте пароль владельца, чтобы открыть сервер для домашней сети.".into())
    } else {
        None
    };
    Ok(make_status(
        &app,
        true,
        running,
        true,
        owner_configured,
        port,
        message,
    ))
}

#[tauri::command]
fn start_managed_server(
    app: AppHandle,
    password: String,
    port: u16,
) -> Result<ManagedServerStatus, String> {
    if !(1..=65535).contains(&port) {
        return Err("Порт должен быть числом от 1 до 65535.".into());
    }
    let password = password.trim();
    let password_length = password.chars().count();
    if password_length < 12 {
        return Err("Задайте пароль владельца не короче 12 символов.".into());
    }
    if password_length > 256 {
        return Err("Пароль слишком длинный (максимум 256 символов).".into());
    }
    server_layout(&app)?;

    #[cfg(target_os = "windows")]
    {
        let service = windows_service_state()?;
        if service == WindowsServiceState::Missing {
            return Err("Windows-служба Vision Server не установлена. Запустите официальный установщик от имени администратора.".into());
        }
        let old_port = saved_port(&app);
        if service_is_running(service) && old_port != port {
            stop_windows_service(None, old_port)?;
        }
        save_port(&app, port)?;
        let state = windows_service_state()?;
        if state == WindowsServiceState::Stopped {
            run_sc(&["start", SERVICE_NAME]).map_err(|error| {
                format!("Не удалось запустить службу Vision Server. Проверьте права или запустите приложение от имени администратора: {error}")
            })?;
        }
        wait_for_api(&app, port)?;
        if owner_is_configured(port).is_none() {
            return Err("Vision API отвечает, но первичная настройка недоступна. Проверьте журнал службы и обновите Vision Server.".into());
        }
        if owner_is_configured(port) == Some(false) {
            initialize_owner_password(port, password)?;
        }
        let service = windows_service_state()?;
        let configured = owner_is_configured(port).unwrap_or(false);
        return Ok(make_status(
            &app,
            true,
            service_is_running(service),
            true,
            configured,
            port,
            None,
        ));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (password, port);
        Err("Управление локальной службой доступно только в Windows-версии Vision Server.".into())
    }
}

#[cfg(target_os = "windows")]
fn stop_windows_service(token: Option<&str>, port: u16) -> Result<(), String> {
    let mut state = windows_service_state()?;
    if matches!(state, WindowsServiceState::Missing | WindowsServiceState::Stopped) {
        return Ok(());
    }
    if let Some(token) = token {
        let _ = local_api_request(port, "POST", "/api/shutdown", Some(token), Some("{}"));
        let graceful_deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < graceful_deadline {
            state = windows_service_state()?;
            if state == WindowsServiceState::Stopped || state == WindowsServiceState::Missing {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }
    state = windows_service_state()?;
    if matches!(state, WindowsServiceState::Missing | WindowsServiceState::Stopped) {
        return Ok(());
    }
    if let Err(error) = run_sc(&["stop", SERVICE_NAME]) {
        let after_error = windows_service_state()?;
        if matches!(after_error, WindowsServiceState::Missing | WindowsServiceState::Stopped) {
            return Ok(());
        }
        return Err(format!(
            "Не удалось остановить службу Vision Server. Проверьте права на управление службой: {error}"
        ));
    }
    wait_for_service_stopped()
}

#[tauri::command]
fn stop_managed_server(app: AppHandle, token: Option<String>) -> Result<ManagedServerStatus, String> {
    let port = saved_port(&app);
    let layout = server_layout(&app);
    let supported = layout.is_ok();
    #[cfg(target_os = "windows")]
    {
        let state = windows_service_state()?;
        if state == WindowsServiceState::Missing {
            return Ok(make_status(
                &app,
                supported,
                false,
                false,
                false,
                port,
                Some("Windows-служба Vision Server не установлена.".into()),
            ));
        }
        stop_windows_service(token.as_deref(), port)?;
        return Ok(make_status(
            &app,
            supported,
            false,
            true,
            false,
            port,
            None,
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = token;
        Ok(make_status(
            &app,
            supported,
            false,
            false,
            false,
            port,
            Some("Управление локальной службой доступно только в Windows.".into()),
        ))
    }
}

fn tail_log_file(path: &std::path::Path) -> String {
    let Ok(mut file) = OpenOptions::new().read(true).open(path) else {
        return String::new();
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return String::new();
    };
    let start = length.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::with_capacity((length - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return String::new();
    }
    let decoded = String::from_utf8_lossy(&bytes);
    let text = if start > 0 {
        decoded.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        decoded.as_ref()
    };
    let lines: Vec<&str> = text.lines().collect();
    let tail_start = lines.len().saturating_sub(LOG_TAIL_LINES);
    lines[tail_start..].join("\n")
}

#[tauri::command]
fn read_managed_server_logs(app: AppHandle) -> Result<String, String> {
    Ok(read_service_logs(&app))
}

/// Точка входа для мобильных платформ: Android-версия панели не запускает сервер.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            platform,
            managed_server_status,
            start_managed_server,
            stop_managed_server,
            read_managed_server_logs,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Vision Server");
}

#[cfg(test)]
mod tests {
    use super::tail_log_file;
    use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

    #[test]
    fn log_tail_is_bounded_to_recent_bytes_and_lines() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = PathBuf::from(std::env::temp_dir())
            .join(format!("vision-server-log-{unique}.log"));
        let content = (0..500)
            .map(|index| format!("line-{index:03} {}\n", "x".repeat(1024)))
            .collect::<String>();
        fs::write(&path, content).unwrap();
        let tail = tail_log_file(&path);
        let lines: Vec<&str> = tail.lines().collect();
        assert!(tail.len() <= 128 * 1024);
        assert!(lines.len() <= 180);
        assert!(lines.last().unwrap().starts_with("line-499"));
        assert!(!tail.contains("line-000"));
        fs::remove_file(path).unwrap();
    }
}
