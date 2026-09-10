use crate::model::{compare_prefix, remote_basename, CHUNK};
use crate::ui::Ui;
use anyhow::{bail, Context, Result};
use ssh2::{ErrorCode, FileStat, OpenFlags, OpenType, RenameFlags, Sftp};
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use termwiz::terminal::Terminal;

fn remote_stat(sftp: &Sftp, path: &str) -> Result<Option<FileStat>> {
    match sftp.lstat(Path::new(path)) {
        Ok(stat) => Ok(Some(stat)),
        Err(error) if error.code() == ErrorCode::SFTP(2) => Ok(None),
        Err(error) => Err(error).context("读取远程文件属性失败"),
    }
}

fn ensure_source_unchanged(before: &FileStat, after: &FileStat) -> Result<()> {
    if before.size != after.size || before.mtime != after.mtime {
        bail!("源文件在传输期间发生变化；保留 .part 文件，未发布目标文件");
    }
    Ok(())
}

fn local_part_path(destination: &Path) -> PathBuf {
    let mut part = destination.as_os_str().to_os_string();
    part.push(".gooeshell.part");
    part.into()
}

pub fn download<T: Terminal>(ui: &mut Ui<T>, sftp: &Sftp, source: &str, destination: &Path) -> Result<()> {
    if destination.try_exists()? {
        bail!("目标文件已存在，请选择另一个保存路径（首版不覆盖已有文件）");
    }
    let before = sftp.stat(Path::new(source))?;
    if !before.is_file() {
        bail!("当前仅支持传输普通文件");
    }
    let total = before.size.context("服务器没有提供文件大小")?;
    let part = local_part_path(destination);
    let partial = match fs::symlink_metadata(&part) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                bail!(".part 路径不是普通文件，拒绝写入");
            }
            let length = metadata.len();
            if length > total {
                bail!("已有 .part 比源文件更大，请改用新保存路径");
            }
            if !ui.confirm("发现未完成的下载", &[
                part.display().to_string(),
                "先逐字节校验已有内容，再继续传输。".into(),
                "完整校验会额外读取远程文件；不匹配时保留原文件。".into(),
            ])? { return Ok(()) }
            length
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    let exists = part.try_exists()?;
    let mut local = if exists {
        OpenOptions::new().read(true).write(true).open(&part)?
    } else {
        OpenOptions::new().read(true).write(true).create_new(true).open(&part)?
    };
    let mut remote = sftp.open(Path::new(source))?;
    compare_prefix(&mut remote, &mut local, partial, |n| ui.progress("校验已有下载内容", n, partial))?;
    remote.seek(SeekFrom::Start(partial))?;
    local.seek(SeekFrom::Start(partial))?;
    let mut copied = partial;
    let mut buffer = [0u8; CHUNK];
    while copied < total {
        ui.progress("下载中", copied, total)?;
        let wanted = (total - copied).min(CHUNK as u64) as usize;
        let count = remote.read(&mut buffer[..wanted])?;
        if count == 0 { bail!("源文件提前结束；保留 .part 文件") }
        local.write_all(&buffer[..count])?;
        copied += count as u64;
    }
    local.sync_all()?;
    ensure_source_unchanged(&before, &sftp.stat(Path::new(source))?)?;
    // Read back both sides before publishing, including any resumed prefix.
    local.seek(SeekFrom::Start(0))?;
    remote.seek(SeekFrom::Start(0))?;
    compare_prefix(&mut remote, &mut local, total, |n| ui.progress("下载完成，正在逐字节校验", n, total))?;
    ensure_source_unchanged(&before, &sftp.stat(Path::new(source))?)?;
    drop(local);
    // A hard link creates the destination without ever replacing an existing name.
    // Unsupported file systems fail safely and retain the completed .part file.
    fs::hard_link(&part, destination).context("无法发布目标文件；已完成的 .part 文件仍然保留")?;
    if let Err(error) = fs::remove_file(&part) {
        ui.message("下载完成", &format!("目标文件已保存。\n未能清理 .part 文件：{error}"))?;
    } else {
        ui.message("下载完成", &destination.display().to_string())?;
    }
    Ok(())
}

pub fn upload<T: Terminal>(ui: &mut Ui<T>, sftp: &Sftp, source: &Path, destination: &str) -> Result<()> {
    if remote_stat(sftp, destination)?.is_some() {
        bail!("远程目标已存在，请选择另一个文件名（首版不覆盖已有文件）");
    }
    let mut local = fs::File::open(source).context("无法打开本地文件")?;
    let before = local.metadata()?;
    if !before.is_file() { bail!("当前仅支持上传普通文件") }
    let total = before.len();
    let modified = before.modified()?;
    let part = format!("{destination}.gooeshell.part");
    let partial_stat = remote_stat(sftp, &part)?;
    let partial = match partial_stat.as_ref() {
        Some(stat) => {
            if !stat.is_file() { bail!("远程 .part 不是普通文件，拒绝写入") }
            let length = stat.size.context("无法读取 .part 文件大小")?;
            if length > total { bail!("远程 .part 比本地源文件更大，请改用新目标路径") }
            if !ui.confirm("发现未完成的上传", &[
                part.clone(),
                "先逐字节校验已有内容，再继续上传。".into(),
                "校验需要读取远程内容；不匹配时保留原文件。".into(),
            ])? { return Ok(()) }
            length
        }
        None => 0,
    };
    let flags = if partial_stat.is_some() {
        OpenFlags::READ | OpenFlags::WRITE
    } else {
        OpenFlags::READ | OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE
    };
    let mut remote = sftp.open_mode(Path::new(&part), flags, 0o600, OpenType::File)?;
    compare_prefix(&mut local, &mut remote, partial, |n| ui.progress("校验已有上传内容", n, partial))?;
    local.seek(SeekFrom::Start(partial))?;
    remote.seek(SeekFrom::Start(partial))?;
    let mut copied = partial;
    let mut buffer = [0u8; CHUNK];
    while copied < total {
        ui.progress("上传中", copied, total)?;
        let wanted = (total - copied).min(CHUNK as u64) as usize;
        let count = local.read(&mut buffer[..wanted])?;
        if count == 0 { bail!("本地文件提前结束；保留远程 .part 文件") }
        remote.write_all(&buffer[..count])?;
        copied += count as u64;
    }
    remote.flush()?;
    // fsync is an optional SFTP extension. A read-back check works without it.
    let _ = remote.fsync();
    let current = local.metadata()?;
    if current.len() != total || current.modified()? != modified {
        bail!("本地文件在上传期间发生变化；保留 .part 文件");
    }
    local.seek(SeekFrom::Start(0))?;
    remote.seek(SeekFrom::Start(0))?;
    compare_prefix(&mut local, &mut remote, total, |n| ui.progress("上传完成，正在逐字节校验", n, total))?;
    let current = local.metadata()?;
    if current.len() != total || current.modified()? != modified || remote.stat()?.size != Some(total) {
        bail!("文件在校验期间发生变化；保留 .part 文件");
    }
    drop(remote);
    // Passing None would include OVERWRITE, so explicitly use no flags.
    sftp.rename(Path::new(&part), Path::new(destination), Some(RenameFlags::empty()))
        .context("发布失败；远程 .part 文件仍然保留")?;
    ui.message("上传完成", remote_basename(destination))?;
    Ok(())
}
