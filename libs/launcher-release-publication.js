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

// semver precedence for the versions the contract allows (no build metadata).
function compareLauncherVersions(left, right) {
    validateLauncherVersion(left);
    validateLauncherVersion(right);
    const split = (value) => {
        const [core, ...pre] = value.split('-');
        return { numbers: core.split('.').map(Number), pre: pre.length ? pre.join('-').split('.') : [] };
    };
    const a = split(left);
    const b = split(right);
    for (let index = 0; index < 3; index += 1) {
        if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] < b.numbers[index] ? -1 : 1;
    }
    if (a.pre.length === 0 || b.pre.length === 0) {
        if (a.pre.length === b.pre.length) return 0;
        return a.pre.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
        if (a.pre[index] === undefined) return -1;
        if (b.pre[index] === undefined) return 1;
        if (a.pre[index] === b.pre[index]) continue;
        const numericA = /^\d+$/.test(a.pre[index]);
        const numericB = /^\d+$/.test(b.pre[index]);
        if (numericA && numericB) return Number(a.pre[index]) < Number(b.pre[index]) ? -1 : 1;
        if (numericA !== numericB) return numericA ? -1 : 1;
        return a.pre[index] < b.pre[index] ? -1 : 1;
    }
    return 0;
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

// One installer is built per environment (scripts/build-distribution.js), each with its own
// embedded profile. Staging and production binaries differ, but both must come from the same
// clean commit and logical version, and each is validated here before it can be published.
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function verifyLauncherCandidate({ candidate, installerPath, channel, version }) {
    if (!CHANNELS.includes(channel)) throw new Error('release channel is invalid');
    validateLauncherVersion(version);
    if (!candidate || candidate.kind !== 'launcher-candidate') throw new Error('candidate metadata is missing or has the wrong kind');
    if (candidate.profile !== channel) throw new Error(`candidate was built for ${candidate.profile}, not ${channel}`);
    const effective = candidate.effectiveConfiguration || {};
    if (effective.environment !== channel || effective.releaseChannel !== channel) {
        throw new Error('candidate effective configuration does not match the channel');
    }
    if (effective.environmentVariableOverrides !== false) throw new Error('candidate allows environment variable overrides');
    if (effective.launcherUpdateFeed !== null) throw new Error('candidate enables a launcher update feed');
    if (candidate.version !== version) throw new Error('candidate version does not match the release version');
    if (candidate.file !== installerFileName(version)) throw new Error('candidate file name does not match the release version');
    if (!COMMIT_PATTERN.test(candidate.sourceCommit || '')) throw new Error('candidate has no source commit');
    if (candidate.sourceDirty !== false) throw new Error('candidate was built from an uncommitted working tree');
    for (const field of ['embeddedProfileSha256', 'appAsarSha256', 'sha256']) {
        if (!SHA256_PATTERN.test(candidate[field] || '')) throw new Error(`candidate ${field} is invalid`);
    }
    const actual = describeInstaller(installerPath);
    if (path.basename(installerPath) !== candidate.file) throw new Error('installer file name does not match its candidate');
    if (actual.size !== candidate.size || actual.sha256 !== candidate.sha256 || actual.sha512Base64 !== candidate.sha512Base64) {
        throw new Error('installer bytes do not match their candidate record');
    }
    return candidate;
}

