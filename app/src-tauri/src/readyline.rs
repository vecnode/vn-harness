//! The one line the harness prints, and the two rules that follow from it.
//!
//! Once its server is listening the harness writes a single line to stdout:
//!
//! ```text
//! dsh web: http://127.0.0.1:3080/?token=<launch token> (LAN: http://<ip>:<port>/?token=<launch token>)
//! ```
//!
//! That URL is the only way into the app, and its `token` is a LIVE CREDENTIAL
//! for the running process (it is what the server exchanges for the browser
//! session cookie). Two rules therefore hold here, exactly as they hold in the
//! Windows and POSIX halves of the browser launcher:
//!
//! 1. The token is read IN MEMORY. It is never written to a file, never echoed
//!    (the line is printed [`redact`]ed) and never passed through a shell - the
//!    URL reaches the webview as one value, never as a command string.
//! 2. A URL that does not name a loopback address is refused rather than opened
//!    ([`is_loopback_host`]), because handing this credential to anything else
//!    is the one mistake that cannot be walked back.
//!
//! Everything in this module is pure so it can be tested without a window, a
//! server or a network - `cargo test` is the check, and this is where the
//! launch-token rules are actually pinned.

/// The mark the harness prefixes its ready line with. A line without it is
/// just output, however much it looks like a URL.
const READY_MARKER: &str = "dsh web:";

/// Strip ANSI escape sequences.
///
/// The harness colourises its output, and a profile can colourise it further,
/// so the escape codes can sit INSIDE the URL (`.../?tok<ESC>[0m<ESC>[32men=`).
/// Both the ready-line parser and the console printer go through this, which is
/// why a coloured ready line is not a parsing failure.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... , ended by any byte in the @-~ range.
            Some('[') => {
                chars.next();
                for candidate in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&candidate) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... , ended by BEL or ST (ESC \).
            Some(']') => {
                chars.next();
                while let Some(candidate) = chars.next() {
                    if candidate == '\u{7}' {
                        break;
                    }
                    if candidate == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // A bare escape, or an escape introducing a single-character
            // sequence: drop the escape and let the next character stand.
            _ => {}
        }
    }
    out
}

/// Pull the URL out of a ready line, or `None` when the line is not one.
///
/// The FIRST URL on the line is the loopback one; the `(LAN: ...)` suffix that
/// may follow it is a second URL for another host and is deliberately not
/// returned.
pub fn extract_ready_url(line: &str) -> Option<String> {
    let clean = strip_ansi(line);
    if !clean.contains(READY_MARKER) {
        return None;
    }
    let start = clean.find("http://").or_else(|| clean.find("https://"))?;
    let rest = &clean[start..];
    let end = rest
        .find(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',', ')', ']', '"', '\'']);
    if url.len() <= "https://".len() {
        return None;
    }
    Some(url.to_string())
}

