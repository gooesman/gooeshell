//! Opt-in tests against tests-support/sftp_fixture.py. All writes stay in its
//! generated directory, and the SSH peer is pinned before test authentication.

use crate::{transfer, ui::Ui};
use anyhow::{bail, Context, Result};
use base64::Engine;
use ssh2::{HashType, Session, Sftp};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use termwiz::input::{InputEvent, KeyCode, KeyEvent, Modifiers};
use termwiz::surface::Change;
use termwiz::terminal::{ScreenSize, Terminal, TerminalWaker};

#[derive(Default)]
struct MockTerminal {
    confirmation: bool,
    cancel_next_progress: bool,
    rendered: Vec<String>,
}

impl Terminal for MockTerminal {
    fn set_raw_mode(&mut self) -> termwiz::Result<()> {
        Ok(())
    }
    fn set_cooked_mode(&mut self) -> termwiz::Result<()> {
        Ok(())
    }
    fn enter_alternate_screen(&mut self) -> termwiz::Result<()> {
        Ok(())
    }
    fn exit_alternate_screen(&mut self) -> termwiz::Result<()> {
        Ok(())
    }
    fn get_screen_size(&mut self) -> termwiz::Result<ScreenSize> {
        Ok(ScreenSize {
            rows: 32,
            cols: 100,
            xpixel: 0,
            ypixel: 0,
        })
    }
    fn set_screen_size(&mut self, _size: ScreenSize) -> termwiz::Result<()> {
        Ok(())
    }
    fn render(&mut self, changes: &[Change]) -> termwiz::Result<()> {
        for change in changes {
            if let Change::Text(text) = change {
                if text.contains("Y 确认") {
                    self.confirmation = true;
                }
                self.rendered.push(text.clone());
            }
        }
        Ok(())
    }
    fn flush(&mut self) -> termwiz::Result<()> {
        Ok(())
    }
    fn poll_input(&mut self, wait: Option<Duration>) -> termwiz::Result<Option<InputEvent>> {
        let key = if wait.is_some() {
            if !self.cancel_next_progress {
                return Ok(None);
            }
            self.cancel_next_progress = false;
            KeyCode::Escape
        } else if self.confirmation {
            self.confirmation = false;
            KeyCode::Char('y')
        } else {
            KeyCode::Enter
        };
        Ok(Some(InputEvent::Key(KeyEvent {
            key,
            modifiers: Modifiers::NONE,
        })))
    }
    fn waker(&self) -> TerminalWaker {
        panic!("mock terminal has no asynchronous waker")
    }
}

struct Fixture {
    _session: Session,
    sftp: Sftp,
    local: PathBuf,
    remote_prefix: String,
}

impl Fixture {
    fn connect() -> Result<Self> {
        let ready = std::env::var_os("GOOESHELL_SFTP_TEST_READY")
            .context("GOOESHELL_SFTP_TEST_READY must point to a running loopback fixture; see tests-support/README.md")?;
        let text = fs::read_to_string(ready)?;
        let values: BTreeMap<_, _> = text
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let get = |key: &str| {
            values
                .get(key)
                .copied()
                .with_context(|| format!("missing fixture field {key}"))
        };
        if get("fixture")? != "gooeshell-sftp-v1" || get("host")? != "127.0.0.1" {
            bail!("not an explicitly local gooeshell fixture");
        }
        let root = PathBuf::from(get("root")?).canonicalize()?;
        if !root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .starts_with("gooeshell-sftp-test-")
        {
            bail!("fixture directory must have the generated test prefix");
        }
        if fs::read_to_string(root.join("fixture.token"))? != get("token")? {
            bail!("fixture directory marker mismatch");
        }
        if get("username")? != "gooeshell-test"
            || get("password")? != "gooeshell-loopback-test-only"
        {
            bail!("unexpected test identity");
        }
        let port: u16 = get("port")?.parse()?;
        if port == 0 {
            bail!("invalid fixture port");
        }
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let stream = TcpStream::connect_timeout(&address, Duration::from_secs(5))?;
        let mut session = Session::new()?;
        session.set_tcp_stream(stream);
        session.set_timeout(5_000);
        session.handshake()?;
        let hash = session
            .host_key_hash(HashType::Sha256)
            .context("missing test server fingerprint")?;
        let actual = format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(hash)
        );
        if actual != get("fingerprint")?.trim_end_matches('=') {
            bail!("fixture SSH fingerprint mismatch; no credentials sent");
        }
        session.userauth_password(get("username")?, get("password")?)?;
        let sftp = session.sftp()?;
        let run = format!(
            "run-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        );
        let local_root = root.join("local").canonicalize()?;
        if !local_root.starts_with(&root) {
            bail!("local fixture path escaped root");
        }
        let local = local_root.join(&run);
        fs::create_dir(&local)?;
        let remote_prefix = format!("/{run}");
        sftp.mkdir(Path::new(&remote_prefix), 0o700)?;
        Ok(Self {
            _session: session,
            sftp,
            local,
            remote_prefix,
        })
    }

