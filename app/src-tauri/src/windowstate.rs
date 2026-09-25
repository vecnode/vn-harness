//! The window's own memory: where it was and how big it was, across launches.
//!
//! A window that forgets its size every launch is a window the reader has to
//! place again every morning, so the shell keeps ONE small record of geometry
//! and restores it. The record lives at `<harness home>/vn-harness/window.json`
//! - the `$DSH_HOME`-rooted shape the rest of this pack uses for its own state
//! (`$DSH_HOME/dsh-pdf`, `$DSH_HOME/dsh-diagrams`). The home itself is resolved
//! by `main.rs` through `reported_home` and handed in here; this module never
//! looks at `DSH_HOME` itself, and never invents a directory to write into.
//!
//! ```json
//! { "version": 1, "width": 1440, "height": 900, "x": 100, "y": 100, "maximized": false }
//! ```
//!
//! Five rules govern that file, and every one of them exists so that a record
//! written by a DIFFERENT build - or truncated by a machine that lost power
//! mid-write - can never stop the window from opening:
//!
//! 1. `width`/`height` are the window's INNER size and `x`/`y` the OUTER
//!    position, all four in LOGICAL pixels. Logical is the unit the window
//!    builder takes, and it is the only unit that means the same thing on a
//!    100% and on a 150% display; `main.rs` divides the physical readings by
//!    the window's scale factor on the way in and hands the values straight
//!    back out.
//! 2. A record this build cannot vouch for is DISCARDED, never repaired: an
//!    unreadable file, JSON that does not parse, a `version` that is not 1, a
//!    width or height that is absent, non-numeric, non-finite, or below the
//!    smallest window the shell builds. The caller falls back to exactly the
//!    geometry the shell opened at before this file existed.
//! 3. A width or height ABOVE the platform's practical ceiling is CLAMPED
//!    rather than refused, because the number is plausible and the platform
//!    simply cannot honour it - and discarding the record would also discard
//!    the position and the maximized flag sitting beside it.
//! 4. A position is honoured only when BOTH `x` and `y` are present, numeric
//!    and finite ([`WindowState::position`]). A half-written pair, a string or
//!    `null` means "centre the window", never "trust the one number that was
//!    there". Whether the point names a monitor that still exists is a question
//!    only a live machine can answer, so the pair is handed out and `main.rs`
//!    runs it past Tauri's monitor list.
//! 5. A write is ATOMIC - a temp sibling, then a rename - and creates the
//!    containing directory. A reader of this file therefore sees the whole of
//!    one version or the whole of the other, never a half-written line, and a
//!    failure costs one launch's geometry and nothing else.
//!
//! Nothing here refers to a `tauri` type: this is the pure half of the feature,
//! and `cargo test` drives all of it directly (see the tests at the bottom).

use std::fmt;
use std::path::{Path, PathBuf};

/// The size the shell opens at when there is nothing to restore - today's
/// geometry, unchanged, and the answer to every rejection above.
pub const DEFAULT_WIDTH: f64 = 1440.0;
pub const DEFAULT_HEIGHT: f64 = 900.0;

/// The smallest window worth restoring, and the same floor the builder puts on
/// the live window (`min_inner_size`).
///
/// A record below it is not a window the shell could have produced, so it is a
/// foreign or damaged number rather than a choice to honour - and growing a
/// window the reader deliberately shrank is not this file's decision to make.
pub const MIN_WIDTH: f64 = 960.0;
pub const MIN_HEIGHT: f64 = 640.0;

/// The platform's practical ceiling for a window dimension: the largest value
/// Win32's coordinates carry, and no display in existence is wider.
///
/// Above it the number is clamped rather than refused - see rule 3 in the
/// module docs for why the whole record is worth keeping.
pub const MAX_SIDE: f64 = 32767.0;

