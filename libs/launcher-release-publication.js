const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { signReleaseManifest } = require('./release-manifest-signing');
const { verifyReleaseManifest } = require('./release-manifest');

// Contract with the site (microbot-cut-docs/plans/SITE-DOWNLOAD.md): the Worker derives the
// installer key from the manifest version with this exact shape and rejects anything else.
const LAUNCHER_PLATFORM = 'windows-x64';
const LAUNCHER_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const CHANNELS = ['staging', 'production'];

function validateLauncherVersion(version, label = 'launcher version') {
    if (typeof version !== 'string' || !LAUNCHER_VERSION_PATTERN.test(version)) {
        throw new Error(`${label} is invalid`);
    }
}

function installerFileName(version) {
    validateLauncherVersion(version);
    return `Microbot-Cut-Launcher-Setup-${version}.exe`;
}

function launcherObjectKeys(version) {
    const directory = `releases/artifacts/launcher/${version}/windows`;
    return {
        installer: `${directory}/${installerFileName(version)}`,
        updater: `${directory}/latest.yml`
    };
}

function hashFile(filePath, algorithm, encoding) {
    const hash = crypto.createHash(algorithm);
    const descriptor = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(descriptor);
    }
    return hash.digest(encoding);
}

function describeInstaller(installerPath) {
    const stat = fs.statSync(installerPath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('installer is not a non-empty file');
    return {
        size: stat.size,
        sha256: hashFile(installerPath, 'sha256', 'hex'),
        sha512Base64: hashFile(installerPath, 'sha512', 'base64')
    };
}

// electron-builder does not emit latest.yml without a publish configuration, and adding one
// would embed an update feed in the app. The file is generated here instead, in the exact
// generic-provider format, from the bytes that are published.
function buildUpdaterMetadata({ version, fileName, size, sha512Base64, releaseDate }) {
    validateLauncherVersion(version);
    if (fileName !== installerFileName(version)) throw new Error('updater metadata file name is invalid');
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('updater metadata size is invalid');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512Base64 || '')) throw new Error('updater metadata sha512 is invalid');
    if (!Number.isFinite(Date.parse(releaseDate))) throw new Error('updater metadata release date is invalid');
    return [
        `version: ${version}`,
        'files:',
        `  - url: ${fileName}`,
        `    sha512: ${sha512Base64}`,
        `    size: ${size}`,
        `path: ${fileName}`,
        `sha512: ${sha512Base64}`,
        `releaseDate: '${new Date(releaseDate).toISOString()}'`,
        ''
    ].join('\n');
}

// Strict parser for the single shape buildUpdaterMetadata writes. Anything else is rejected so a
// hand-edited or differently shaped file can never be mistaken for a matching one.
function parseUpdaterMetadata(text) {
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const patterns = [
        ['version', /^version: (\S+)$/],
        [null, /^files:$/],
        ['fileUrl', /^ {2}- url: (\S+)$/],
        ['fileSha512', /^ {4}sha512: ([A-Za-z0-9+/]{86}==)$/],
        ['fileSize', /^ {4}size: (\d+)$/],
        ['path', /^path: (\S+)$/],
        ['sha512', /^sha512: ([A-Za-z0-9+/]{86}==)$/],
        ['releaseDate', /^releaseDate: '([^']+)'$/]
    ];
    if (lines.length !== patterns.length) throw new Error('updater metadata has an unexpected shape');
    const parsed = {};
    patterns.forEach(([key, pattern], index) => {
        const match = pattern.exec(lines[index]);
        if (!match) throw new Error(`updater metadata line ${index + 1} has an unexpected shape`);
        if (key) parsed[key] = match[1];
    });
    parsed.fileSize = Number(parsed.fileSize);
    return parsed;
}