    fn remote(&self, name: &str) -> String {
        format!("{}/{name}", self.remote_prefix)
    }
    fn write_remote(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut file = self.sftp.open_mode(
            Path::new(&self.remote(name)),
            ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::EXCLUSIVE,
            0o600,
            ssh2::OpenType::File,
        )?;
        file.write_all(bytes)?;
        file.close()?;
        Ok(())
    }
    fn read_remote(&self, name: &str) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.sftp
            .open(Path::new(&self.remote(name)))?
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    fn remote_exists(&self, name: &str) -> bool {
        self.sftp.lstat(Path::new(&self.remote(name))).is_ok()
    }
}

#[test]
#[ignore = "requires explicitly started loopback SFTP fixture and GOOESHELL_SFTP_TEST_READY; see tests-support/README.md"]
fn loopback_sftp_roundtrip_and_resume() -> Result<()> {
    let fixture = Fixture::connect()?;
    let sftp = &fixture.sftp;
    let mut ui = Ui::new(MockTerminal::default())?;
    // Several chunks plus a non-aligned tail detect boundary and seek errors.
    let payload: Vec<u8> = (0..(crate::model::CHUNK * 3 + 731))
        .map(|i| ((i * 37 + 19) % 251) as u8)
        .collect();
    let source = fixture.local.join("source.bin");
    fs::write(&source, &payload)?;

    transfer::upload(&mut ui, sftp, &source, &fixture.remote("uploaded.bin"))?;
    assert_eq!(fixture.read_remote("uploaded.bin")?, payload);
    assert!(!fixture.remote_exists("uploaded.bin.gooeshell.part"));
    let downloaded = fixture.local.join("downloaded.bin");
    transfer::download(&mut ui, sftp, &fixture.remote("uploaded.bin"), &downloaded)?;
    assert_eq!(fs::read(&downloaded)?, payload);
    assert!(!fixture.local.join("downloaded.bin.gooeshell.part").exists());
    eprintln!("PASS: real upload and download with full read-back validation");

    let prefix = crate::model::CHUNK + 173;
    fixture.write_remote("resume-up.bin.gooeshell.part", &payload[..prefix])?;
    transfer::upload(&mut ui, sftp, &source, &fixture.remote("resume-up.bin"))?;
    assert_eq!(fixture.read_remote("resume-up.bin")?, payload);
    assert!(!fixture.remote_exists("resume-up.bin.gooeshell.part"));
    let resumed_download = fixture.local.join("resume-down.bin");
    fs::write(
        fixture.local.join("resume-down.bin.gooeshell.part"),
        &payload[..prefix],
    )?;
    transfer::download(
        &mut ui,
        sftp,
        &fixture.remote("uploaded.bin"),
        &resumed_download,
    )?;
    assert_eq!(fs::read(&resumed_download)?, payload);
    assert!(ui
        .terminal
        .rendered
        .iter()
        .any(|line| line.contains("发现未完成的")));
    eprintln!("PASS: upload and download resume from verified non-aligned prefixes");

    fixture.write_remote("protected.bin", b"do not overwrite")?;
    assert!(transfer::upload(&mut ui, sftp, &source, &fixture.remote("protected.bin")).is_err());
    assert_eq!(fixture.read_remote("protected.bin")?, b"do not overwrite");
    let protected = fixture.local.join("protected.bin");
    fs::write(&protected, b"keep local")?;
    assert!(
        transfer::download(&mut ui, sftp, &fixture.remote("uploaded.bin"), &protected).is_err()
    );
    assert_eq!(fs::read(&protected)?, b"keep local");
    eprintln!("PASS: existing local and remote destination files are unchanged");

    let wrong_prefix = b"this prefix belongs to another source";
    fixture.write_remote("wrong-up.bin.gooeshell.part", wrong_prefix)?;
    assert!(transfer::upload(&mut ui, sftp, &source, &fixture.remote("wrong-up.bin")).is_err());
    assert_eq!(
        fixture.read_remote("wrong-up.bin.gooeshell.part")?,
        wrong_prefix
    );
    assert!(!fixture.remote_exists("wrong-up.bin"));
    let wrong_local = fixture.local.join("wrong-down.bin.gooeshell.part");
    fs::write(&wrong_local, wrong_prefix)?;
    assert!(transfer::download(
        &mut ui,
        sftp,
        &fixture.remote("uploaded.bin"),
        &fixture.local.join("wrong-down.bin")
    )
    .is_err());
    assert_eq!(fs::read(&wrong_local)?, wrong_prefix);
    assert!(!fixture.local.join("wrong-down.bin").exists());
    eprintln!("PASS: mismatched partial files are preserved and never published");

    let mut cancel_ui = Ui::new(MockTerminal {
        cancel_next_progress: true,
        ..Default::default()
    })?;
    assert!(transfer::upload(
        &mut cancel_ui,
        sftp,
        &source,
        &fixture.remote("cancelled.bin")
    )
    .is_err());
    assert!(fixture.remote_exists("cancelled.bin.gooeshell.part"));
    assert!(!fixture.remote_exists("cancelled.bin"));
    eprintln!("PASS: cancellation preserves partial output without publishing a destination");
    eprintln!("Loopback test data retained at {}", fixture.local.display());
    Ok(())
}
