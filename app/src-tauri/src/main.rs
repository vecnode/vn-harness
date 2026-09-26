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
//! `run-web.sh` does elsewhere, with a webview in place of a browser hand-off:
//!
//! 1. read the pinned dsh version from `.dsh-version.json` at the repository
//!    root (found by walking up from this executable, so debug and release
//!    builds both work, wherever the target directory is);
//! 2. pick the port: `-Port` when it was given, else the harness's own default
//!    (3080 - the same origin a `run-web.bat` tab opens on, which is what keeps the
//!    window's per-origin client state) when nothing holds it, else any free
//!    loopback port, so a desktop window never collides with a `run-web.bat` server
//!    or with the Web GUI;
//! 3. run `npx --yes @deepseek-ai/dsh@<pin> web --no-open --port <port>`, with
//!    its stdout and stderr streamed to this console and exactly one variable
//!    added to its environment: `DSH_HOME`, and only when `-DshHome` or an
//!    inherited `DSH_HOME` chose it. The shell never INFERS a harness home, and
//!    it must not: `DSH_HOME` names `~/.dsh`, NOT `~`, so a shell that passed the
//!    user's home directory there boots a SECOND, unadorned harness inside it -
//!    a profile with none of this pack's bundles and none of the user's sessions,
//!    which reads as "the desktop app opens the plain DeepSeek Harness". The
//!    `~/.dsh` default is the harness's own decision, exactly as it is under
//!    `run-web.bat`, and this shell leaves it alone;
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
//! The window also remembers ITSELF: `<harness home>/vn-harness/window.json` is
//! read before the window is built and written back on every resize and move
//! (coalesced, so a drag costs one write) and once more on the way out, so a
//! window the reader placed once comes back where they put it. Every rule about
//! that file - what may be restored, what is discarded, what is clamped, and
//! why a maximized window's size is not what gets recorded - lives in
//! [`windowstate`], and a record this build cannot vouch for costs the default
//! geometry and nothing else.
//!
//! A window opens IMMEDIATELY, on the shell's own splash (`app/ui/index.html`),
//! because the first run of the pinned CLI can spend a minute inside `npx`
//! before a server exists. On failure the window is retitled and the reason is
//! printed here; there is no dialog plugin, which is the whole reason this
//! crate has two dependencies.

mod readyline;
mod windowstate;

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use windowstate::WindowState;

/// The harness process, kept here so the exit hook can find it. It is `None`
/// until the child is spawned and again once it has been reaped.
static CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// The last geometry this shell observed, folded through the rules in
/// [`windowstate`].
///
/// It lives in a static because a window event callback receives nothing but
/// `&WindowEvent`: it cannot own the state its reading has to be merged against.
/// The exit hook reads it when the window is already gone, which is why it is
/// kept up to date on every observation rather than only at the end.
static LAST_GEOMETRY: Mutex<Option<WindowState>> = Mutex::new(None);

/// How long to wait for the ready line. Generous: the first run of a dsh
/// version downloads it through npx, and that is the slow path, not a hang.
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// How often the supervisor checks whether the harness is still alive.
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// The port the harness listens on when it is given none - the same one a
/// `run-web.bat` tab opens on, and therefore the same ORIGIN.
///
/// The window prefers it so the little state the client keeps per origin (the
/// conversation content width, for one) survives a run, the way it does in
/// Chrome. It is only a preference and can never change what the window shows:
/// the URL loaded is the one the harness prints, so a port that is already held
/// - by `run-web.bat`, by the Web GUI, by anything - falls through to a free one.
/// A stale value here costs the origin and nothing else.
const DEFAULT_PORT: u16 = 3080;

/// The one window, and the label the exit hook and the supervisor share.
const WINDOW_LABEL: &str = "main";

