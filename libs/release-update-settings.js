const crypto = require('crypto');

const DEFAULT_ENVIRONMENT_VARIABLES = Object.freeze({
    enabled: 'MICROBOT_CUT_RELEASE_UPDATES_ENABLED',
    channel: 'MICROBOT_CUT_RELEASE_CHANNEL',
    manifestUrl: 'MICROBOT_CUT_RELEASE_MANIFEST_URL',
    artifactBaseUrl: 'MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL',
    publicKey: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY',
    publicKeyId: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID'
});

function httpsUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw new Error(`${label} must be a valid HTTPS URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error(`${label} must be a valid HTTPS URL without credentials`);
    }
    return parsed.toString();
}

function rsaPublicKey(value) {
    const normalized = (value || '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        throw new Error('release public key must be base64 X.509 DER');
    }
    try {
        const key = crypto.createPublicKey({
            key: Buffer.from(normalized, 'base64'),
            format: 'der',
            type: 'spki'
        });
        if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
    } catch (_) {
        throw new Error('release public key must be a valid RSA X.509 DER key');
    }
    return normalized;
}

function validateSettings(input) {
    if (!['staging', 'production'].includes(input.channel)) {
        throw new Error('release channel must be staging or production');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.publicKeyId || '')) {
        throw new Error('release public key ID is invalid');
    }
    return Object.freeze({
        enabled: true,
        channel: input.channel,
        manifestUrl: httpsUrl(input.manifestUrl, 'release manifest URL'),
        artifactBaseUrl: httpsUrl(input.artifactBaseUrl, 'release artifact base URL'),
        trustedKeys: Object.freeze({
            [input.publicKeyId]: rsaPublicKey(input.publicKey)
        })
    });
}

function buildReleaseUpdateSettings({
    environment = process.env,
    productConfig = {},
    allowEnvironmentConfiguration = environment.DEBUG === 'true',
    log = console
} = {}) {
    const configured = productConfig.releaseUpdates || {};
    if (configured.enabled) {
        try {
            return validateSettings(configured);
        } catch (error) {
            log.error(`Built-in release update configuration is invalid: ${error.message}`);
            return Object.freeze({ enabled: false });
        }
    }
    if (!allowEnvironmentConfiguration) return Object.freeze({ enabled: false });

    const names = {
        ...DEFAULT_ENVIRONMENT_VARIABLES,
        ...(productConfig.releaseUpdateEnvironmentVariables || {})
    };
    if (environment[names.enabled] !== 'true') {
        return Object.freeze({ enabled: false });
    }
    try {
        return validateSettings({
            channel: environment[names.channel],
            manifestUrl: environment[names.manifestUrl],
            artifactBaseUrl: environment[names.artifactBaseUrl],
            publicKey: environment[names.publicKey],
            publicKeyId: environment[names.publicKeyId]
        });
    } catch (error) {
        log.error(`Release update configuration is invalid; keeping it disabled: ${error.message}`);
        return Object.freeze({ enabled: false });
    }
}

module.exports = {
    DEFAULT_ENVIRONMENT_VARIABLES,
    buildReleaseUpdateSettings
};