// Staging and production candidates of one release: same source, different bytes.
function requireSameSourceCandidates(staging, production) {
    if (staging?.profile !== 'staging' || production?.profile !== 'production') {
        throw new Error('expected one staging and one production candidate');
    }
    if (staging.sourceCommit !== production.sourceCommit) throw new Error('staging and production candidates come from different commits');
    if (staging.version !== production.version) throw new Error('staging and production candidates have different versions');
    if (staging.sha256 === production.sha256 || staging.embeddedProfileSha256 === production.embeddedProfileSha256) {
        throw new Error('staging and production candidates are not environment-specific builds');
    }
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
    // candidate.json of this binary, and (for production) of the staging binary of the same release.
    candidate,
    stagingCandidate = null,
    // The SHA-256 recorded in L3-VALIDATION.md for the installer that passed L3. It is typed by the
    // operator, so only the bytes that were validated can be prepared for publication.
    validatedSha256
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
    verifyLauncherCandidate({ candidate, installerPath, channel, version });
    if (!SHA256_PATTERN.test(validatedSha256 || '')) throw new Error('the validated installer SHA-256 is required');
    if (validatedSha256 !== candidate.sha256) {
        throw new Error('the installer is not the one that was validated: SHA-256 differs from the validated value');
    }
    if (channel === 'production') {
        if (!stagingCandidate) throw new Error('a production launcher requires the staging candidate of the same release');
        requireSameSourceCandidates(stagingCandidate, candidate);
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
            reusesArtifact: false,
            validatedSha256,
            profile: candidate.profile,
            sourceCommit: candidate.sourceCommit,
            sourceDirty: false,
            embeddedProfileSha256: candidate.embeddedProfileSha256,
            appAsarSha256: candidate.appAsarSha256,
            // Evidence that the production bytes belong to a release that exists on staging.
            stagingCandidate: stagingCandidate
                ? {
                    version: stagingCandidate.version,
                    size: stagingCandidate.size,
                    sha256: stagingCandidate.sha256,
                    sourceCommit: stagingCandidate.sourceCommit
                }
                : null,
            preparedAt: new Date().toISOString()
        });
        return { payload, envelope, artifactFile, updaterFile };
    } catch (error) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        throw error;
    }
}

function requireDerivedObjectKeys(metadata, channel, sequence) {
    if (
        metadata.candidateObjectKey !== `releases/${channel}/candidates/sequence-${sequence}-manifest.json` ||
        metadata.manifestObjectKey !== `releases/${channel}/manifest.json`
    ) {
        throw new Error('release metadata object keys do not match the release');
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
    requireDerivedObjectKeys(metadata, channel, payload.sequence);
    if (metadata.validatedSha256 !== entry.sha256) {
        throw new Error('release metadata does not record the validated installer SHA-256');
    }
    if (channel === 'production' && !metadata.reusesArtifact) {
        const staging = metadata.stagingCandidate;
        if (
            !staging ||
            staging.version !== metadata.version ||
            staging.sourceCommit !== metadata.sourceCommit ||
            staging.sha256 === entry.sha256 ||
            !SHA256_PATTERN.test(staging.sha256 || '')
        ) {
            throw new Error('production release metadata does not carry its staging candidate');
        }
    }
    if (
        metadata.kind !== 'launcher' ||
        metadata.channel !== channel ||
        metadata.profile !== channel ||
        metadata.sourceDirty !== false ||
        metadata.sequence !== payload.sequence ||
        metadata.version !== payload.launcher.version ||
        metadata.artifactObjectKey !== entry.artifactPath ||
        metadata.updaterObjectKey !== entry.updaterMetadataPath
    ) {
        throw new Error('release metadata does not match its signed manifest');
    }
    return { metadata, envelope, payload, artifactFile, updaterFile };
}

// A launcher release prepared from a previous bundle: the same installer and latest.yml objects
// (nothing is uploaded), a higher sequence, and the client entry of the manifest that is live now.
function prepareLauncherRollback({
    sourceDirectory,
    outputDirectory,
    channel,
    sequence,
    currentClient,
    keyId,
    privateKeyPem,
    publicKey,
    publishedAt = new Date().toISOString()
}) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
    }
    if (!currentClient || typeof currentClient !== 'object') {
        throw new Error('a launcher release must carry over the current client entry');
    }
    const source = readAndVerifyLauncherBundle({ outputDirectory: sourceDirectory, channel, keyId, publicKey });
    if (sequence <= source.payload.sequence) {
        throw new Error(`rollback sequence ${sequence} must be greater than source sequence ${source.payload.sequence}`);
    }
    if (fs.existsSync(outputDirectory)) throw new Error(`release bundle already exists: ${outputDirectory}`);

    fs.mkdirSync(outputDirectory, { recursive: true });
    try {
        const fileName = installerFileName(source.payload.launcher.version);
        fs.copyFileSync(source.artifactFile, path.join(outputDirectory, fileName), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(source.updaterFile, path.join(outputDirectory, 'latest.yml'), fs.constants.COPYFILE_EXCL);
        const payload = {
            schemaVersion: 1,
            channel,
            sequence,
            publishedAt,
            launcher: source.payload.launcher,
            client: currentClient
        };
        const envelope = signReleaseManifest(payload, { keyId, privateKeyPem });
        verifyReleaseManifest(envelope, { expectedChannel: channel, trustedKeys: { [keyId]: publicKey } });
        writeJsonExclusive(path.join(outputDirectory, 'payload.json'), payload);
        writeJsonExclusive(path.join(outputDirectory, 'manifest.json'), envelope);
        writeJsonExclusive(path.join(outputDirectory, 'release.json'), {
            ...source.metadata,
            sequence,
            candidateObjectKey: `releases/${channel}/candidates/sequence-${sequence}-manifest.json`,
            reusesArtifact: true,
            rollbackSource: {
                version: source.payload.launcher.version,
                sequence: source.payload.sequence,
                sha256: source.metadata.sha256,
                artifactObjectKey: source.metadata.artifactObjectKey
            },
            preparedAt: new Date().toISOString()
        });
        return { payload, envelope, source };
    } catch (error) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        throw error;
    }
}