/// How long a resize or a move must go quiet before the geometry is written.
///
/// A drag emits an event per pixel and every write is a file plus a rename on
/// the reader's own disk, so the writer COALESCES: it keeps the newest geometry
/// and writes once the burst stops. This is far below the time it takes to
/// notice anything, and it turns a whole drag into a single write.
const GEOMETRY_WRITE_DELAY: Duration = Duration::from_millis(400);

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

/// The flags, mirroring `run-web.bat` so the two launchers stay interchangeable.
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
    println!("same profile and same flags as run-web.bat; anything a browser tab can do in");
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
/// mean a shell that quietly runs a different harness than `run-web.bat` does, so
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

/// Which of a chosen value and an inherited one wins.
///
/// The pure core of [`explicit_home`], and the rule that matters is the `None`
/// branch: when NEITHER is present the answer is `None` - "no choice was made" -
/// and never a guess. See [`reported_home`] for why a guess is the bug this
/// function exists to prevent. A blank value counts as no value at all, which
/// is also how the harness reads a whitespace-only `DSH_HOME`.
fn chosen_home(flag: Option<&str>, inherited: Option<&str>) -> Option<String> {
    let pick = |value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    pick(flag).or_else(|| pick(inherited))
}

/// The harness home to HAND to the child, if one was actually chosen:
/// `-DshHome`, then `DSH_HOME` as this shell inherited it.
///
/// `None` means the child is given no `DSH_HOME` at all, which is the point:
/// the harness then applies its own default (`~/.dsh`) exactly as it does when
/// `run-web.bat` starts it. This shell must never derive a harness home from the
/// user's home directory, because `DSH_HOME` names the harness's own folder
/// under it - not the home itself. Handing `%USERPROFILE%` over as `DSH_HOME`
/// is not a cosmetic mistake: the harness accepts it, finds no profile there,
/// bootstraps a brand-new one holding only its own two base bundles, and serves
/// that. The window then shows the plain DeepSeek Harness - no plugins, no
/// vn-harness branding, none of the user's sessions - while the real home at
/// `~/.dsh` sits there untouched.
fn explicit_home(options: &Options) -> Option<PathBuf> {
    let inherited = std::env::var("DSH_HOME").ok();
    chosen_home(options.dsh_home.as_deref(), inherited.as_deref()).map(PathBuf::from)
}

/// Which variable names the user's home directory, first match winning.
///
/// Windows is asked for `USERPROFILE` first because that is the variable Node's
/// own `os.homedir()` reads there - and the harness builds its default from
/// exactly that call - while elsewhere `HOME` is the spelling. The pure core of
/// [`home_dir`], kept separate so the order stays testable.
fn pick_home_variable<'a>(
    user_profile: Option<&'a str>,
    home: Option<&'a str>,
    is_windows: bool,
) -> Option<&'a str> {
    let candidates: [Option<&'a str>; 2] = if is_windows {
        [user_profile, home]
    } else {
        [home, user_profile]
    };
    candidates
        .into_iter()
        .flatten()
        .find(|value| !value.trim().is_empty())
}

/// The user's home directory, resolved the way the harness resolves it.
fn home_dir() -> Option<PathBuf> {
    let user_profile = std::env::var("USERPROFILE").ok();
    let home = std::env::var("HOME").ok();
    pick_home_variable(
        user_profile.as_deref(),
        home.as_deref(),
        cfg!(target_os = "windows"),
    )
    .map(PathBuf::from)
}

/// The harness's own default home under a user home: `~/.dsh`.
///
/// One function because the `.dsh` component is the whole content of this rule,
/// and it is the component that was missing.
fn default_dsh_home(user_home: &std::path::Path) -> PathBuf {
    user_home.join(".dsh")
}

/// The harness home this run will use, for REPORTING only - never exported.
///
/// It exists so the console can say where this window's plugins and sessions
/// come from, and so the "the pack is not installed" nudge can look at the right
/// profile. Nothing forces the harness to agree: an explicit choice is what the
/// child is given ([`explicit_home`]), and otherwise the harness applies its own
/// `~/.dsh` default, which is what this computes so the printed path is the true
/// one even when the shell said nothing.
fn reported_home(options: &Options) -> Option<PathBuf> {
    explicit_home(options).or_else(|| home_dir().map(|directory| default_dsh_home(&directory)))
}

