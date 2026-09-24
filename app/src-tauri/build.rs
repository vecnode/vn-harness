fn main() {
    // Reads tauri.conf.json at compile time (the config, the app identifier and
    // the icons in bundle.icon) and generates the context the binary links
    // against, including the Windows resource that carries the icon into the
    // .exe. A malformed config or a missing icon fails HERE, with the field
    // named, which is why `cargo build` is the check and no Tauri CLI is
    // involved.
    tauri_build::build()
}