function launcherWithdrawalDirectory(workRoot, channel, sequence) {
    if (!CHANNELS.includes(channel)) throw new Error('release channel is invalid');
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
    }
    return path.join(workRoot, channel, `sequence-${sequence}-launcher-withdrawal`);
}

// Emergency brake: a higher-sequence manifest with no launcher, so the Download page reports the
// installer as unavailable. The client entry is carried over from the live manifest. It does not
// uninstall anything and the objects stay in R2.
function prepareLauncherWithdrawal({
    outputDirectory,
    channel,
    sequence,
    currentClient,
    keyId,
    privateKeyPem,
    publicKey,
    publishedAt = new Date().toISOString()
}) {
    if (!currentClient || typeof currentClient !== 'object') {
        throw new Error('a launcher release must carry over the current client entry');
    }
    if (fs.existsSync(outputDirectory)) throw new Error(`release bundle already exists: ${outputDirectory}`);
    fs.mkdirSync(outputDirectory, { recursive: true });
    try {
        const payload = { schemaVersion: 1, channel, sequence, publishedAt, launcher: null, client: currentClient };
        const envelope = signReleaseManifest(payload, { keyId, privateKeyPem });
        verifyReleaseManifest(envelope, { expectedChannel: channel, trustedKeys: { [keyId]: publicKey } });
        writeJsonExclusive(path.join(outputDirectory, 'payload.json'), payload);
        writeJsonExclusive(path.join(outputDirectory, 'manifest.json'), envelope);
        writeJsonExclusive(path.join(outputDirectory, 'release.json'), {
            kind: 'launcher-withdrawal',
            channel,
            sequence,
            sourceDirty: false,
            candidateObjectKey: `releases/${channel}/candidates/sequence-${sequence}-manifest.json`,
            manifestObjectKey: `releases/${channel}/manifest.json`,
            preparedAt: new Date().toISOString()
        });
        return { payload, envelope };
    } catch (error) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        throw error;
    }
}