function verifyUpdaterMetadata({ metadataText, installerPath, version }) {
    const parsed = parseUpdaterMetadata(metadataText);
    const expectedName = installerFileName(version);
    const actual = describeInstaller(installerPath);
    if (path.basename(installerPath) !== expectedName) throw new Error('installer file name does not match the release version');
    if (parsed.version !== version) throw new Error('updater metadata version does not match the release version');
    if (parsed.path !== expectedName || parsed.fileUrl !== expectedName) {
        throw new Error('updater metadata file name does not match the installer');
    }
    if (parsed.fileSize !== actual.size) throw new Error('updater metadata size does not match the installer');
    if (parsed.sha512 !== actual.sha512Base64 || parsed.fileSha512 !== actual.sha512Base64) {
        throw new Error('updater metadata sha512 does not match the installer');
    }
    return { ...parsed, ...actual };
}

function writeJsonExclusive(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

function launcherBundleDirectory(workRoot, channel, version, sequence) {
    validateLauncherVersion(version);
    if (!CHANNELS.includes(channel)) throw new Error('release channel is invalid');
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
    }
    return path.join(workRoot, channel, `sequence-${sequence}-launcher-${version}`);
}

function prepareLauncherRelease({
    installerPath,
    outputDirectory,
    channel,
    version,
    minimumSupportedVersion,
    sequence,
    currentClient,
    keyId,
    privateKeyPem,
    publicKey,
    publishedAt = new Date().toISOString(),
    releaseDate = publishedAt,
    sourceCommit = null,
    sourceDirty = null
}) {
    validateLauncherVersion(version);
    validateLauncherVersion(minimumSupportedVersion, 'minimum supported launcher version');
    if (!CHANNELS.includes(channel)) throw new Error('release channel is invalid');
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
    }
    if (!currentClient || typeof currentClient !== 'object') {
        throw new Error('a launcher release must carry over the current client entry');
    }
    const fileName = installerFileName(version);
    if (path.basename(installerPath) !== fileName) {
        throw new Error(`installer file name must be ${fileName}`);
    }
    if (fs.existsSync(outputDirectory)) {
        throw new Error(`release bundle already exists: ${outputDirectory}`);
    }

    const keys = launcherObjectKeys(version);
    fs.mkdirSync(outputDirectory, { recursive: true });
    try {
        const artifactFile = path.join(outputDirectory, fileName);
        fs.copyFileSync(installerPath, artifactFile, fs.constants.COPYFILE_EXCL);
        const described = describeInstaller(artifactFile);
        const updaterFile = path.join(outputDirectory, 'latest.yml');
        fs.writeFileSync(updaterFile, buildUpdaterMetadata({
            version,
            fileName,
            size: described.size,
            sha512Base64: described.sha512Base64,
            releaseDate
        }), { encoding: 'utf8', flag: 'wx' });
        verifyUpdaterMetadata({
            metadataText: fs.readFileSync(updaterFile, 'utf8'),
            installerPath: artifactFile,
            version
        });

        const payload = {
            schemaVersion: 1,
            channel,
            sequence,
            publishedAt,
            launcher: {
                version,
                minimumSupportedVersion,
                platforms: {
                    [LAUNCHER_PLATFORM]: {
                        artifactPath: keys.installer,
                        updaterMetadataPath: keys.updater,
                        size: described.size,
                        sha256: described.sha256
                    }
                }
            },
            client: currentClient
        };
        const envelope = signReleaseManifest(payload, { keyId, privateKeyPem });
        const verified = verifyReleaseManifest(envelope, {
            expectedChannel: channel,
            trustedKeys: { [keyId]: publicKey }
        });
        const entry = verified.launcher.platforms[LAUNCHER_PLATFORM];
        if (entry.sha256 !== described.sha256 || entry.size !== described.size) {
            throw new Error('local signed release verification failed');
        }

        writeJsonExclusive(path.join(outputDirectory, 'payload.json'), payload);
        writeJsonExclusive(path.join(outputDirectory, 'manifest.json'), envelope);
        writeJsonExclusive(path.join(outputDirectory, 'release.json'), {
            kind: 'launcher',
            channel,
            sequence,
            version,
            artifactFile: fileName,
            artifactObjectKey: keys.installer,
            updaterFile: 'latest.yml',
            updaterObjectKey: keys.updater,
            size: described.size,
            sha256: described.sha256,
            sha512Base64: described.sha512Base64,
            candidateObjectKey: `releases/${channel}/candidates/sequence-${sequence}-manifest.json`,
            manifestObjectKey: `releases/${channel}/manifest.json`,
            sourceCommit,
            sourceDirty,
            preparedAt: new Date().toISOString()
        });
        return { payload, envelope, artifactFile, updaterFile };
    } catch (error) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        throw error;
    }
}

