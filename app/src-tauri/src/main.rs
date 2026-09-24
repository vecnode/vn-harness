//! vn-harness desktop shell: the Rust half of `run-desktop.bat`.
//!
//! What this is: the same harness the browser launcher runs, in a native
//! window instead of a Chrome tab. It is NOT a second implementation of the
//! pack and it bundles none of its TypeScript - the web profile installs the
//! bundles as live links into the repository, so the app a browser tab shows
//! and the app this window shows are the same one, served by the same
//! `npx @deepseek-ai/dsh@<pin> web` process.
//!
//! So the shell does exactly what `scripts/run-web.ps1` does on Windows and
//! `run.sh` does elsewhere, with a webview in place of a browser hand-off:
//!
//! 1. read the pinned dsh version from `.dsh-version.json` at the repository
//!    root (found by walking up from this executable, so debug and release
//!    builds both work, wherever the target directory is);
//! 2. pick a FREE loopback port, so a desktop window never collides with a
//!    `run.bat` server or with the Web GUI;
//! 3. run `npx --yes @deepseek-ai/dsh@<pin> web --no-open --port <port>`, with
//!    its stdout and stderr streamed to this console;
//! 4. watch that output for the ready line, read its URL and navigate the
//!    window there - refusing anything that is not loopback;
//! 5. kill the harness when the window closes, so no orphaned `node` process
//!    holds the port - and, on Windows, put it in a Job Object as well, so it
//!    dies with this shell even when the shell is killed outright and step 5
//!    never gets to run;
//!
//! The launch token is a live credential, and the rules that keep it safe live
//! in [`readyline`]: it is read in memory, never written to a file, printed
//! only redacted, and handed to the webview as one value.
//!
//! A window opens IMMEDIATELY, on the shell's own splash (`app/ui/index.html`),
//! because the first run of the pinned CLI can spend a minute inside `npx`
//! before a server exists. On failure the window is retitled and the reason is
//! printed here; there is no dialog plugin, which is the whole reason this
//! crate has two dependencies.

mod readyline;

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// The harness process, kept here so the exit hook can find it. It is `None`
/// until the child is spawned and again once it has been reaped.
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// How long to wait for the ready line. Generous: the first run of a dsh
/// version downloads it through npx, and that is the slow path, not a hang.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How often the supervisor checks whether the harness is still alive.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The one window, and the label the exit hook and the supervisor share.
const WINDOW_LABEL: &str = "main";

const WINDOW_WIDTH: f64 = 1440.0;
const WINDOW_HEIGHT: f64 = 900.0;
const WINDOW_MIN_WIDTH: f64 = 960.0;
const WINDOW_MIN_HEIGHT: f64 = 640.0;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
#[derive(Clone, Default)]
struct Options {
    /// Explicit port; 0 means "pick a free one".
    port: u16,
    dsh_home: Option<String>,
    dsh_version: Option<String>,
    help: bool,
}

/// The flags, mirroring `run.bat` so the two launchers stay interchangeable.
/// Both spellings of each flag are accepted, and matching is case-insensitive,
/// because `-Port` is what the batch file documents and `--port` is what a
/// shell user types.
fn parse_args(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options::default();
    let mut args = args;
    while let Some(argument) = args.next() {
        let name = argument.to_ascii_lowercase();
        match name.as_str() {
            "-port" | "--port" => {
                let value = next_value(&mut args, "-Port")?;
                options.port = value
                    .parse::<u16>()
                    .map_err(|_| format!("-Port expects a port number, got '{value}'"))?;
                if options.port == 0 {
                    return Err("-Port expects a port number above zero".to_string());
                }
            }
            "-dshhome" | "--dshhome" => options.dsh_home = Some(next_value(&mut args, "-DshHome")?),
            "-dshversion" | "--dshversion" => {
                options.dsh_version = Some(next_value(&mut args, "-DshVersion")?)
            }
            "-help" | "--help" | "-h" | "/?" => options.help = true,
            other => {
                return Err(format!(
                    "unknown flag '{other}' - run run-desktop.bat -Help for the accepted flags"
                ))
            }
        }
    }
    Ok(options)
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} needs a value after it"))
}

fn print_usage() {
    println!();
    println!("Usage: run-desktop.bat [flags]");
    println!();
    println!("  -Port <n>          listen on this port instead of a free one");
    println!("  -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)");
    println!("  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json");
    println!("  -Help              print this help");
    println!();
    println!("Shows the harness in a native window instead of a Chrome tab. Same pin,");
    println!("same profile and same flags as run.bat; anything a browser tab can do in");
    println!("that profile, this window can do, because it is the same server.");
    println!();
}