/// A friendly nudge, never a refusal - the harness runs fine without the pack,
/// so a profile that never had it installed still starts, just unadorned. This
/// is the same warning `run-web.ps1` prints, from the same source of truth: the
/// web profile's own bundle list.
fn warn_when_pack_missing(options: &Options) {
    let Some(home) = reported_home(options) else {
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

/// Whether nothing holds this loopback port right now.
///
/// The listener is closed again immediately, which leaves the same hair of a
/// race [`free_port`] has - and the same escape hatch.
fn port_is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// The port to ask the harness for: `-Port`, else the harness's own default
/// when it is free, else any free one.
///
/// The middle case is what makes the window open on the same origin a `run-web.bat`
/// tab does. It cannot change WHICH app is shown - the loaded URL is the one the
/// harness prints - so a wrong guess here is only a lost preference, never a
/// wrong page.
fn choose_port(options: &Options) -> Option<u16> {
    if options.port > 0 {
        return Some(options.port);
    }
    if port_is_free(DEFAULT_PORT) {
        return Some(DEFAULT_PORT);
    }
    free_port()
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
///
/// The remembered geometry is restored here too, and only the OS work happens
/// here: WHICH geometry may be restored - and every rule about when a saved
/// record can be trusted - lives in [`windowstate`], so all of it is decided by
/// a `cargo test` rather than by reading this function.
fn build_window(app: &AppHandle, state_path: Option<&Path>) -> tauri::Result<()> {
    let remembered = match state_path.map(windowstate::load) {
        // No harness home could be resolved, so there is nowhere honest to
        // read from or write to: this window simply has no memory (see
        // `reported_home`, which is the only home resolver here).
        None => WindowState::first_launch(),
        // The ordinary first launch: nothing to say, and nothing to fix.
        Some(Err(windowstate::Unusable::Absent)) => WindowState::first_launch(),
        Some(Err(reason)) => {
            // One line, never a refusal: a record this build cannot vouch for
            // costs the reader the default geometry and nothing else.
            println!("[vn-harness] ignoring the remembered window geometry: {reason}.");
            WindowState::first_launch()
        }
        Some(Ok(remembered)) => remembered,
    };

    // A remembered position is honoured only when it names a monitor this
    // machine HAS right now: a window restored onto a display that is no longer
    // plugged in is a window nobody can see, which is worse than a centred one.
    // The pure half owns "both numbers are present, numeric and finite"; only
    // this side can ask the monitor list whether the point is real.
    let position = remembered
        .position()
        .filter(|point| point_is_on_a_monitor(app, point.0, point.1));

    let mut builder =
        WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(PathBuf::from("index.html")))
            .title("vn-harness")
            .inner_size(remembered.width, remembered.height)
            .min_inner_size(windowstate::MIN_WIDTH, windowstate::MIN_HEIGHT)
            .resizable(true)
            .on_navigation(|url| {
                if is_internal(url) {
                    return true;
                }
                open_external(url.as_str());
                false
            });
    builder = match position {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    let window = builder.build()?;

    // A maximized window is built at its RESTORED size and maximized after, and
    // that order is the point: the record still holds a size worth
    // un-maximizing to, instead of the size of the display.
    if remembered.maximized {
        let _ = window.maximize();
    }

    // Nothing is remembered without a resolved harness home, and then there is
    // no listener and no writer either - never a guessed path.
    if let Some(path) = state_path {
        remember(remembered);
        let sender = spawn_geometry_writer(path.to_path_buf());
        let listener_window = window.clone();
        window.on_window_event(move |event| {
            // Resizes and moves are the whole of "the geometry changed";
            // everything else (focus, theme, a close request) is not geometry.
            if !matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
                return;
            }
            let Some(reading) = snapshot(&listener_window) else {
                return;
            };
            // The write itself is the other thread's job; this only hands the
            // newest geometry over, and a closed channel means the shell is on
            // its way out and the exit hook is already writing the last word.
            let _ = sender.send(remember(reading));
        });
    }
    Ok(())
}

/// Whether a logical point names a monitor this machine has right now.
///
/// The point is a LOGICAL coordinate (see [`windowstate`]) while the monitor
/// list is in PHYSICAL pixels, so the point is mapped through each monitor's
/// own scale factor before the hit test. This is a best-effort sanity check and
/// only needs to be that: a wrong answer here costs the restored POSITION, and
/// the window is centred instead.
///
/// A monitor query that FAILS answers "no" as well: without a list this shell
/// cannot tell an off-screen point from an on-screen one, and centring is the
/// safe half of that uncertainty.
fn point_is_on_a_monitor(app: &AppHandle, x: f64, y: f64) -> bool {
    let monitors = match app.available_monitors() {
        Ok(monitors) => monitors,
        Err(error) => {
            eprintln!("[vn-harness] could not read the monitor list ({error}); centring the window.");
            return false;
        }
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let left = monitor.position().x as f64;
        let top = monitor.position().y as f64;
        let right = left + monitor.size().width as f64;
        let bottom = top + monitor.size().height as f64;
        let (physical_x, physical_y) = (x * scale, y * scale);
        physical_x >= left && physical_x < right && physical_y >= top && physical_y < bottom
    })
}

/// Read the live window's geometry the way this shell records it.
///
/// The physical readings are divided by the window's own scale factor, because
/// the record is LOGICAL pixels: the builder takes logical values, so a window
/// on a 150% display that stored its physical size would come back half again
/// too large. `None` means the window could not be measured at all, which is
/// not worth recording.
///
/// A window that is MINIMIZED reports 0x0 on Windows, and its position is then
/// the off-screen parking spot rather than anywhere the reader put it - which
/// [`WindowState::merge`] is what deals with, so a minimize cannot erase a good
/// record.
fn snapshot(window: &WebviewWindow) -> Option<WindowState> {
    let scale = window
        .scale_factor()
        .ok()
        .filter(|factor| *factor > 0.0)
        .unwrap_or(1.0);
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    Some(WindowState {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        x: Some(position.x as f64 / scale),
        y: Some(position.y as f64 / scale),
        // An unreadable flag reads as "not maximized", which is the safe half:
        // it records a size rather than silently keeping an old one.
        maximized: window.is_maximized().unwrap_or(false),
    })
}

/// Fold a live reading into the geometry worth remembering, and remember it.
fn remember(reading: WindowState) -> WindowState {
    let mut slot = match LAST_GEOMETRY.lock() {
        Ok(slot) => slot,
        Err(_) => return reading,
    };
    let next = match slot.as_ref() {
        Some(previous) => previous.merge(&reading),
        None => reading,
    };
    *slot = Some(next.clone());
    next
}

/// Own the record file on a thread of its own, one write at a time.
///
/// The event callback must not write: a drag emits an event per pixel, and each
/// write is a create, a write and a rename on the reader's disk. So the
/// callback only hands the newest geometry over a channel, and this thread
/// keeps replacing it while events keep arriving and writes when the burst goes
/// quiet. Losing the sender while a write is still pending - the window being
/// destroyed, which is the ordinary way to close it - writes that pending value
/// on the way out rather than dropping it.
fn spawn_geometry_writer(path: PathBuf) -> Sender<WindowState> {
    let (sender, receiver) = mpsc::channel::<WindowState>();
    thread::spawn(move || {
        loop {
            // Block until there is something to write at all...
            let mut latest = match receiver.recv() {
                Ok(state) => state,
                Err(_) => return,
            };
            // ...then coalesce: every newer reading replaces this one until the
            // burst is over, so a whole drag costs exactly one write.
            loop {
                match receiver.recv_timeout(GEOMETRY_WRITE_DELAY) {
                    Ok(state) => latest = state,
                    Err(RecvTimeoutError::Timeout) => break,
                    // The sender is gone - the window was destroyed - and this
                    // reading is the last one there will ever be.
                    Err(RecvTimeoutError::Disconnected) => {
                        write_geometry(&path, &latest);
                        return;
                    }
                }
            }
            write_geometry(&path, &latest);
        }
    });
    sender
}

/// Write the record, and never make a failure anybody's problem.
///
/// A window that cannot remember its geometry still opens; it just opens at the
/// default size next time. So this prints one line and returns.
fn write_geometry(path: &Path, state: &WindowState) {
    if let Err(error) = windowstate::save(path, state) {
        eprintln!(
            "[vn-harness] could not remember the window geometry in {}: {error}",
            path.display()
        );
    }
}

/// Write the geometry one last time, so a clean close always records it.
///
/// Synchronous on purpose: this runs on the way out, and a value handed to the
/// debounced writer might not have reached the disk before the process ends.
/// The live window is asked first - it is the most accurate answer, and it is
/// still there on the `ExitRequested` pass - and a window that is already gone
/// leaves the last observation, which is the same geometry the writer had
/// pending. Writing twice is harmless: both writes carry the same record.
fn record_final_geometry(app: &AppHandle, state_path: Option<&Path>) {
    let Some(path) = state_path else {
        // No resolved harness home: there is nowhere honest to write.
        return;
    };
    let state = match app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|window| snapshot(&window))
    {
        Some(reading) => remember(reading),
        None => match LAST_GEOMETRY.lock() {
            Ok(slot) => match slot.as_ref() {
                Some(state) => state.clone(),
                None => return,
            },
            Err(_) => return,
        },
    };
    write_geometry(path, &state);
}