function readAndVerifyLauncherBundle({ outputDirectory, channel, keyId, publicKey }) {
    const metadata = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'release.json'), 'utf8'));
    const envelope = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'manifest.json'), 'utf8'));
    const payload = verifyReleaseManifest(envelope, {
        expectedChannel: channel,
        trustedKeys: { [keyId]: publicKey }
    });
    if (!payload.launcher) throw new Error('bundle manifest has no launcher release');
    const entry = payload.launcher.platforms[LAUNCHER_PLATFORM];
    if (!entry) throw new Error(`bundle manifest has no ${LAUNCHER_PLATFORM} launcher`);
    const keys = launcherObjectKeys(payload.launcher.version);
    if (entry.artifactPath !== keys.installer || entry.updaterMetadataPath !== keys.updater) {
        throw new Error('bundle manifest paths do not match the release contract');
    }
    const artifactFile = path.join(outputDirectory, installerFileName(payload.launcher.version));
    const actual = describeInstaller(artifactFile);
    if (actual.size !== entry.size) throw new Error('bundle installer size does not match its manifest');
    if (actual.sha256 !== entry.sha256) throw new Error('bundle installer SHA-256 does not match its manifest');
    const updaterFile = path.join(outputDirectory, 'latest.yml');
    verifyUpdaterMetadata({
        metadataText: fs.readFileSync(updaterFile, 'utf8'),
        installerPath: artifactFile,
        version: payload.launcher.version
    });
    if (
        metadata.kind !== 'launcher' ||
        metadata.channel !== channel ||
        metadata.sequence !== payload.sequence ||
        metadata.version !== payload.launcher.version ||
        metadata.artifactObjectKey !== entry.artifactPath ||
        metadata.updaterObjectKey !== entry.updaterMetadataPath
    ) {
        throw new Error('release metadata does not match its signed manifest');
    }
    return { metadata, envelope, payload, artifactFile, updaterFile };
}

// A client-only release must not drop (or change) the launcher that is already published,
// otherwise the Download page would report the installer as unavailable.
function requireClientReleaseKeepsLauncher(candidate, current) {
    if (!current || !current.launcher) return;
    if (JSON.stringify(candidate.launcher) !== JSON.stringify(current.launcher)) {
        throw new Error('release would remove or change the live launcher entry; prepare it again from the live manifest');
    }
}

// A launcher release must not change the client entry it was prepared against.
function requireLauncherReleaseKeepsClient(candidate, current) {
    if (!current) return;
    if (JSON.stringify(candidate.client) !== JSON.stringify(current.client)) {
        throw new Error('release would change the live client entry; prepare it again from the live manifest');
    }
}

module.exports = {
    LAUNCHER_PLATFORM,
    LAUNCHER_VERSION_PATTERN,
    buildUpdaterMetadata,
    describeInstaller,
    installerFileName,
    launcherBundleDirectory,
    launcherObjectKeys,
    parseUpdaterMetadata,
    prepareLauncherRelease,
    readAndVerifyLauncherBundle,
    requireClientReleaseKeepsLauncher,
    requireLauncherReleaseKeepsClient,
    validateLauncherVersion,
    verifyUpdaterMetadata
};
