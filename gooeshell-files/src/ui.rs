use crate::model::{human_bytes, tail_text, visible_text, wrap_text};
use anyhow::{bail, Result};
use std::time::{Duration, Instant};
use termwiz::cell::AttributeChange;
use termwiz::color::AnsiColor;
use termwiz::input::{InputEvent, KeyCode, KeyEvent, Modifiers};
use termwiz::surface::{Change, CursorVisibility, Position};
use termwiz::terminal::Terminal;

pub struct Ui<T: Terminal> {
    pub terminal: T,
    last_progress: Instant,
}

impl<T: Terminal> Ui<T> {
    pub fn new(mut terminal: T) -> Result<Self> {
        terminal.set_raw_mode()?;
        terminal.enter_alternate_screen()?;
        Ok(Self { terminal, last_progress: Instant::now() - Duration::from_secs(1) })
    }

    pub fn rows(&mut self) -> usize {
        self.terminal.get_screen_size().map(|s| s.rows).unwrap_or(24)
    }

    pub fn draw(&mut self, title: &str, lines: &[(String, bool)], footer: &str) -> Result<()> {
        let size = self.terminal.get_screen_size()?;
        let width = size.cols.saturating_sub(1);
        let mut changes = vec![
            Change::ClearScreen(AnsiColor::Black.into()),
            Change::CursorVisibility(CursorVisibility::Hidden),
            Change::Attribute(AttributeChange::Foreground(AnsiColor::Aqua.into())),
            Change::Text(visible_text(title, width)),
        ];
        for (index, (line, selected)) in lines.iter().take(size.rows.saturating_sub(3)).enumerate() {
            changes.extend([
                Change::CursorPosition { x: Position::Absolute(0), y: Position::Absolute(index + 2) },
                Change::Attribute(AttributeChange::Background(if *selected { AnsiColor::Navy.into() } else { AnsiColor::Black.into() })),
                Change::Attribute(AttributeChange::Foreground(if *selected { AnsiColor::White.into() } else { AnsiColor::Silver.into() })),
                Change::ClearToEndOfLine(if *selected { AnsiColor::Navy.into() } else { AnsiColor::Black.into() }),
                Change::Text(visible_text(line, width)),
            ]);
        }
        if size.rows > 1 {
            changes.extend([
                Change::CursorPosition { x: Position::Absolute(0), y: Position::Absolute(size.rows - 1) },
                Change::Attribute(AttributeChange::Background(AnsiColor::Black.into())),
                Change::Attribute(AttributeChange::Foreground(AnsiColor::Aqua.into())),
                Change::Text(visible_text(footer, width)),
            ]);
        }
        self.terminal.render(&changes)?;
        self.terminal.flush()?;
        Ok(())
    }

    pub fn message(&mut self, title: &str, message: &str) -> Result<()> {
        let width = self.terminal.get_screen_size()?.cols.saturating_sub(1);
        let lines: Vec<_> = wrap_text(message, width).into_iter().map(|s| (s, false)).collect();
        self.draw(title, &lines, "Enter / Esc 返回")?;
        loop {
            match self.terminal.poll_input(None)? {
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Enter | KeyCode::Escape, .. })) => return Ok(()),
                Some(InputEvent::Resized { .. }) => self.draw(title, &lines, "Enter / Esc 返回")?,
                _ => {}
            }
        }
    }

    pub fn prompt(&mut self, title: &str, initial: &str, secret: bool) -> Result<Option<String>> {
        let mut value = initial.to_string();
        loop {
            // Secret prompts deliberately display neither contents nor length.
            let width = self.terminal.get_screen_size()?.cols.saturating_sub(4);
            let display = if secret { "[输入不会显示]".to_string() } else { format!("> {}_", tail_text(&value, width)) };
            self.draw(title, &[(display, true)], "Enter 确认 · Esc 取消 · Ctrl+U 清空")?;
            match self.terminal.poll_input(None)? {
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Escape, .. })) => return Ok(None),
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Enter, .. })) => return Ok(Some(value)),
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Backspace, .. })) => { value.pop(); }
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Char('u'), modifiers })) if modifiers.contains(Modifiers::CTRL) => value.clear(),
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Char(c), modifiers })) if !c.is_control() && !modifiers.intersects(Modifiers::CTRL | Modifiers::ALT | Modifiers::SUPER) => value.push(c),
                Some(InputEvent::Paste(text)) => value.extend(text.chars().filter(|c| !c.is_control())),
                _ => {}
            }
        }
    }

    pub fn confirm(&mut self, title: &str, details: &[String]) -> Result<bool> {
        let lines: Vec<_> = details.iter().cloned().map(|s| (s, false)).collect();
        self.draw(title, &lines, "Y 确认 · N / Esc 取消")?;
        loop {
            match self.terminal.poll_input(None)? {
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Char('y' | 'Y'), .. })) => return Ok(true),
                Some(InputEvent::Key(KeyEvent { key: KeyCode::Char('n' | 'N') | KeyCode::Escape, .. })) => return Ok(false),
                Some(InputEvent::Resized { .. }) => self.draw(title, &lines, "Y 确认 · N / Esc 取消")?,
                _ => {}
            }
        }
    }

    pub fn progress(&mut self, phase: &str, done: u64, total: u64) -> Result<()> {
        if let Some(InputEvent::Key(KeyEvent { key, modifiers })) = self.terminal.poll_input(Some(Duration::ZERO))? {
            if key == KeyCode::Escape || (key == KeyCode::Char('c') && modifiers.contains(Modifiers::CTRL)) {
                bail!("已取消；保留 .part 文件，可稍后校验并继续");
            }
        }
        if self.last_progress.elapsed() >= Duration::from_millis(100) || done == total {
            let percentage = if total == 0 { 100. } else { done as f64 / total as f64 * 100. };
            self.draw(phase, &[(format!("{percentage:.1}%   {} / {}", human_bytes(done), human_bytes(total)), false)], "Esc / Ctrl+C 取消 · 网络操作超时后返回")?;
            self.last_progress = Instant::now();
        }
        Ok(())
    }
}

impl<T: Terminal> Drop for Ui<T> {
    fn drop(&mut self) {
        let _ = self.terminal.render(&[Change::CursorVisibility(CursorVisibility::Visible)]);
        let _ = self.terminal.exit_alternate_screen();
        let _ = self.terminal.set_cooked_mode();
        let _ = self.terminal.flush();
    }
}