function readAndVerifyLauncherWithdrawal({ outputDirectory, channel, keyId, publicKey }) {
    const metadata = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'release.json'), 'utf8'));
    const envelope = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'manifest.json'), 'utf8'));
    const payload = verifyReleaseManifest(envelope, { expectedChannel: channel, trustedKeys: { [keyId]: publicKey } });
    if (
        metadata.kind !== 'launcher-withdrawal' ||
        metadata.channel !== channel ||
        metadata.sequence !== payload.sequence ||
        payload.launcher !== null
    ) {
        throw new Error('withdrawal metadata does not match its signed manifest');
    }
    requireDerivedObjectKeys(metadata, channel, payload.sequence);
    return { metadata, envelope, payload };
}

// The launcher a regular release publishes must be newer than the live one; going back is a
// rollback (prepareLauncherRollback), which is explicit and reuses already published objects.
function requireNewerLauncherVersion(candidate, current) {
    const live = current?.launcher;
    if (!live) return;
    if (compareLauncherVersions(candidate.launcher.version, live.version) <= 0) {
        throw new Error(
            `launcher ${candidate.launcher.version} must be newer than the live launcher ${live.version}; use a rollback to go back`
        );
    }
}

// Production only publishes a release that is already live on staging with the staging bytes.
function requireStagingPublished(stagingLive, stagingEvidence) {
    const entry = stagingLive?.launcher?.platforms?.[LAUNCHER_PLATFORM];
    if (
        !stagingEvidence ||
        !entry ||
        stagingLive.launcher.version !== stagingEvidence.version ||
        entry.sha256 !== stagingEvidence.sha256 ||
        entry.size !== stagingEvidence.size
    ) {
        throw new Error(
            'the staging channel does not list this release with the staging candidate bytes; publish and validate it on staging first'
        );
    }
}

// The only object keys a launcher release may write for a channel. Anything else (a client
// artifact, another channel, a different version) is a bug and is refused before R2 is touched.
function requireAllowedLauncherWriteKey(channel, key, { version = null, sequence }) {
    const candidate = `releases/${channel}/candidates/sequence-${sequence}-manifest.json`;
    const live = `releases/${channel}/manifest.json`;
    const allowed = new Set([candidate, live]);
    if (version) {
        const keys = launcherObjectKeys(version);
        allowed.add(keys.installer);
        allowed.add(keys.updater);
    }
    if (!allowed.has(key)) throw new Error(`refusing to write an object outside the release: ${key}`);
}

// Key order is not significant: verified manifests may normalize it.
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

// A client-only release must carry exactly the launcher entry that is live: dropping it would make
// the Download page report the installer as unavailable, and a stale entry would resurrect a
// launcher that was changed or withdrawn since the candidate was prepared.
function requireClientReleaseKeepsLauncher(candidate, current) {
    if (!current) return;
    if (canonicalJson(candidate.launcher ?? null) !== canonicalJson(current.launcher ?? null)) {
        throw new Error('release would remove or change the live launcher entry; prepare it again from the live manifest');
    }
}

// A launcher release must not change the client entry it was prepared against.
function requireLauncherReleaseKeepsClient(candidate, current) {
    if (!current) return;
    if (canonicalJson(candidate.client) !== canonicalJson(current.client)) {
        throw new Error('release would change the live client entry; prepare it again from the live manifest');
    }
}

module.exports = {
    LAUNCHER_PLATFORM,
    LAUNCHER_VERSION_PATTERN,
    buildUpdaterMetadata,
    canonicalJson,
    compareLauncherVersions,
    describeInstaller,
    installerFileName,
    launcherBundleDirectory,
    launcherObjectKeys,
    launcherWithdrawalDirectory,
    parseUpdaterMetadata,
    prepareLauncherRelease,
    prepareLauncherRollback,
    prepareLauncherWithdrawal,
    readAndVerifyLauncherBundle,
    readAndVerifyLauncherWithdrawal,
    requireAllowedLauncherWriteKey,
    requireClientReleaseKeepsLauncher,
    requireLauncherReleaseKeepsClient,
    requireNewerLauncherVersion,
    requireSameSourceCandidates,
    requireStagingPublished,
    validateLauncherVersion,
    verifyLauncherCandidate,
    verifyUpdaterMetadata
};
