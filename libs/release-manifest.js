const crypto = require('crypto');

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNELS = new Set(['staging', 'production']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PLATFORM_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value;
}

function requiredString(value, label, pattern) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function validateArtifact(value, label) {
    const artifact = requiredObject(value, label);
    requiredString(artifact.artifactPath, `${label}.artifactPath`, /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/);
    if (
        artifact.artifactPath.includes('..') ||
        artifact.artifactPath.includes('//') ||
        artifact.artifactPath.includes('\\')
    ) {
        throw new Error(`${label}.artifactPath is unsafe`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
        throw new Error(`${label}.size must be a positive safe integer`);
    }
    requiredString(artifact.sha256, `${label}.sha256`, SHA256_PATTERN);
    return artifact;
}

function validatePayload(payload, expectedChannel) {
    requiredObject(payload, 'release manifest payload');
    if (payload.schemaVersion !== 1) {
        throw new Error('unsupported release manifest schema version');
    }
    if (!CHANNELS.has(payload.channel) || payload.channel !== expectedChannel) {
        throw new Error('release manifest channel does not match the configured channel');
    }
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence <= 0) {
        throw new Error('release manifest sequence must be a positive safe integer');
    }
    if (
        typeof payload.publishedAt !== 'string' ||
        !Number.isFinite(Date.parse(payload.publishedAt))
    ) {
        throw new Error('release manifest publishedAt is invalid');
    }

    if (payload.launcher !== null) {
        const launcher = requiredObject(payload.launcher, 'launcher release');
        requiredString(launcher.version, 'launcher.version', VERSION_PATTERN);
        requiredString(
            launcher.minimumSupportedVersion,
            'launcher.minimumSupportedVersion',
            VERSION_PATTERN
        );
        const platforms = requiredObject(launcher.platforms, 'launcher.platforms');
        const platformNames = Object.keys(platforms);
        if (platformNames.length === 0) {
            throw new Error('launcher.platforms must not be empty');
        }
        for (const platform of platformNames) {
            requiredString(platform, 'launcher platform', PLATFORM_PATTERN);
            const artifact = validateArtifact(platforms[platform], `launcher.platforms.${platform}`);
            requiredString(
                artifact.updaterMetadataPath,
                `launcher.platforms.${platform}.updaterMetadataPath`,
                /^[A-Za-z0-9][A-Za-z0-9._+/-]*$/
            );
            if (
                artifact.updaterMetadataPath.includes('..') ||
                artifact.updaterMetadataPath.includes('//') ||
                artifact.updaterMetadataPath.includes('\\')
            ) {
                throw new Error(`launcher.platforms.${platform}.updaterMetadataPath is unsafe`);
            }
        }
    }

    const client = validateArtifact(payload.client, 'client release');
    requiredString(client.version, 'client.version', VERSION_PATTERN);
    requiredString(
        client.minimumLauncherVersion,
        'client.minimumLauncherVersion',
        VERSION_PATTERN
    );
    return payload;
}

function decodeBase64(value, label) {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ) {
        throw new Error(`${label} must be canonical base64`);
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.toString('base64') !== value) {
        throw new Error(`${label} must be canonical base64`);
    }
    return decoded;
}

function parsePublicKey(base64Der) {
    const key = crypto.createPublicKey({
        key: decodeBase64(base64Der, 'release public key'),
        format: 'der',
        type: 'spki'
    });
    if (key.asymmetricKeyType !== 'rsa') {
        throw new Error('release public key must be RSA');
    }
    return key;
}

function verifyReleaseManifest(envelope, { expectedChannel, trustedKeys }) {
    requiredObject(envelope, 'release manifest envelope');
    requiredString(envelope.keyId, 'release manifest keyId', KEY_ID_PATTERN);
    if (!CHANNELS.has(expectedChannel)) {
        throw new Error('configured release channel is invalid');
    }
    const encodedKey = trustedKeys && trustedKeys[envelope.keyId];
    if (!encodedKey) {
        throw new Error(`release signing key is not trusted: ${envelope.keyId}`);
    }

    const payloadBytes = decodeBase64(envelope.payload, 'release manifest payload');
    const signature = decodeBase64(envelope.signature, 'release manifest signature');
    const valid = crypto.verify(
        'RSA-SHA256',
        payloadBytes,
        parsePublicKey(encodedKey),
        signature
    );
    if (!valid) {
        throw new Error('release manifest signature is invalid');
    }

    let payload;
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch (_) {
        throw new Error('release manifest payload is not valid JSON');
    }
    return validatePayload(payload, expectedChannel);
}

module.exports = {
    verifyReleaseManifest,
    validatePayload
};