/// The format version this build writes and the only one it reads.
///
/// It exists so that a future layout can be told apart from this one instead of
/// being misread field by field; a `version` that is missing, non-numeric or
/// not this number is therefore unknown, and "no version" is deliberately not
/// treated as "version 1".
const VERSION: i64 = 1;

/// The folder this record lives in under the harness home. The harness home is
/// `~/.dsh` itself - not `~` - so the full path is `~/.dsh/vn-harness/window.json`.
const STATE_DIR: &str = "vn-harness";

/// The file name inside [`STATE_DIR`].
const STATE_FILE: &str = "window.json";

/// Where the record lives for a given harness home.
///
/// A plain join on purpose: the home has already been resolved by the one
/// resolver this shell has, and a second rule about where `$DSH_HOME` points is
/// exactly the bug `main.rs` documents at length.
pub fn state_path(home: &Path) -> PathBuf {
    home.join(STATE_DIR).join(STATE_FILE)
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------
/// The remembered geometry: two sizes, an optional point, and one flag.
///
/// `x`/`y` are read through [`WindowState::position`] rather than directly, so
/// that the "both, numeric and finite, or centre" rule is applied in one place.
#[derive(Debug, Clone, PartialEq)]
pub struct WindowState {
    /// The window's inner size in logical pixels.
    pub width: f64,
    pub height: f64,
    /// The window's outer position in logical pixels, when there is one.
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// Whether the window was maximized when the record was written.
    ///
    /// The size beside it is still the RESTORED size, because that is the one
    /// worth keeping: see [`WindowState::merge`].
    pub maximized: bool,
}

impl WindowState {
    /// The geometry today's behaviour means: 1440x900, centred, not maximized.
    pub fn first_launch() -> Self {
        WindowState {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            maximized: false,
        }
    }

    /// The point to restore, or `None` for "centre the window".
    ///
    /// The one decision the pure half can make about a position: the numbers
    /// are honoured only TOGETHER and only when both are real. Which monitor
    /// (if any) that point names is the caller's check, because it needs the
    /// machine's monitor list.
    pub fn position(&self) -> Option<(f64, f64)> {
        match (self.x, self.y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some((x, y)),
            _ => None,
        }
    }

    /// Whether this is a size the shell could have built a window at.
    ///
    /// A live window reports 0x0 and an off-screen position while it is
    /// MINIMIZED on Windows, so this is what tells a real reading from a
    /// minimized one. Two rules lean on it: [`WindowState::merge`] keeps the
    /// recorded size when a reading is not one, and [`save`] refuses to write a
    /// state that is not one - so a bad reading can neither be recorded nor
    /// destroy the record that is already on disk.
    pub fn size_is_usable(&self) -> bool {
        self.width.is_finite()
            && self.height.is_finite()
            && self.width >= MIN_WIDTH
            && self.height >= MIN_HEIGHT
    }

    /// Fold a fresh reading of the LIVE window into the record worth writing.
    ///
    /// A maximized window reports the SCREEN's size and the position the
    /// window manager parked it at, and a minimized one on Windows reports
    /// 0x0 - none of which is the geometry the reader chose. So a reading that
    /// is not a size the window could have been built at, or that arrives
    /// maximized, keeps the size and the position already recorded and only
    /// updates the flag. That is what makes "restore the size, then maximize"
    /// mean something: un-maximizing gives back the window the reader had,
    /// instead of a window the size of the display.
    pub fn merge(&self, reading: &WindowState) -> WindowState {
        let chosen = reading.size_is_usable() && !reading.maximized;
        WindowState {
            width: if chosen { reading.width } else { self.width },
            height: if chosen { reading.height } else { self.height },
            x: if chosen { reading.x } else { self.x },
            y: if chosen { reading.y } else { self.y },
            maximized: reading.maximized,
        }
    }
}

// ---------------------------------------------------------------------------
// Reading the record
// ---------------------------------------------------------------------------
/// Why a remembered geometry was not used.
///
/// Every variant means the same thing to the window - build [`WindowState::first_launch`] -
/// and they exist so the console can say WHICH, and so the tests can pin each
/// rule separately. Nothing here is a failure of the shell: a missing file is
/// the ordinary first launch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unusable {
    /// No file yet: the first launch, which is not a fault and wants no line
    /// on the console.
    Absent,
    /// The file is there but could not be read (permissions, a directory in
    /// its place, a bad disk).
    Unreadable,
    /// Not JSON at all, or JSON that is not an object.
    Malformed,
    /// A `version` that is missing, not a number, or not one this build knows.
    UnknownVersion,
    /// A width or height that is absent, not a number, or not finite.
    Size,
    /// A width or height below the smallest window the shell builds.
    TooSmall,
}

