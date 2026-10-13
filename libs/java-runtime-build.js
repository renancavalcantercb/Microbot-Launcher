const crypto = require('crypto');
const childProcess = require('child_process');
const { SHA256_PATTERN, sha256File } = require('./embedded-runtime');

// Build-time helpers for the embedded Java runtime (B-3.1). Everything here fails closed: any
// mismatch between the pin, the downloaded archive, the publisher's checksum file or the
// publisher's signature stops the build.

const PIN_FILE = 'config/java-runtime.json';
const FINGERPRINT_PATTERN = /^[0-9A-F]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ALLOWED_DOWNLOAD_PREFIX = 'https://github.com/adoptium/temurin17-binaries/releases/download/';

class RuntimeBuildError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RuntimeBuildError';
    }
}

function fail(message) {
    throw new RuntimeBuildError(message);
}

function validatePin(pin) {
    if (!pin || pin.schemaVersion !== 1) fail('java-runtime.json: unsupported schemaVersion');
    if (!/^17\.\d+\.\d+(?:\.\d+)?$/.test(pin.javaVersion || '')) fail('java-runtime.json: javaVersion must be a Java 17 version');
    if (!/^17\.\d+\.\d+(?:\.\d+)?\+\d+$/.test(pin.fullVersion || '')) fail('java-runtime.json: fullVersion is invalid');
    const archive = pin.archive || {};
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(archive.name || '')) fail('java-runtime.json: archive.name is invalid');
    if (!SHA256_PATTERN.test(archive.sha256 || '')) fail('java-runtime.json: archive.sha256 is invalid');
    for (const field of ['url', 'signatureUrl', 'checksumUrl']) {
        if (typeof archive[field] !== 'string' || !archive[field].startsWith(ALLOWED_DOWNLOAD_PREFIX)) {
            fail(`java-runtime.json: archive.${field} must be a GitHub release asset of adoptium/temurin17-binaries`);
        }
    }
    if (!FINGERPRINT_PATTERN.test(pin.signing?.keyFingerprint || '')) fail('java-runtime.json: signing.keyFingerprint is invalid');
    if (typeof pin.signing?.publicKeyFile !== 'string') fail('java-runtime.json: signing.publicKeyFile is required');
    if (!COMMIT_PATTERN.test(pin.sources?.jdk17u || '') || !COMMIT_PATTERN.test(pin.sources?.temurinBuild || '')) {
        fail('java-runtime.json: sources must hold the jdk17u and temurin-build commits');
    }
    if (!Array.isArray(pin.jlink?.modules) || pin.jlink.modules.length === 0 || pin.jlink.modules.some((m) => !/^[a-z][a-z0-9.]*$/.test(m))) {
        fail('java-runtime.json: jlink.modules is invalid');
    }
    for (const required of ['java.base', 'jdk.crypto.mscapi', 'jdk.compiler', 'jdk.attach', 'jdk.jcmd']) {
        if (!pin.jlink.modules.includes(required)) fail(`java-runtime.json: jlink.modules must include ${required}`);
    }
    if (pin.image?.sha256 !== undefined && pin.image.sha256 !== null && !SHA256_PATTERN.test(pin.image.sha256)) {
        fail('java-runtime.json: image.sha256 is invalid');
    }
    return pin;
}

// "<hex>  <file name>" as published next to the archive.
function parseChecksumFile(text, archiveName) {
    for (const line of String(text).split(/\r?\n/)) {
        const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line.trim());
        if (match && match[2] === archiveName) return match[1].toLowerCase();
    }
    return fail(`the publisher's checksum file has no entry for ${archiveName}`);
}

function verifyArchive({ fs, archivePath, pin, checksumText }) {
    const actual = sha256File(fs, archivePath);
    if (actual !== pin.archive.sha256) {
        fail(`the archive SHA-256 ${actual} does not match the pinned ${pin.archive.sha256}`);
    }
    const published = parseChecksumFile(checksumText, pin.archive.name);
    if (published !== actual) {
        fail(`the archive SHA-256 ${actual} does not match the publisher's checksum ${published}`);
    }
    return actual;
}

function fingerprintsIn(colonListing) {
    const result = [];
    let afterKey = false;
    for (const line of colonListing.split(/\r?\n/)) {
        const fields = line.split(':');
        if (fields[0] === 'pub' || fields[0] === 'sub') afterKey = true;
        if (fields[0] === 'fpr' && afterKey) result.push(fields[9]);
    }
    return result;
}

/**
 * Verifies the detached signature with gpg in a throw-away home directory. The key must be the
 * pinned one: the file's fingerprint is compared with the pin, and the signature must be VALIDSIG
 * from exactly that fingerprint.
 */
// MSYS builds of gpg read C:\... as a relative path; forward slashes work on every build.
const gpgPath = (value) => String(value).split(String.fromCharCode(92)).join('/');

function verifySignature({ fs, path, os, gpg = 'gpg', gpgv = 'gpgv', archivePath, signaturePath, publicKeyPath, fingerprint, run = childProcess.spawnSync }) {
    // gpg is used only to read and convert the key file, and gpgv (verification only, no agent)
    // to check the signature, both in a throw-away home directory.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'java-runtime-gpg-'));
    try {
        const gpgRun = (args) =>
            run(gpg, ['--homedir', gpgPath(home), '--batch', '--no-tty', ...args.map(gpgPath)], { encoding: 'utf8' });
        const listing = gpgRun(['--show-keys', '--with-colons', '--fingerprint', publicKeyPath]);
        if (listing.error || listing.status !== 0) {
            fail(`gpg could not read the publisher's key file (is gpg installed?): ${listing.error?.message || listing.stderr}`);
        }
        const keys = fingerprintsIn(listing.stdout || '');
        if (!keys.includes(fingerprint)) {
            fail(`the publisher's key file does not hold the pinned fingerprint ${fingerprint}`);
        }
        const keyring = path.join(home, 'publisher.gpg');
        const converted = gpgRun(['--dearmor', '--output', keyring, publicKeyPath]);
        if (converted.error || converted.status !== 0) {
            fail(`gpg could not convert the publisher's key: ${converted.error?.message || converted.stderr}`);
        }
        const verified = run(gpgv, ['--keyring', gpgPath(keyring), '--status-fd', '1', gpgPath(signaturePath), gpgPath(archivePath)], { encoding: 'utf8' });
        const line = (verified.stdout || '').split(String.fromCharCode(10)).map((entry) => entry.trim()).find((entry) => entry.startsWith('[GNUPG:] VALIDSIG '));
        if (verified.error || verified.status !== 0 || !line) {
            fail('the signature of the archive is not valid');
        }
        // VALIDSIG <signing key fingerprint> ... <primary key fingerprint>
        const tokens = line.split(' ');
        const signingKey = tokens[2];
        const primaryKey = tokens[tokens.length - 1];
        if (signingKey !== fingerprint && primaryKey !== fingerprint) {
            fail(`the archive is signed by ${signingKey}, not by the pinned ${fingerprint}`);
        }
        return { signer: signingKey };
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

function jlinkArguments({ pin, jmodsDir, outputDir }) {
    return [
        '--module-path',
        jmodsDir,
        '--add-modules',
        [...pin.jlink.modules].sort().join(','),
        '--output',
        outputDir,
        ...pin.jlink.options
    ];
}

function sha256Text(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
    ALLOWED_DOWNLOAD_PREFIX,
    PIN_FILE,
    RuntimeBuildError,
    jlinkArguments,
    parseChecksumFile,
    sha256Text,
    validatePin,
    verifyArchive,
    verifySignature
};
