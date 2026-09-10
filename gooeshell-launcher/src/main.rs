#![cfg_attr(not(test), windows_subsystem = "windows")]

use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn launch() -> Result<(), Box<dyn std::error::Error>> {
    let executable = std::env::current_exe()?;
    let root = executable
        .parent()
        .ok_or("Cannot locate application directory")?;
    let config = root.join("gooeshell").join("gooeshell.lua");
    let gui = root.join(if cfg!(windows) {
        "wezterm-gui.exe"
    } else {
        "wezterm-gui"
    });
    if !config.is_file() || !gui.is_file() {
        return Err("程序文件不完整。请完整解压 gooeshell 压缩包，再双击 gooeshell.exe。".into());
    }
    let data = root.join("gooeshell").join("data");
    std::fs::create_dir_all(&data)?;
    let id = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary_hosts = data.join(format!("session-{}-{id}.known_hosts", std::process::id()));
    std::fs::write(&temporary_hosts, b"")?;
    let mut cmd = Command::new(gui);
    cmd.arg("--config-file")
        .arg(config)
        .arg("start")
        .arg("--always-new-process")
        .env("GOOESHELL_DATA_DIR", &data)
        .env("GOOESHELL_BIN_DIR", root)
        .env("GOOESHELL_SESSION_KNOWN_HOSTS", &temporary_hosts);
    // Keep the user's home as the initial local shell directory.
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        if Path::new(&home).is_dir() {
            cmd.current_dir(home);
        }
    }
    let result = cmd.status();
    // Only remove the exact transient file created by this invocation.
    let _ = std::fs::remove_file(&temporary_hosts);
    // OpenSSH may keep the previous revision beside its known-hosts file.
    let mut backup = temporary_hosts.as_os_str().to_os_string();
    backup.push(".old");
    let _ = std::fs::remove_file(Path::new(&backup));
    let status = result?;
    if !status.success() {
        return Err(
            format!("终端启动失败（{status}）。请查看 gooeshell 日志或重新解压程序。").into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn display_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }
    let text: Vec<u16> = std::ffi::OsStr::new(message)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let title: Vec<u16> = "gooeshell".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10);
    }
}

#[cfg(not(windows))]
fn display_error(message: &str) {
    eprintln!("gooeshell: {message}");
}

fn main() {
    if let Err(error) = launch() {
        display_error(&error.to_string());
        std::process::exit(1);
    }
}
