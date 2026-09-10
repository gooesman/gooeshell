use anyhow::{bail, Result};
use std::io::Read;
use termwiz::cell::unicode_column_width;
use unicode_segmentation::UnicodeSegmentation;

pub const CHUNK: usize = 64 * 1024;

// Remote paths are POSIX paths, even when the client is running on Windows.
pub fn remote_join(directory: &str, name: &str) -> Result<String> {
    if name.is_empty() || name.contains('\0') {
        bail!("路径不能为空，也不能包含 NUL 字符");
    }
    if name.starts_with('/') {
        return Ok(name.to_string());
    }
    Ok(format!("{}/{}", directory.trim_end_matches('/'), name))
}

pub fn remote_parent(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rsplit_once('/') {
        Some(("", _)) | None => "/".to_string(),
        Some((parent, _)) => parent.to_string(),
    }
}

pub fn remote_basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

pub fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = bytes as f64 / 1024.;
    let mut unit = 0;
    while value >= 1024. && unit + 1 < units.len() {
        value /= 1024.;
        unit += 1;
    }
    format!("{value:.1} {}", units[unit])
}

pub fn visible_text(text: &str, max_columns: usize) -> String {
    let safe: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut columns = 0;
    safe.graphemes(true)
        .take_while(|g| {
            columns += unicode_column_width(g, None);
            columns <= max_columns
        })
        .collect()
}

pub fn tail_text(text: &str, max_columns: usize) -> String {
    let safe: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut columns = 0;
    let mut tail = Vec::new();
    for grapheme in safe.graphemes(true).rev() {
        columns += unicode_column_width(grapheme, None);
        if columns > max_columns { break; }
        tail.push(grapheme);
    }
    tail.reverse();
    tail.concat()
}

pub fn wrap_text(text: &str, max_columns: usize) -> Vec<String> {
    let max_columns = max_columns.max(2);
    let mut lines = Vec::new();
    for input in text.lines() {
        let mut line = String::new();
        let mut columns = 0;
        for grapheme in input.graphemes(true) {
            let width = unicode_column_width(grapheme, None);
            if columns + width > max_columns && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                columns = 0;
            }
            line.push_str(grapheme);
            columns += width;
        }
        lines.push(line);
    }
    lines
}

/// Compare exactly `length` bytes. Both streams must contain the whole prefix.
/// The callback bounds cancellation/visual progress to a single chunk.
pub fn compare_prefix<A: Read, B: Read>(
    a: &mut A,
    b: &mut B,
    length: u64,
    mut progress: impl FnMut(u64) -> Result<()>,
) -> Result<()> {
    let mut left = [0u8; CHUNK];
    let mut right = [0u8; CHUNK];
    let mut compared = 0;
    while compared < length {
        progress(compared)?;
        let count = (length - compared).min(CHUNK as u64) as usize;
        a.read_exact(&mut left[..count])?;
        b.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            bail!("内容校验不一致；保留 .part 文件，未发布目标文件");
        }
        compared += count as u64;
    }
    progress(compared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn remote_paths_are_not_windows_paths() {
        assert_eq!(remote_join("/home/user/", "中文 file").unwrap(), "/home/user/中文 file");
        assert_eq!(remote_join("/", "root").unwrap(), "/root");
        assert_eq!(remote_join("/a", "/b").unwrap(), "/b");
        assert_eq!(remote_parent("/home/user/"), "/home");
        assert_eq!(remote_parent("/"), "/");
        assert_eq!(remote_basename("/a/b"), "b");
        assert!(remote_join("/", "a\0b").is_err());
    }

    #[test]
    fn display_handles_chinese_and_control_sequences() {
        assert_eq!(visible_text("中文ab", 5), "中文a");
        assert_eq!(visible_text("a\n\x1bb", 4), "a  b");
        assert_eq!(visible_text("e\u{301}x", 1), "e\u{301}");
        assert_eq!(tail_text("C:/中文文件", 4), "文件");
        assert_eq!(wrap_text("中文abcd", 4), vec!["中文", "abcd"]);
        assert_eq!(human_bytes(1024), "1.0 KiB");
    }

    #[test]
    fn resume_rejects_wrong_or_short_prefixes() {
        assert!(compare_prefix(&mut Cursor::new(b"abcdef"), &mut Cursor::new(b"abc"), 3, |_| Ok(())).is_ok());
        assert!(compare_prefix(&mut Cursor::new(b"abcdef"), &mut Cursor::new(b"abx"), 3, |_| Ok(())).is_err());
        assert!(compare_prefix(&mut Cursor::new(b"abcdef"), &mut Cursor::new(b"ab"), 3, |_| Ok(())).is_err());
    }

    #[test]
    fn compare_can_be_cancelled_between_chunks() {
        let bytes = vec![7u8; CHUNK * 3];
        let result = compare_prefix(&mut Cursor::new(&bytes), &mut Cursor::new(&bytes), bytes.len() as u64, |n| {
            if n >= CHUNK as u64 { bail!("cancelled") }
            Ok(())
        });
        assert!(result.is_err());
    }
}