/// Whether a host names this machine's own loopback interface.
///
/// Both spellings of the IP addresses are accepted, with or without the
/// brackets a URL puts around an IPv6 literal, because the check is applied to
/// what the harness printed (a bare address) and to what the URL parser
/// produced (which may keep the brackets).
pub fn is_loopback_host(host: &str) -> bool {
    let bare = host.trim().trim_start_matches('[').trim_end_matches(']');
    if bare.eq_ignore_ascii_case("localhost") {
        return true;
    }
    bare.parse::<std::net::IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

/// Replace every `token=...` value with `REDACTED`, leaving the rest of the
/// line - including both URLs - intact.
///
/// This is what makes it safe to print the harness's own output: the line stays
/// useful for diagnosing a failed start, and the credential in it does not
/// reach a console, a scrollback buffer or a screenshot of one.
pub fn redact(line: &str) -> String {
    const NEEDLE: &str = "token=";
    const MASK: &str = "token=REDACTED";
    if !line.contains(NEEDLE) {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(at) = rest.find(NEEDLE) {
        out.push_str(&rest[..at]);
        out.push_str(MASK);
        let after = &rest[at + NEEDLE.len()..];
        let end = after
            .find(|ch: char| ch.is_whitespace() || ch == '&' || ch == ')' || ch == '"' || ch == '\'')
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real shape of the line, as the harness prints it.
    const READY: &str = "dsh web: http://127.0.0.1:3080/?token=s3cret-value (LAN: http://192.168.1.7:3080/?token=s3cret-value)";

    #[test]
    fn strip_ansi_removes_colour_codes() {
        let coloured = "\u{1b}[32mdsh web:\u{1b}[0m \u{1b}[36mhttp://127.0.0.1:3080/\u{1b}[0m";
        assert_eq!(strip_ansi(coloured), "dsh web: http://127.0.0.1:3080/");
    }

    #[test]
    fn strip_ansi_removes_an_osc_title() {
        let titled = "\u{1b}]0;dsh\u{7}dsh web: http://127.0.0.1:3080/";
        assert_eq!(strip_ansi(titled), "dsh web: http://127.0.0.1:3080/");
    }

    #[test]
    fn strip_ansi_leaves_plain_text_alone() {
        assert_eq!(strip_ansi(READY), READY);
    }

    #[test]
    fn extract_ready_url_takes_the_loopback_url_not_the_lan_one() {
        assert_eq!(extract_ready_url(READY).as_deref(), Some("http://127.0.0.1:3080/?token=s3cret-value"));
    }

    #[test]
    fn extract_ready_url_ignores_a_line_without_the_marker() {
        assert_eq!(extract_ready_url("see http://127.0.0.1:3080/ for the app"), None);
    }

    #[test]
    fn extract_ready_url_ignores_a_marker_with_no_url() {
        assert_eq!(extract_ready_url("dsh web: listening"), None);
    }

    #[test]
    fn extract_ready_url_works_through_colour_codes() {
        let coloured = "\u{1b}[32mdsh web:\u{1b}[0m \u{1b}[36mhttp://127.0.0.1:41287/?token=abc\u{1b}[0m (LAN: http://10.0.0.4:41287/?token=abc)";
        assert_eq!(extract_ready_url(coloured).as_deref(), Some("http://127.0.0.1:41287/?token=abc"));
    }

    #[test]
    fn extract_ready_url_trims_a_trailing_paren() {
        assert_eq!(
            extract_ready_url("dsh web: http://127.0.0.1:3080/").as_deref(),
            Some("http://127.0.0.1:3080/")
        );
        assert_eq!(
            extract_ready_url("dsh web: (http://127.0.0.1:3080/)").as_deref(),
            Some("http://127.0.0.1:3080/")
        );
    }

    #[test]
    fn loopback_hosts_are_accepted() {
        for host in ["127.0.0.1", "127.0.0.2", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "{host} should be loopback");
        }
    }

    #[test]
    fn other_hosts_are_refused() {
        for host in ["10.0.0.5", "192.168.1.7", "0.0.0.0", "example.com", "127.0.0.1.example.com", "", "tauri.localhost"] {
            assert!(!is_loopback_host(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn redact_hides_both_token_values() {
        let redacted = redact(READY);
        assert!(!redacted.contains("s3cret-value"), "the token survived redaction: {redacted}");
        assert_eq!(redacted.matches("token=REDACTED").count(), 2);
        // The line stays diagnosable: the URLs are still there.
        assert!(redacted.contains("http://127.0.0.1:3080/"));
        assert!(redacted.contains("http://192.168.1.7:3080/"));
    }

    #[test]
    fn redact_stops_at_the_parameter_end() {
        let line = "GET /?token=abc&x=1";
        assert_eq!(redact(line), "GET /?token=REDACTED&x=1");
    }

    #[test]
    fn redact_leaves_a_line_without_a_token_alone() {
        let line = "dsh web: starting";
        assert_eq!(redact(line), line);
    }

    #[test]
    fn redact_keeps_a_redacted_line_stable() {
        let once = redact(READY);
        assert_eq!(redact(&once), once);
    }
}
