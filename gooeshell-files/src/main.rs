#[cfg(test)]
mod integration_tests;
mod model;
mod transfer;
mod ui;

use anyhow::{bail, Context, Result};
use base64::Engine;
use clap::Parser;
use model::{human_bytes, remote_basename, remote_join, remote_parent};
use ssh2::{CheckResult, FileStat, HashType, KnownHostFileKind, Session, Sftp};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::Duration;
use termwiz::caps::Capabilities;
use termwiz::input::{InputEvent, KeyCode, KeyEvent, Modifiers, MouseButtons};
use termwiz::terminal::{new_terminal, Terminal};
use ui::Ui;

#[derive(Parser, Debug)]
#[command(
    name = "gooeshell-files",
    version,
    about = "gooeshell 独立 SFTP 文件面板"
)]
struct Args {
    #[arg(long)]
    host: String,
    #[arg(long)]
    user: String,
    #[arg(long, default_value_t = 22)]
    port: u16,
    #[arg(long)]
    identity: Option<PathBuf>,
    #[arg(long, default_value = ".")]
    path: String,
}

fn known_hosts_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("GOOESHELL_KNOWN_HOSTS") {
        return Ok(PathBuf::from(path));
    }
    let directory = std::env::var_os("GOOESHELL_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs_next::data_local_dir().map(|p| p.join("gooeshell")))
        .context("无法确定 gooeshell 数据目录")?;
    Ok(directory.join("known_hosts"))
}

fn verify_host<T: Terminal>(ui: &mut Ui<T>, session: &Session, args: &Args) -> Result<()> {
    let path = known_hosts_path()?;
    let mut known = session.known_hosts()?;
    if path.try_exists()? {
        known
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .context("读取主机指纹文件失败；未发送登录凭据")?;
    }
    let (key, key_type) = session.host_key().context("服务器未提供主机密钥")?;
    match known.check_port(&args.host, args.port, key) {
        CheckResult::Match => return Ok(()),
        CheckResult::Mismatch => bail!("主机指纹与已保存记录不一致，已停止连接；未发送登录凭据"),
        CheckResult::Failure => bail!("主机指纹校验失败；未发送登录凭据"),
        CheckResult::NotFound => {}
    }
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .context("无法计算 SHA256 指纹")?;
    let fingerprint = base64::engine::general_purpose::STANDARD_NO_PAD.encode(fingerprint);
    let lines = vec![
        (format!("{}:{}", args.host, args.port), false),
        (format!("{key_type:?} SHA256 指纹："), false),
        (fingerprint[..22].to_string(), false),
        (fingerprint[22..].to_string(), false),
        ("首次连接，请核对服务器指纹。".into(), false),
        ("O 仅本次信任，不写入文件".into(), false),
        ("S 信任并保存到此连接的指纹文件".into(), false),
        (format!("指纹文件：{}", path.display()), false),
    ];
    loop {
        ui.draw("主机身份验证", &lines, "O 本次 · S 保存 · Esc 拒绝")?;
        match ui.terminal.poll_input(None)? {
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('o' | 'O'),
                ..
            })) => return Ok(()),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('s' | 'S'),
                ..
            })) => {
                let host = if args.port == 22 {
                    args.host.clone()
                } else {
                    format!("[{}]:{}", args.host, args.port)
                };
                // Re-read immediately before writing to preserve other pane additions.
                let mut saved = session.known_hosts()?;
                if path.try_exists()? {
                    saved.read_file(&path, KnownHostFileKind::OpenSSH)?;
                }
                match saved.check_port(&args.host, args.port, key) {
                    CheckResult::Mismatch | CheckResult::Failure => {
                        bail!("保存期间指纹记录发生变化，请重新连接核对")
                    }
                    _ => {}
                }
                saved.add(&host, key, "gooeshell", key_type.into())?;
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                saved.write_file(&path, KnownHostFileKind::OpenSSH)?;
                return Ok(());
            }
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Escape | KeyCode::Char('n' | 'N'),
                ..
            })) => bail!("已拒绝信任服务器"),
            _ => {}
        }
    }
}