impl fmt::Display for Unusable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Unusable::Absent => "there is no remembered geometry yet",
            Unusable::Unreadable => "the file could not be read",
            Unusable::Malformed => "the file is not a JSON object",
            Unusable::UnknownVersion => "the file is not a window record this build knows (version 1)",
            Unusable::Size => "the width or height is missing, or is not a finite number",
            Unusable::TooSmall => "the width or height is below the smallest window this shell builds (960x640)",
        };
        formatter.write_str(reason)
    }
}

/// Read the record from disk, or say why it was not used.
///
/// A missing file is [`Unusable::Absent`] rather than an I/O error because the
/// two want different treatment: the first launch is silent, and anything else
/// earns one line on the console.
pub fn load(path: &Path) -> Result<WindowState, Unusable> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(Unusable::Absent),
        Err(_) => Err(Unusable::Unreadable),
    }
}

/// Turn the file's text into the record, or say which rule refused it.
pub fn parse(text: &str) -> Result<WindowState, Unusable> {
    let json: serde_json::Value = serde_json::from_str(text).map_err(|_| Unusable::Malformed)?;
    let object = json.as_object().ok_or(Unusable::Malformed)?;

    // A version check before anything else is read: the fields below are only
    // this shape's fields if the file says it is this shape.
    if object.get("version").and_then(serde_json::Value::as_i64) != Some(VERSION) {
        return Err(Unusable::UnknownVersion);
    }

    let width = number(object, "width").ok_or(Unusable::Size)?;
    let height = number(object, "height").ok_or(Unusable::Size)?;
    let (width, height) = clamp_size(width, height)?;

    Ok(WindowState {
        width,
        height,
        // A position that is not a pair of real numbers is not a position: the
        // window is centred, and the size above is still restored.
        x: number(object, "x"),
        y: number(object, "y"),
        // Absent means false, which is also what an unreadable flag means: the
        // window is not maximized unless the file says so in so many words.
        maximized: object
            .get("maximized")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

/// The size rules, in one place: refuse what is not a window, clamp what the
/// platform cannot honour.
fn clamp_size(width: f64, height: f64) -> Result<(f64, f64), Unusable> {
    // A string, `null` or `true` never gets this far - [`number`] drops those -
    // but a live reading and a hand-built state can still carry a NaN or an
    // infinity, JSON cannot spell one, and neither is a window size.
    if !width.is_finite() || !height.is_finite() {
        return Err(Unusable::Size);
    }
    if width < MIN_WIDTH || height < MIN_HEIGHT {
        return Err(Unusable::TooSmall);
    }
    Ok((width.min(MAX_SIDE), height.min(MAX_SIDE)))
}

/// One optional number out of the object, accepted only when it is finite.
fn number(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<f64> {
    object.get(key)?.as_f64().filter(|value| value.is_finite())
}

// ---------------------------------------------------------------------------
// Writing the record
// ---------------------------------------------------------------------------
/// Write the record so the next launch restores it.
///
/// A state the window could not have been built at is REFUSED rather than
/// written: a bad reading must never be able to destroy a good record on disk,
/// and the caller treats the refusal like any other write failure - one line on
/// the console, and the launch goes on.
pub fn save(path: &Path, state: &WindowState) -> std::io::Result<()> {
    if !state.size_is_usable() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to remember a window size of {}x{}", state.width, state.height),
        ));
    }
    let mut text = serde_json::to_string_pretty(&to_json(state))
        // Unreachable for a `Value` built here, and still not a panic: the
        // caller's contract is that a write failure is never fatal.
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    text.push('\n');
    atomic_write(path, text.as_bytes())
}

/// The record as JSON, in the shape documented at the top of this module.
///
/// The position is written as a PAIR or not at all, so a half pair can never
/// reach the disk; `maximized` is always written, because a record that states
/// the flag is easier to read than one that leaves it out.
pub fn to_json(state: &WindowState) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    object.insert("version".to_string(), serde_json::json!(VERSION));
    object.insert("width".to_string(), number_json(state.width));
    object.insert("height".to_string(), number_json(state.height));
    if let Some((x, y)) = state.position() {
        object.insert("x".to_string(), number_json(x));
        object.insert("y".to_string(), number_json(y));
    }
    object.insert("maximized".to_string(), serde_json::Value::Bool(state.maximized));
    serde_json::Value::Object(object)
}