/// Report a failure in the two places a person can actually see: this console,
/// and the title of the window still showing the splash.
fn fail(app: &AppHandle, message: &str) {
    eprintln!("[vn-harness] {message}");
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.set_title("vn-harness - the harness server did not start (see the console window)");
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
    let port = match choose_port(&options) {
        Some(port) => port,
        None => return fail(&app, "could not find a free loopback port to listen on"),
    };

    println!("[vn-harness] desktop shell");
    println!("[vn-harness] Pinned dsh version: {version}");
    match reported_home(&options) {
        Some(home) => println!("[vn-harness] DSH_HOME: {}", home.display()),
        None => println!(
            "[vn-harness] DSH_HOME: not set, and no home directory to default to; the harness will decide"
        ),
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
    // `-DshHome` / an inherited `DSH_HOME`, and NOTHING else: with neither, the
    // child is left to the harness's own `~/.dsh` default (see `explicit_home`).
    if let Some(home) = explicit_home(&options) {
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

    // The record's path is resolved ONCE, here, through the same home resolver
    // the rest of this shell uses, and handed to both halves that need it: the
    // window that restores it and the exit hook that writes it. `None` means no
    // harness home could be resolved at all, and then the window simply has no
    // memory - a path is never invented (see `reported_home`).
    let state_path = reported_home(&options).map(|home| windowstate::state_path(&home));

    let setup_path = state_path.clone();
    let app = match tauri::Builder::default()
        .setup(move |app| {
            // The window first, so something is on screen while npx works.
            build_window(app.handle(), setup_path.as_deref())?;
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

    app.run(move |handle, event| match event {
        // The last chance to read the window: `ExitRequested` still has it, so
        // the final geometry is measured rather than remembered from an event.
        RunEvent::ExitRequested { .. } => record_final_geometry(handle, state_path.as_deref()),
        RunEvent::Exit => {
            // `Exit` is unconditional and `ExitRequested` is not always seen
            // (a window destroyed by the system, say), so the record is written
            // on the way out either way - and both writes carry the same state.
            record_final_geometry(handle, state_path.as_deref());
            kill_child_tree();
        }
        _ => {}
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
/// The home and port decisions, pinned.
///
/// These are pure on purpose, like `readyline`'s: the launch-token rules are
/// tested there and the "which harness does this window show" rules are tested
/// here, so the one mistake that made the desktop shell open a second, empty
/// harness can never come back unnoticed.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_home_is_invented_when_nothing_was_chosen() {
        // The bug this pins: with neither `-DshHome` nor `DSH_HOME`, the shell
        // used to fall back to HOME/USERPROFILE - the user's home, handed over
        // as if it were the harness home - and the harness bootstrapped a fresh
        // unadorned profile there. Nothing chosen must mean nothing exported.
        assert_eq!(chosen_home(None, None), None);
        assert_eq!(chosen_home(Some(""), None), None);
        assert_eq!(chosen_home(Some("   "), None), None);
        assert_eq!(chosen_home(None, Some("\t")), None);
    }

    #[test]
    fn the_flag_wins_over_the_inherited_variable() {
        assert_eq!(
            chosen_home(Some("D:\\dsh"), Some("C:\\Users\\someone")),
            Some("D:\\dsh".to_string())
        );
        assert_eq!(
            chosen_home(None, Some("C:\\Users\\someone")),
            Some("C:\\Users\\someone".to_string())
        );
    }

    #[test]
    fn a_chosen_home_is_trimmed() {
        assert_eq!(chosen_home(Some("  D:\\dsh  "), None), Some("D:\\dsh".to_string()));
    }

    #[test]
    fn the_default_home_appends_dsh_and_is_never_the_user_home() {
        let user_home = std::path::Path::new("some-user-home");
        let resolved = default_dsh_home(user_home);
        assert_eq!(resolved.file_name().and_then(|name| name.to_str()), Some(".dsh"));
        assert_ne!(resolved, user_home, "the harness home is ~/.dsh, not ~");
    }

    #[test]
    fn windows_prefers_userprofile_because_node_does() {
        assert_eq!(
            pick_home_variable(Some("C:\\Users\\me"), Some("C:\\elsewhere"), true),
            Some("C:\\Users\\me")
        );
        // ...and still falls back rather than giving up.
        assert_eq!(pick_home_variable(None, Some("C:\\elsewhere"), true), Some("C:\\elsewhere"));
    }

    #[test]
    fn unix_prefers_home() {
        assert_eq!(pick_home_variable(None, Some("/home/me"), false), Some("/home/me"));
        assert_eq!(
            pick_home_variable(Some("C:\\Users\\me"), Some("/home/me"), false),
            Some("/home/me")
        );
    }

    #[test]
    fn blank_home_variables_do_not_count() {
        assert_eq!(pick_home_variable(Some(""), None, true), None);
        assert_eq!(pick_home_variable(Some("   "), None, true), None);
        assert_eq!(pick_home_variable(None, None, false), None);
    }

    #[test]
    fn the_geometry_record_lives_under_the_resolved_harness_home() {
        // The seam the window geometry hangs off: one home resolution, the
        // pack's own folder under it, and the record inside that. `-DshHome`
        // wins over anything inherited, so this pins the wiring without
        // touching the real environment.
        let options = Options {
            dsh_home: Some("/tmp/some-dsh-home".to_string()),
            ..Options::default()
        };
        let path = reported_home(&options).map(|home| windowstate::state_path(&home));
        let expected = PathBuf::from("/tmp/some-dsh-home")
            .join("vn-harness")
            .join("window.json");
        assert_eq!(path, Some(expected));
    }

    #[test]
    fn an_explicit_port_always_wins() {
        // 3099 rather than the default, and no network is touched for it.
        let options = Options {
            port: 3099,
            ..Options::default()
        };
        assert_eq!(choose_port(&options), Some(3099));
    }
}
