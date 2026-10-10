const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { signReleaseManifest } = require('./release-manifest-signing');
const { verifyReleaseManifest } = require('./release-manifest');

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
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
    return hash.digest('hex');
}

function writeJsonExclusive(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
    });
}

function validateReleaseIdentity(version, sequence) {
    if (!VERSION_PATTERN.test(version || '')) throw new Error('client version is invalid');
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error('release sequence must be a positive safe integer');
    }
}

function bundleDirectory(workRoot, channel, version, sequence) {
    validateReleaseIdentity(version, sequence);
    if (!['staging', 'production'].includes(channel)) throw new Error('release channel is invalid');
    return path.join(workRoot, channel, `sequence-${sequence}-${version}`);
}

function prepareClientRelease({
    sourceJar,
    outputDirectory,
    channel,
    version,
    sequence,
    minimumLauncherVersion,
    keyId,
    privateKeyPem,
    publicKey,
    publishedAt = new Date().toISOString(),
    sourceCommit = null,
    sourceDirty = null
}) {
    validateReleaseIdentity(version, sequence);
    if (!fs.statSync(sourceJar).isFile()) throw new Error('source JAR is not a file');
    if (fs.existsSync(outputDirectory)) {
        throw new Error(`release bundle already exists: ${outputDirectory}`);
    }

    fs.mkdirSync(outputDirectory, { recursive: true });
    const fileName = `microbot-${version}.jar`;
    const artifactFile = path.join(outputDirectory, fileName);
    try {
        fs.copyFileSync(sourceJar, artifactFile, fs.constants.COPYFILE_EXCL);
        const stat = fs.statSync(artifactFile);
        const sha256 = sha256File(artifactFile);
        const payload = {
            schemaVersion: 1,
            channel,
            sequence,
            publishedAt,
            launcher: null,
            client: {
                version,
                minimumLauncherVersion,
                artifactPath: `releases/artifacts/client/${version}/${fileName}`,
                size: stat.size,
                sha256
            }
        };
        const envelope = signReleaseManifest(payload, { keyId, privateKeyPem });
        const verified = verifyReleaseManifest(envelope, {
            expectedChannel: channel,
            trustedKeys: { [keyId]: publicKey }
        });
        if (verified.client.sha256 !== sha256) {
            throw new Error('local signed release verification failed');
        }

        writeJsonExclusive(path.join(outputDirectory, 'payload.json'), payload);
        writeJsonExclusive(path.join(outputDirectory, 'manifest.json'), envelope);
        writeJsonExclusive(path.join(outputDirectory, 'release.json'), {
            channel,
            sequence,
            version,
            artifactFile: fileName,
            artifactObjectKey: payload.client.artifactPath,
            candidateObjectKey: `releases/${channel}/candidates/sequence-${sequence}-manifest.json`,
            manifestObjectKey: `releases/${channel}/manifest.json`,
            sourceCommit,
            sourceDirty,
            preparedAt: new Date().toISOString()
        });
        return { payload, envelope, artifactFile };
    } catch (error) {
        fs.rmSync(outputDirectory, { recursive: true, force: true });
        throw error;
    }
}

function readAndVerifyBundle({ outputDirectory, channel, keyId, publicKey }) {
    const metadata = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'release.json'), 'utf8'));
    const envelope = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'manifest.json'), 'utf8'));
    const payload = verifyReleaseManifest(envelope, {
        expectedChannel: channel,
        trustedKeys: { [keyId]: publicKey }
    });
    const artifactFile = path.join(outputDirectory, metadata.artifactFile);
    const stat = fs.statSync(artifactFile);
    if (stat.size !== payload.client.size) throw new Error('bundle JAR size does not match its manifest');
    if (sha256File(artifactFile) !== payload.client.sha256) {
        throw new Error('bundle JAR SHA-256 does not match its manifest');
    }
    if (
        metadata.channel !== channel ||
        metadata.sequence !== payload.sequence ||
        metadata.version !== payload.client.version ||
        metadata.artifactObjectKey !== payload.client.artifactPath
    ) {
        throw new Error('release metadata does not match its signed manifest');
    }
    return { metadata, envelope, payload, artifactFile };
}

function requireNewerSequence(candidate, current) {
    if (current && candidate.sequence <= current.sequence) {
        throw new Error(
            `release sequence ${candidate.sequence} must be greater than live sequence ${current.sequence}`
        );
    }
}

module.exports = {
    bundleDirectory,
    prepareClientRelease,
    readAndVerifyBundle,
    requireNewerSequence,
    sha256File,
    validateReleaseIdentity
};
