// A signed client release names the oldest launcher that can run it (client.minimumLauncherVersion,
// a validated "x.y.z" string). Launcher 3.2.11 and older ignore it; from 3.2.12 the launcher
// refuses a client that needs a newer launcher, before downloading it and before starting it, and
// tells the user to update. A manifest whose value is at or below the running launcher is not
// affected, so the manifests published so far (minimum 3.2.10) keep working.

const VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

class LauncherTooOldError extends Error {
    constructor(message, { required, current }) {
        super(message);
        this.name = 'LauncherTooOldError';
        this.required = required;
        this.current = current;
    }
}

function parseVersion(value, label) {
    const match = VERSION_PATTERN.exec(String(value || ''));
    if (!match) throw new Error(`${label} is not a valid launcher version`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
    const left = parseVersion(a, 'version');
    const right = parseVersion(b, 'version');
    for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
}

/**
 * Throws LauncherTooOldError when the client requires a newer launcher. An invalid launcher or
 * minimum version is an error too: the check never passes by default.
 */
function assertLauncherSupportsClient({ launcherVersion, client }) {
    const required = client?.minimumLauncherVersion;
    parseVersion(required, 'client.minimumLauncherVersion');
    parseVersion(launcherVersion, 'launcher version');
    if (compareVersions(launcherVersion, required) < 0) {
        throw new LauncherTooOldError(
            `This client needs Microbot Cut Launcher ${required} or newer (this launcher is ${launcherVersion}). ` +
                'Install the latest launcher and try again.',
            { required, current: launcherVersion }
        );
    }
}

module.exports = { LauncherTooOldError, assertLauncherSupportsClient, compareVersions };
