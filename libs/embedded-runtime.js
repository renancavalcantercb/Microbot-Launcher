const crypto = require('crypto');

// The Java runtime embedded in the launcher (B-3.1/B-3.2). The image is described by
// `runtime-manifest.json`: every file with its size and SHA-256, and one digest over the whole
// list. The distribution profile pins that digest, so a changed, added, removed or truncated file
// is detected before the client is started, and a missing or mismatching runtime is a hard error
// (there is no fallback to a Java found on the machine).

const MANIFEST_FILE = 'runtime-manifest.json';
const MANIFEST_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const JAVA_VERSION_PATTERN = /^\d{1,3}(?:\.\d{1,4}){0,4}$/;

class RuntimeIntegrityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RuntimeIntegrityError';
    }
}

function fail(message) {
    throw new RuntimeIntegrityError(message);
}

function sha256Buffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(fs, file) {
    const hash = crypto.createHash('sha256');
    const descriptor = fs.openSync(file, 'r');
    try {
        const chunk = Buffer.alloc(1024 * 1024);
        let read;
        while ((read = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
            hash.update(chunk.subarray(0, read));
        }
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest('hex');
}

// Sorted relative paths with forward slashes. Symbolic links are not followed and are reported
// as an error: an image holds only regular files.
function listFiles(fs, path, root) {
    const result = [];
    const walk = (directory, prefix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) fail(`the runtime contains a link: ${relative}`);
            if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
            else if (entry.isFile()) result.push(relative);
            else fail(`the runtime contains an unsupported entry: ${relative}`);
        }
    };
    walk(root, '');
    return result.sort();
}

// One digest over `path`, `sha256` pairs in sorted order.
function imageDigest(files) {
    const hash = crypto.createHash('sha256');
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hash.update(`${file.path}\n${file.sha256}\n`);
    }
    return hash.digest('hex');
}

// Builds the manifest of an image directory (the manifest file itself is not listed).
function buildRuntimeManifest({ fs, path, imageDir, description }) {
    const files = listFiles(fs, path, imageDir)
        .filter((relative) => relative !== MANIFEST_FILE)
        .map((relative) => {
            const full = path.join(imageDir, relative);
            return { path: relative, size: fs.statSync(full).size, sha256: sha256File(fs, full) };
        });
    return {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        ...description,
        files,
        imageSha256: imageDigest(files)
    };
}

function serializeManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function readManifest(fs, path, runtimeDir) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, MANIFEST_FILE), 'utf8'));
    } catch (error) {
        fail(`the embedded Java runtime has no readable ${MANIFEST_FILE}: ${error.code || error.message}`);
    }
    if (
        !manifest ||
        manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
        !Array.isArray(manifest.files) ||
        manifest.files.length === 0 ||
        !SHA256_PATTERN.test(manifest.imageSha256 || '')
    ) {
        fail(`the embedded Java runtime ${MANIFEST_FILE} is invalid`);
    }
    for (const file of manifest.files) {
        if (
            !file ||
            typeof file.path !== 'string' ||
            file.path === '' ||
            file.path.split('/').includes('..') ||
            file.path.startsWith('/') ||
            file.path.includes('\\') ||
            !Number.isInteger(file.size) ||
            !SHA256_PATTERN.test(file.sha256 || '')
        ) {
            fail(`the embedded Java runtime ${MANIFEST_FILE} lists an invalid file`);
        }
    }
    return manifest;
}

/**
 * Checks the runtime directory against the pin from the distribution profile. Throws
 * RuntimeIntegrityError with a message that is safe to show the user.
 */
function verifyEmbeddedRuntime({ fs, path, runtimeDir, expected }) {
    if (!expected || !SHA256_PATTERN.test(expected.imageSha256 || '') || !JAVA_VERSION_PATTERN.test(expected.javaVersion || '')) {
        fail('this launcher build has no valid Java runtime pin');
    }
    if (!fs.existsSync(runtimeDir)) {
        fail('the embedded Java runtime is missing from this installation. Reinstall Microbot Cut Launcher.');
    }
    const manifest = readManifest(fs, path, runtimeDir);
    if (manifest.javaVersion !== expected.javaVersion) {
        fail(`the embedded Java runtime is version ${manifest.javaVersion}, expected ${expected.javaVersion}`);
    }
    if (manifest.imageSha256 !== expected.imageSha256) {
        fail('the embedded Java runtime does not match the one this launcher was built with');
    }
    if (imageDigest(manifest.files) !== manifest.imageSha256) {
        fail('the embedded Java runtime manifest is inconsistent');
    }

    const listed = new Set(manifest.files.map((file) => file.path));
    for (const present of listFiles(fs, path, runtimeDir)) {
        if (present !== MANIFEST_FILE && !listed.has(present)) {
            fail(`the embedded Java runtime contains an unexpected file: ${present}`);
        }
    }
    for (const file of manifest.files) {
        const full = path.join(runtimeDir, ...file.path.split('/'));
        let stat;
        try {
            stat = fs.statSync(full);
        } catch (_) {
            fail(`the embedded Java runtime is missing a file: ${file.path}`);
        }
        if (!stat.isFile() || stat.size !== file.size || sha256File(fs, full) !== file.sha256) {
            fail(`the embedded Java runtime has a modified file: ${file.path}`);
        }
    }
    return { javaVersion: manifest.javaVersion, imageSha256: manifest.imageSha256, files: manifest.files.length };
}

// Names that make the JVM load agents or options from the environment. They are removed from the
// environment of the Java child process only, never from the launcher's own environment.
const JAVA_ENVIRONMENT_OPTIONS = Object.freeze(['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS']);

function sanitizeJavaEnvironment(environment) {
    const clean = {};
    const removed = [];
    for (const [name, value] of Object.entries(environment)) {
        if (JAVA_ENVIRONMENT_OPTIONS.includes(name.toUpperCase())) removed.push(name);
        else clean[name] = value;
    }
    return { environment: clean, removed };
}

module.exports = {
    JAVA_ENVIRONMENT_OPTIONS,
    JAVA_VERSION_PATTERN,
    MANIFEST_FILE,
    MANIFEST_SCHEMA_VERSION,
    RuntimeIntegrityError,
    SHA256_PATTERN,
    buildRuntimeManifest,
    imageDigest,
    listFiles,
    readManifest,
    sanitizeJavaEnvironment,
    serializeManifest,
    sha256Buffer,
    sha256File,
    verifyEmbeddedRuntime
};