fn connect<T: Terminal>(ui: &mut Ui<T>, args: &Args) -> Result<(Session, Sftp)> {
    if args.host.trim().is_empty() || args.user.trim().is_empty() || args.port == 0 {
        bail!("主机、用户名不能为空，端口必须有效");
    }
    ui.draw(
        "连接文件服务",
        &[(format!("{}@{}:{}", args.user, args.host, args.port), false)],
        "独立 SSH 连接 · 不影响终端连接",
    )?;
    let addresses = (args.host.as_str(), args.port)
        .to_socket_addrs()
        .context("解析主机名失败")?;
    let mut connected = None;
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(10)) {
            Ok(stream) => {
                connected = Some(stream);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let stream = connected.ok_or_else(|| anyhow::anyhow!("连接服务器失败：{:?}", last_error))?;
    stream.set_nodelay(true)?;
    let mut session = Session::new()?;
    session.set_tcp_stream(stream);
    session.set_timeout(10_000);
    session.handshake().context("SSH 握手失败")?;
    verify_host(ui, &session, args)?;
    if let Some(identity) = &args.identity {
        if !identity.is_file() {
            bail!("私钥文件不存在：{}", identity.display())
        }
        if session
            .userauth_pubkey_file(&args.user, None, identity, None)
            .is_err()
        {
            let passphrase = ui
                .prompt("私钥口令（无回显）", "", true)?
                .context("已取消认证")?;
            session
                .userauth_pubkey_file(&args.user, None, identity, Some(&passphrase))
                .context("公钥认证失败")?;
        }
    } else {
        let _ = session.userauth_agent(&args.user);
        if !session.authenticated() {
            let password = ui
                .prompt("登录密码（无回显）", "", true)?
                .context("已取消认证")?;
            session
                .userauth_password(&args.user, &password)
                .context("密码认证失败")?;
        }
    }
    if !session.authenticated() {
        bail!("服务器未完成身份认证")
    }
    let sftp = session.sftp().context("服务器无法开启 SFTP 子系统")?;
    Ok((session, sftp))
}

#[derive(Clone)]
struct Entry {
    path: String,
    stat: FileStat,
}

fn list_directory(sftp: &Sftp, path: &str) -> Result<(String, Vec<Entry>)> {
    let canonical = sftp.realpath(Path::new(path))?;
    let canonical = canonical
        .to_str()
        .context("首版只支持 UTF-8 远程路径")?
        .to_string();
    let mut entries = Vec::new();
    // Do not use Sftp::readdir, which joins POSIX names using Windows Path::join.
    let mut directory = sftp.opendir(Path::new(&canonical))?;
    loop {
        match directory.readdir() {
            Ok((name, stat)) => {
                let name = name
                    .to_str()
                    .context("目录包含非 UTF-8 文件名，首版暂不支持")?;
                if name == "." || name == ".." {
                    continue;
                }
                if name.contains('/') || name.contains('\0') {
                    bail!("服务器返回了无效的目录条目");
                }
                entries.push(Entry {
                    path: remote_join(&canonical, name)?,
                    stat,
                });
            }
            Err(error)
                if error.code() == ssh2::ErrorCode::Session(libssh2_sys::LIBSSH2_ERROR_FILE) =>
            {
                break
            }
            Err(error) => return Err(error.into()),
        }
    }
    entries.sort_by(|a, b| {
        b.stat
            .is_dir()
            .cmp(&a.stat.is_dir())
            .then_with(|| a.path.to_lowercase().cmp(&b.path.to_lowercase()))
    });
    Ok((canonical, entries))
}

fn browse<T: Terminal>(ui: &mut Ui<T>, sftp: &Sftp, args: &Args) -> Result<()> {
    let (mut path, mut entries) = list_directory(sftp, &args.path)?;
    let mut selected = 0usize;
    let mut top = 0usize;
    loop {
        let available = ui.rows().saturating_sub(5).max(1);
        selected = selected.min(entries.len().saturating_sub(1));
        if selected < top {
            top = selected;
        }
        if selected >= top + available {
            top = selected + 1 - available;
        }
        let mut lines = vec![
            (path.clone(), false),
            (
                format!("{} 项 · U 上传 / D 下载 / G 路径 / R 刷新", entries.len()),
                false,
            ),
        ];
        for (index, entry) in entries.iter().enumerate().skip(top).take(available) {
            let marker = if entry.stat.is_dir() {
                "[目录]"
            } else if entry.stat.file_type().is_symlink() {
                "[链接]"
            } else {
                "      "
            };
            let size = if entry.stat.is_dir() {
                String::new()
            } else {
                human_bytes(entry.stat.size.unwrap_or(0))
            };
            lines.push((
                format!("{marker} {}  {size}", remote_basename(&entry.path)),
                index == selected,
            ));
        }
        if entries.is_empty() {
            lines.push(("目录为空".into(), false));
        }
        ui.draw(
            &format!("gooeshell 文件 · {}@{}", args.user, args.host),
            &lines,
            "↑↓ 选择 · Enter 打开 · Backspace 上级 · Q 关闭",
        )?;
        let mut next_path = None;
        match ui.terminal.poll_input(None)? {
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('q') | KeyCode::Escape,
                ..
            })) => return Ok(()),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::UpArrow,
                ..
            })) => selected = selected.saturating_sub(1),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::DownArrow,
                ..
            })) => selected = (selected + 1).min(entries.len().saturating_sub(1)),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::PageUp,
                ..
            })) => selected = selected.saturating_sub(available),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::PageDown,
                ..
            })) => selected = (selected + available).min(entries.len().saturating_sub(1)),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Backspace,
                ..
            })) => next_path = Some(remote_parent(&path)),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Enter,
                ..
            })) => {
                if let Some(entry) = entries.get(selected) {
                    if entry.stat.is_dir() || entry.stat.file_type().is_symlink() {
                        next_path = Some(entry.path.clone());
                    } else {
                        ui.message(
                            "文件信息",
                            &format!(
                                "{}\n大小：{}\n按 D 下载到本地",
                                entry.path,
                                human_bytes(entry.stat.size.unwrap_or(0))
                            ),
                        )?;
                    }
                }
            }
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('c'),
                modifiers,
            })) if modifiers.contains(Modifiers::CTRL) => return Ok(()),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('r' | 'R'),
                modifiers,
            })) if !modifiers.contains(Modifiers::CTRL) => next_path = Some(path.clone()),
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('g' | 'G'),
                ..
            })) => {
                if let Some(input) = ui.prompt("远程路径", &path, false)? {
                    match remote_join(&path, &input) {
                        Ok(next) => next_path = Some(next),
                        Err(error) => ui.message("路径无效", &error.to_string())?,
                    }
                }
            }
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('d' | 'D'),
                ..
            })) => {
                if let Some(entry) = entries.get(selected) {
                    let default = dirs_next::download_dir()
                        .or_else(dirs_next::home_dir)
                        .unwrap_or_default()
                        .join(remote_basename(&entry.path));
                    if let Some(local) =
                        ui.prompt("保存到本地完整路径", &default.display().to_string(), false)?
                    {
                        if let Err(error) = transfer::download(
                            ui,
                            sftp,
                            &entry.path,
                            Path::new(local.trim_matches('"')),
                        ) {
                            ui.message("下载未完成", &format!("{error:#}"))?;
                        }
                    }
                }
            }
            Some(InputEvent::Key(KeyEvent {
                key: KeyCode::Char('u' | 'U'),
                ..
            })) => {
                if let Some(local) = ui.prompt("本地文件完整路径", "", false)? {
                    let source = PathBuf::from(local.trim_matches('"'));
                    if let Some(name) = source.file_name().and_then(|n| n.to_str()) {
                        let default = remote_join(&path, name)?;
                        if let Some(destination) = ui.prompt("远程目标完整路径", &default, false)?
                        {
                            match remote_join(&path, &destination) {
                                Ok(destination) => {
                                    if let Err(error) =
                                        transfer::upload(ui, sftp, &source, &destination)
                                    {
                                        ui.message("上传未完成", &format!("{error:#}"))?;
                                    }
                                }
                                Err(error) => ui.message("路径无效", &error.to_string())?,
                            }
                            next_path = Some(path.clone());
                        }
                    } else {
                        ui.message("路径无效", "请输入一个本地文件的完整路径")?;
                    }
                }
            }
            Some(InputEvent::Mouse(event))
                if event.mouse_buttons.contains(MouseButtons::LEFT) && event.y >= 4 =>
            {
                let index = top + event.y as usize - 4;
                if index < entries.len() {
                    selected = index;
                }
            }
            _ => {}
        }
        if let Some(next) = next_path {
            match list_directory(sftp, &next) {
                Ok((new_path, new_entries)) => {
                    path = new_path;
                    entries = new_entries;
                    selected = 0;
                    top = 0;
                }
                Err(error) => ui.message("无法读取目录", &format!("{error:#}"))?,
            }
        }
    }
}

fn main() -> Result<()> {
    let args = Args::parse();
    let terminal = new_terminal(Capabilities::new_from_env()?)?;
    let mut ui = Ui::new(terminal)?;
    let result = (|| {
        let (_session, sftp) = connect(&mut ui, &args)?;
        browse(&mut ui, &sftp, &args)
    })();
    if let Err(error) = &result {
        ui.message("文件连接未完成", &format!("{error:#}"))?;
    }
    result
}