// ---------------------------------------------------------------------------
// The repository, the pin and the profile
// ---------------------------------------------------------------------------
/// Find the repository root by walking up from this executable looking for
/// `.dsh-version.json`.
///
/// Walking beats counting directories: the build might be `target/release`,
/// `target/debug`, or a `CARGO_TARGET_DIR` somewhere else entirely, and all
/// three must land on the same root.
fn repo_root() -> Option<PathBuf> {
    let mut directory = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        if directory.join(".dsh-version.json").is_file() {
            return Some(directory);
        }
        directory = directory.parent()?.to_path_buf();
    }
    None
}

/// The pinned dsh version: the flag wins, then `.dsh-version.json`.
///
/// There is deliberately NO built-in fallback. A stale hard-coded pin would
/// mean a shell that quietly runs a different harness than `run.bat` does, so
/// an unreadable manifest is an error that names the file.
fn resolve_version(options: &Options) -> Result<String, String> {
    if let Some(version) = options.dsh_version.as_ref().filter(|value| !value.is_empty()) {
        return Ok(version.clone());
    }
    let root = repo_root().ok_or_else(|| {
        "could not find .dsh-version.json in this folder or any folder above it - run the shell from inside the vn-harness repository, or pass -DshVersion <ver>".to_string()
    })?;
    let manifest = root.join(".dsh-version.json");
    let text = std::fs::read_to_string(&manifest)
        .map_err(|error| format!("could not read {}: {error}", manifest.display()))?;
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", manifest.display()))?;
    json.get("dsh")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("{} has no \"dsh\" version pin", manifest.display()))
}

/// The harness home this run will use, resolved the way the launcher does:
/// `-DshHome`, then `DSH_HOME`, then the home directory.
fn harness_home(options: &Options) -> Option<PathBuf> {
    if let Some(home) = options.dsh_home.as_ref().filter(|value| !value.is_empty()) {
        return Some(PathBuf::from(home));
    }
    for variable in ["DSH_HOME", "HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(variable) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// A friendly nudge, never a refusal - the harness runs fine without the pack,
/// so a profile that never had it installed still starts, just unadorned. This
/// is the same warning `run-web.ps1` prints, from the same source of truth: the
/// web profile's own bundle list.
fn warn_when_pack_missing(options: &Options) {
    let Some(home) = harness_home(options) else {
        return;
    };
    let profile_dir = home.join("profiles").join("web");
    let manifest = profile_dir.join("package.json");
    if !manifest.is_file() {
        println!(
            "  - there is no web profile at {} yet.",
            profile_dir.display()
        );
        println!("    Run install.bat (or ./install.sh) first if you expected this pack's bundles.");
        return;
    }
    let installed = std::fs::read_to_string(&manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("dsh")?
                .get("profile")?
                .get("bundles")?
                .as_array()
                .map(|bundles| {
                    bundles
                        .iter()
                        .any(|bundle| bundle.as_str() == Some("dsh-rightbar"))
                })
        })
        .unwrap_or(false);
    if !installed {
        println!(
            "  - the web profile at {} does not list this pack's bundles yet.",
            profile_dir.display()
        );
        println!("    Run install.bat (or ./install.sh) first if you expected the pack to be there.");
    }
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------
/// A free loopback port.
///
/// Binding port 0 lets the operating system choose; the port is then released
/// for the harness to take. There is a hair of a race between the release and
/// the harness binding it, which is why `-Port` exists as the way out of it.
fn free_port() -> Option<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port())
}

/// Whether a URL may be loaded into this window.
///
/// The harness's own URL and the shell's asset origin are allowed; everything
/// else is a link the reader clicked, and it belongs in their browser, not in
/// the app's only window.
fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        // The shell's own assets: `tauri://localhost` on macOS and Linux,
        // `http://tauri.localhost` on Windows.
        "tauri" => true,
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            Some(host) => readyline::is_loopback_host(host),
            None => false,
        },
        _ => false,
    }
}

/// Open a URL in the platform's own browser, with argv only - never a shell.
///
/// `explorer.exe` is what the pack's dsh-open-in-app uses for the same job on
/// Windows; `open` and `xdg-open` are the macOS and Linux spellings.
fn open_external(url: &str) {
    let program = if cfg!(target_os = "windows") {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    if let Err(error) = Command::new(program)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        eprintln!("[vn-harness] could not open {url} in a browser: {error}");
    }
}