/// One number as JSON: a whole value goes in as an INTEGER, because these are
/// whole pixel counts and `1440.0` in the file reads like a measurement rather
/// than the count it is. A fractional logical coordinate (a window on a HiDPI
/// display can sit on half a pixel) keeps its fraction.
fn number_json(value: f64) -> serde_json::Value {
    const LARGEST_EXACT: f64 = 9_007_199_254_740_992.0; // 2^53
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= LARGEST_EXACT {
        return serde_json::Value::Number(serde_json::Number::from(value as i64));
    }
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

/// Write the bytes through a temp sibling and a rename.
///
/// The temp file is a SIBLING so the rename stays on one filesystem - a rename
/// across filesystems is a copy, which is neither atomic nor cheap - and its
/// name carries this process's id so two shells can never tread on each other's
/// temp file. There is deliberately no `fsync`: this is window geometry, and a
/// machine that dies mid-save loses one launch's size rather than an asset,
/// while the rename still guarantees nobody ever reads a half-written file.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    let temp = temp_sibling(path);
    if let Err(error) = std::fs::write(&temp, bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

/// `window.json` -> `window.json.<pid>.tmp`, beside it.
fn temp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from(STATE_FILE));
    let mut temp = name;
    temp.push(format!(".{}.tmp", std::process::id()));
    path.with_file_name(temp)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
/// The rules above, pinned.
///
/// These are pure on purpose, like `readyline`'s: what a saved window may and
/// may not restore is decided here, so a `cargo test` with no window, no
/// display and no harness server can still prove that a corrupt record costs a
/// reader nothing but the default geometry.
#[cfg(test)]
mod tests {
    use super::*;

    /// The documented record, spelled the way the module docs spell it.
    ///
    /// A JSON object has no order, and this build's serde_json writes the keys
    /// sorted, so nothing here depends on the order these fields are written in
    /// - only on the set of them.
    const RECORD: &str = r#"{
  "version": 1,
  "width": 1440,
  "height": 900,
  "x": 100,
  "y": 100,
  "maximized": false
}
"#;

    /// A scratch folder of our own, so a test never touches a real home.
    fn scratch(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("vn-harness-windowstate-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn a_full_record_round_trips() {
        let state = parse(RECORD).expect("the documented record must parse");
        assert_eq!(state.width, 1440.0);
        assert_eq!(state.height, 900.0);
        assert_eq!(state.position(), Some((100.0, 100.0)));
        assert!(!state.maximized);

        // Through the file, which is the trip that matters.
        let home = scratch("round-trip");
        let path = state_path(&home);
        save(&path, &state).expect("the record must save");
        assert_eq!(load(&path), Ok(state.clone()));
        // The bytes on disk, so the contract in the module docs is pinned as
        // text and not only as a re-parse of itself.
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(written.contains("\"version\": 1"), "the record must state its version: {written}");
        assert!(written.contains("\"width\": 1440"), "whole pixels are integers: {written}");
        assert!(written.ends_with('\n'), "a text file ends with a newline: {written:?}");

        // ...and through the text, so a fractional logical coordinate survives
        // a HiDPI display too.
        let fractional = WindowState {
            width: 1440.0,
            height: 900.0,
            x: Some(100.5),
            y: Some(-12.25),
            maximized: true,
        };
        let text = serde_json::to_string(&to_json(&fractional)).unwrap();
        assert_eq!(parse(&text), Ok(fractional));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn optional_fields_may_be_absent() {
        // x, y and maximized are all optional: the size is the whole record.
        let state = parse(r#"{"version":1,"width":1440,"height":900}"#).unwrap();
        assert_eq!(state.width, 1440.0);
        assert_eq!(state.height, 900.0);
        assert_eq!(state.position(), None, "no x/y means centre, not a guess");
        assert!(!state.maximized, "an absent flag means not maximized");
        // Nothing was written that the file did not say.
        assert!(to_json(&state).get("x").is_none());
        assert!(to_json(&state).get("y").is_none());
    }

    #[test]
    fn malformed_json_is_refused() {
        for text in ["", "   ", "not json", "{\"version\":1,", "[1,2,3]", "42", "\"window\"", "null"] {
            assert!(
                matches!(parse(text), Err(Unusable::Malformed)),
                "{text:?} should be refused as malformed"
            );
        }
    }

    #[test]
    fn an_unknown_version_is_refused() {
        // A version this build does not know, a version that is not a number,
        // and a record with no version at all: "no version" is not "version 1",
        // because a file written by some other tool is not one this build can
        // vouch for field by field.
        for text in [
            r#"{"version":2,"width":1440,"height":900}"#,
            r#"{"version":0,"width":1440,"height":900}"#,
            r#"{"version":"1","width":1440,"height":900}"#,
            r#"{"version":1.0,"width":1440,"height":900}"#,
            r#"{"width":1440,"height":900}"#,
        ] {
            assert!(
                matches!(parse(text), Err(Unusable::UnknownVersion)),
                "{text:?} should be refused as an unknown version"
            );
        }
    }

    #[test]
    fn a_size_below_the_minimum_is_refused() {
        for text in [
            r#"{"version":1,"width":959,"height":900}"#,
            r#"{"version":1,"width":1440,"height":639}"#,
            r#"{"version":1,"width":100,"height":100}"#,
            r#"{"version":1,"width":-1440,"height":-900}"#,
            r#"{"version":1,"width":0,"height":0}"#,
        ] {
            assert!(
                matches!(parse(text), Err(Unusable::TooSmall)),
                "{text:?} should be refused as too small"
            );
        }
        // The floor itself is allowed.
        assert!(parse(r#"{"version":1,"width":960,"height":640}"#).is_ok());
    }

    #[test]
    fn an_absurd_size_is_clamped_never_refused() {
        // The size is believable and the platform cannot honour it, so it is
        // clamped - the position and the flag beside it survive.
        let state = parse(r#"{"version":1,"width":40000,"height":90000,"x":10,"y":20,"maximized":true}"#).unwrap();
        assert_eq!(state.width, MAX_SIDE);
        assert_eq!(state.height, MAX_SIDE);
        assert_eq!(state.position(), Some((10.0, 20.0)));
        assert!(state.maximized);
        // The ceiling itself is not above the ceiling.
        assert_eq!(parse(r#"{"version":1,"width":32767,"height":32767}"#).unwrap().width, MAX_SIDE);
    }

    #[test]
    fn a_non_numeric_or_non_finite_size_is_refused() {
        for text in [
            r#"{"version":1,"width":"1440","height":900}"#,
            r#"{"version":1,"width":null,"height":900}"#,
            r#"{"version":1,"width":true,"height":900}"#,
            r#"{"version":1,"width":[1440],"height":900}"#,
        ] {
            assert!(
                matches!(parse(text), Err(Unusable::Size)),
                "{text:?} should be refused as a size that is not a number"
            );
        }
        // NaN and infinity cannot be written as JSON at all, so they are pinned
        // where they can arrive: a live reading or a hand-built state.
        assert!(matches!(clamp_size(f64::NAN, 900.0), Err(Unusable::Size)));
        assert!(matches!(clamp_size(1440.0, f64::NAN), Err(Unusable::Size)));
        assert!(matches!(clamp_size(f64::INFINITY, 900.0), Err(Unusable::Size)));
        assert!(matches!(clamp_size(1440.0, f64::NEG_INFINITY), Err(Unusable::Size)));
        assert_eq!(clamp_size(1440.0, 900.0), Ok((1440.0, 900.0)));
    }

    #[test]
    fn a_record_with_no_usable_position_is_centred() {
        let no_position = parse(RECORD).unwrap();
        // Both numbers present is the only case that is a position.
        assert_eq!(no_position.position(), Some((100.0, 100.0)));
        for text in [
            r#"{"version":1,"width":1440,"height":900}"#,
            r#"{"version":1,"width":1440,"height":900,"x":null,"y":null}"#,
            r#"{"version":1,"width":1440,"height":900,"x":"100","y":100}"#,
            r#"{"version":1,"width":1440,"height":900,"x":100}"#,
            r#"{"version":1,"width":1440,"height":900,"y":100}"#,
            // A position that is not a number is dropped WITHOUT costing the
            // size: only the point is unusable.
            r#"{"version":1,"width":1400,"height":700,"x":true,"y":100}"#,
        ] {
            let state = parse(text).unwrap_or_else(|error| panic!("{text:?} should parse: {error}"));
            assert_eq!(state.position(), None, "{text:?} should mean centre");
            assert!(state.width >= MIN_WIDTH && state.height >= MIN_HEIGHT);
        }
    }

    #[test]
    fn a_reading_that_is_not_the_readers_size_keeps_the_record() {
        let remembered = WindowState {
            width: 1200.0,
            height: 800.0,
            x: Some(40.0),
            y: Some(60.0),
            maximized: false,
        };

        // Maximized: the window reports the SCREEN, so the restored geometry is
        // kept and only the flag changes - which is what makes the next launch
        // able to restore a size worth un-maximizing to.
        let maximized = remembered.merge(&WindowState {
            width: 2560.0,
            height: 1440.0,
            x: Some(0.0),
            y: Some(0.0),
            maximized: true,
        });
        assert_eq!((maximized.width, maximized.height), (1200.0, 800.0));
        assert_eq!(maximized.position(), Some((40.0, 60.0)));
        assert!(maximized.maximized);

        // Minimized on Windows: 0x0 and an off-screen point are not a choice.
        let minimized = remembered.merge(&WindowState {
            width: 0.0,
            height: 0.0,
            x: Some(-32000.0),
            y: Some(-32000.0),
            maximized: false,
        });
        assert_eq!((minimized.width, minimized.height), (1200.0, 800.0));
        assert_eq!(minimized.position(), Some((40.0, 60.0)));
        assert!(!minimized.maximized);

        // A real drag replaces everything.
        let moved = remembered.merge(&WindowState {
            width: 1000.0,
            height: 700.0,
            x: Some(200.0),
            y: Some(150.0),
            maximized: false,
        });
        assert_eq!((moved.width, moved.height), (1000.0, 700.0));
        assert_eq!(moved.position(), Some((200.0, 150.0)));
    }

    #[test]
    fn a_size_the_window_could_not_be_built_at_is_never_written() {
        let home = scratch("unusable");
        let path = state_path(&home);
        save(&path, &WindowState::first_launch()).unwrap();

        let tiny = WindowState { width: 0.0, height: 0.0, x: None, y: None, maximized: false };
        assert!(save(&path, &tiny).is_err(), "an unusable size must be refused");
        // ...and the good record on disk is untouched by the refusal.
        assert_eq!(load(&path), Ok(WindowState::first_launch()));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn saving_creates_the_directory_and_leaves_no_temp_file() {
        let home = scratch("fresh");
        let path = state_path(&home);
        assert!(!home.exists(), "the scratch folder must not exist yet");

        save(&path, &WindowState::first_launch()).unwrap();
        assert!(path.is_file(), "the record must be written: {}", path.display());
        assert!(!temp_sibling(&path).exists(), "the temp sibling must be renamed away");

        // The write is a rename onto the real name, so a second save simply
        // leaves the newer record where the older one was.
        let moved = WindowState { width: 1000.0, height: 700.0, x: Some(-5.0), y: Some(5.0), maximized: true };
        save(&path, &moved).unwrap();
        assert_eq!(load(&path), Ok(moved));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_written_record_has_the_documented_shape() {
        let json = to_json(&WindowState::first_launch());
        assert_eq!(json.get("version").and_then(serde_json::Value::as_i64), Some(1));
        // Whole pixels are written as INTEGERS, which is what the documented
        // example shows: 1440, not 1440.0.
        assert_eq!(json.get("width").and_then(serde_json::Value::as_i64), Some(1440));
        assert_eq!(json.get("height").and_then(serde_json::Value::as_i64), Some(900));
        assert_eq!(json.get("maximized").and_then(serde_json::Value::as_bool), Some(false));
        assert!(json.get("x").is_none());
        assert!(json.get("y").is_none());

        let placed = to_json(&WindowState {
            width: 1440.0,
            height: 900.0,
            x: Some(100.0),
            y: Some(100.0),
            maximized: false,
        });
        assert_eq!(placed.get("x").and_then(serde_json::Value::as_i64), Some(100));
        assert_eq!(placed.get("y").and_then(serde_json::Value::as_i64), Some(100));
        // Field for field with the documented contract. Sorted, because the
        // ORDER of a JSON object is not part of a contract - and it depends on
        // how serde_json was built, which this test must not care about.
        let mut keys: Vec<&str> = placed.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["height", "maximized", "version", "width", "x", "y"]);
    }

    #[test]
    fn a_missing_file_is_absent_and_not_a_fault() {
        let home = scratch("missing");
        assert_eq!(load(&state_path(&home)), Err(Unusable::Absent));
        // A file that is there and cannot be read is a different answer, and
        // the difference is visible: only this one earns a line on the console.
        // A directory where the record should be is the cheapest way to make
        // one without touching permissions.
        let path = state_path(&home);
        std::fs::create_dir_all(&path).unwrap();
        assert_eq!(load(&path), Err(Unusable::Unreadable));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_path_hangs_off_the_harness_home_not_the_user_home() {
        // The bug this pins is the one `main.rs` documents: `DSH_HOME` names
        // `~/.dsh` itself, so the record goes UNDER it and never beside it.
        let harness_home = Path::new("/home/someone/.dsh");
        let path = state_path(harness_home);
        assert_eq!(path, harness_home.join("vn-harness").join("window.json"));
        assert!(path.starts_with(harness_home));
        assert_ne!(path.parent().and_then(Path::parent), Some(Path::new("/home/someone")), "the record belongs under the harness home");
    }

    #[test]
    fn display_says_something_a_reader_can_act_on() {
        for reason in [
            Unusable::Absent,
            Unusable::Unreadable,
            Unusable::Malformed,
            Unusable::UnknownVersion,
            Unusable::Size,
            Unusable::TooSmall,
        ] {
            let text = reason.to_string();
            assert!(!text.is_empty(), "{reason:?} needs a reason a reader can read");
        }
    }
}
