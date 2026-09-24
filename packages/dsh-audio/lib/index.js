/**
 * dsh-audio — Node half.
 *
 * The waveform viewer is browser-only: it registers a tab type into the right
 * bar's registry (dsh-rightbar) and reads the file's bytes through the
 * harness's own `remote.workspaceFiles` namespace, which already enforces the
 * workspace path policy and the byte caps. The host tree gains nothing, so this
 * row exists only so the package's `dsh.client` declaration puts its browser
 * bundle in the boot graph — exactly like the shipped
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` row it sits in front of.
 */
export const name = 'dsh-audio'

/** Host plugin body: the audio viewer contributes nothing to the host tree. */
export function apply() {}