/// Open the one window, on the shell's own splash page.
///
/// Built here rather than declared in `tauri.conf.json` so the navigation
/// filter can live with it: `on_navigation` is the only thing standing between
/// a link in a rendered document and the app being replaced by a web page.
fn build_window(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(PathBuf::from("index.html")))
        .title("VN Harness")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
        .center()
        .resizable(true)
        .on_navigation(|url| {
            if is_internal(url) {
                return true;
            }
            open_external(url.as_str());
            false
        })
        .build()?;
    Ok(())
}

/// Report a failure in the two places a person can actually see: this console,
/// and the title of the window still showing the splash.
fn fail(app: &AppHandle, message: &str) {
    eprintln!("[vn-harness] {message}");
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.set_title("VN Harness - the harness server did not start (see the console window)");
    }
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------
fn supervise(app: AppHandle, options: Options) {
    let version = match resolve_version(&options) {
        Ok(version) => version,
        Err(message) => return fail(&app, &message),
    };
    let port = if options.port > 0 {
        options.port
    } else {
        match free_port() {
            Some(port) => port,
            None => return fail(&app, "could not find a free loopback port to listen on"),
        }
    };

    println!("[vn-harness] VN Harness desktop shell");
    println!("[vn-harness] Pinned dsh version: {version}");
    if let Some(home) = harness_home(&options) {
        println!("[vn-harness] DSH_HOME: {}", home.display());
    }
    warn_when_pack_missing(&options);
    println!("[vn-harness] Starting the harness on 127.0.0.1:{port} (npx --yes @deepseek-ai/dsh@{version} web --no-open)");
    println!("  Keep this window open - the harness runs in the window that opens. Ctrl+C stops it.");
    println!();

    // `npx.cmd` on Windows, `npx` elsewhere. std runs a batch file through
    // cmd.exe itself, and the spec/flag values below are plain enough that
    // nothing in them can be read as a shell metacharacter.
    let npx = if cfg!(target_os = "windows") { "npx.cmd" } else { "npx" };
    let mut command = Command::new(npx);
    command
        .args([
            "--yes",
            &format!("@deepseek-ai/dsh@{version}"),
            "web",
            "--no-open",
            "--port",
            &port.to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = harness_home(&options) {
        command.env("DSH_HOME", home);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return fail(
                &app,
                &format!("could not run {npx}: {error}. Install Node.js 22 or newer and make sure {npx} is on PATH."),
            )
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Before anything else can go wrong: make the harness die with this shell.
    confine_to_job(&child);
    match CHILD.lock() {
        Ok(mut slot) => *slot = Some(child),
        Err(_) => return fail(&app, "the harness process slot was poisoned; restart the shell"),
    }

    // Both streams keep being drained for as long as the harness runs: a pipe
    // nobody reads fills up and blocks the process writing to it. Everything
    // printed goes through `redact` first, and the ready URL is sent on a
    // channel rather than printed.
    let (ready_tx, ready_rx) = mpsc::channel::<Url>();
    if let Some(stdout) = stdout {
        thread::spawn(move || {
            let mut reported = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                println!("{}", readyline::redact(&line));
                if reported {
                    continue;
                }
                let Some(candidate) = readyline::extract_ready_url(&line) else {
                    continue;
                };
                match Url::parse(&candidate) {
                    Ok(url) if url.host_str().map(readyline::is_loopback_host).unwrap_or(false) => {
                        if ready_tx.send(url).is_ok() {
                            reported = true;
                        }
                    }
                    Ok(_) => eprintln!(
                        "[vn-harness] the harness printed a URL that does not name a loopback address; it was NOT opened."
                    ),
                    Err(error) => eprintln!(
                        "[vn-harness] the harness printed a URL this shell could not parse: {error}"
                    ),
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("{}", readyline::redact(&line));
            }
        });
    }

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(url) => {
            println!();
            println!(
                "[vn-harness] The harness is listening on 127.0.0.1:{} - showing it in the window.",
                url.port().unwrap_or(port)
            );
            println!("[vn-harness] (The launch token stays in memory and is never printed.)");
            match app.get_webview_window(WINDOW_LABEL) {
                Some(window) => {
                    if let Err(error) = window.navigate(url) {
                        eprintln!("[vn-harness] could not load the harness URL in the window: {error}");
                    }
                    let _ = window.set_focus();
                }
                None => eprintln!("[vn-harness] the window was closed before the harness was ready."),
            }
        }
        Err(RecvTimeoutError::Timeout) => {
            return fail(
                &app,
                &format!(
                    "the harness did not print its ready line within {} seconds. See the output above.",
                    READY_TIMEOUT.as_secs()
                ),
            )
        }
        Err(RecvTimeoutError::Disconnected) => {
            return fail(&app, "the harness stopped before it printed a ready line. See the output above.")
        }
    }

    // The harness owns the session: when it exits, the window has nothing left
    // to show, so the shell closes instead of leaving a dead page on screen.
    loop {
        thread::sleep(POLL_INTERVAL);
        let finished = match CHILD.lock() {
            Ok(mut slot) => match slot.as_mut() {
                Some(child) => !matches!(child.try_wait(), Ok(None)),
                None => true,
            },
            Err(_) => true,
        };
        if finished {
            println!("[vn-harness] The harness stopped; closing the window.");
            app.exit(0);
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
/// Put the harness in a Job Object that kills everything in it when this shell
/// dies - for ANY reason.
///
/// [`kill_child_tree`] handles the ordinary exit, but it only runs when the
/// event loop gets to run: a crash, a `TerminateProcess` from Task Manager or a
/// force-killed shell never reaches it, and then `node` keeps the port. That is
/// not a theory - it was measured: force-killing the shell left two `node`
/// processes and a listening port behind. A job object closes that hole, because
/// the kernel does the killing when the last handle to the job closes, and the
/// last handle closes when this process ends however it ends.
///
/// The job handle is deliberately LEAKED (never `CloseHandle`d): one handle for
/// the lifetime of the process is the entire point, and closing it early would
/// kill the harness we just started.
///
/// Children inherit job membership, so `cmd.exe`/`npx` and the `node` harness
/// under it are all covered. The one hole this cannot close is the instant
/// between `CreateProcess` and the assignment below - the shell would have to
/// die inside a few microseconds, before `npx` has even started `node`.
#[cfg(target_os = "windows")]
fn confine_to_job(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: every call below is the documented Win32 sequence for a
    // kill-on-close job: create, set the limit, assign the child's own inherited
    // process handle. The struct is zero-initialised, which is what the API
    // expects (only LimitFlags is meaningful here); its size is taken from the
    // Rust type so it cannot drift from the C one; and the handle is left open
    // on purpose, with the process exit closing it.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("[vn-harness] warning: could not create a job object - if this shell is killed outright, the harness may keep running.");
            return;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            size,
        ) == 0
        {
            eprintln!("[vn-harness] warning: could not set kill-on-close on the job object - if this shell is killed outright, the harness may keep running.");
            return;
        }
        if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
            eprintln!("[vn-harness] warning: could not put the harness in the job object - if this shell is killed outright, the harness may keep running.");
        }
    }
}

/// Nothing to do on macOS/Linux. Closing the window still stops the harness
/// ([`kill_child_tree`]); an abrupt kill of the shell can leave it running, which
/// the Windows half closes with a job object and these platforms have no
/// untested equivalent here for.
#[cfg(not(target_os = "windows"))]
fn confine_to_job(_child: &Child) {}

/// Stop the harness, and everything npx started underneath it.
///
/// `npx` is a launcher: the process this shell spawned is a shell script or a
/// cmd.exe wrapper whose child is the harness itself, so killing the direct
/// child alone would leave a `node` holding the port. Windows gets the whole
/// tree from `taskkill /T`; elsewhere the harness is detached with
/// `setsid`-style semantics by npx, so the children are found by parent.
fn kill_child_tree() {
    let child = match CHILD.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    let Some(mut child) = child else {
        return;
    };
    let pid = child.id().to_string();

    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("pkill")
            .args(["-TERM", "-P", &pid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
fn main() {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("[vn-harness] {message}");
            std::process::exit(1);
        }
    };
    if options.help {
        print_usage();
        return;
    }

    let app = match tauri::Builder::default()
        .setup(move |app| {
            // The window first, so something is on screen while npx works.
            build_window(app.handle())?;
            let handle = app.handle().clone();
            let options = options.clone();
            thread::spawn(move || supervise(handle, options));
            Ok(())
        })
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            eprintln!("[vn-harness] could not start the desktop shell: {error}");
            std::process::exit(1);
        }
    };

    app.run(|_handle, event| {
        if let RunEvent::Exit = event {
            kill_child_tree();
        }
    });
}
