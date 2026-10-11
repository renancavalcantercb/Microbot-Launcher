const crypto = require('crypto');

const DEFAULT_ENVIRONMENT_VARIABLES = Object.freeze({
    enabled: 'MICROBOT_CUT_RELEASE_UPDATES_ENABLED',
    channel: 'MICROBOT_CUT_RELEASE_CHANNEL',
    manifestUrl: 'MICROBOT_CUT_RELEASE_MANIFEST_URL',
    artifactBaseUrl: 'MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL',
    publicKey: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY',
    publicKeyId: 'MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID',
    channels: 'MICROBOT_CUT_RELEASE_CHANNELS'
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

function validateChannelSettings(input) {
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

function validateSettings(input) {
    if (!input.channels) return validateChannelSettings(input);
    if (!input.channels || typeof input.channels !== 'object' || Array.isArray(input.channels)) {
        throw new Error('release channels must be an object');
    }
    const channels = {};
    for (const [channel, value] of Object.entries(input.channels)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(`release channel ${channel} is invalid`);
        }
        if (value.channel && value.channel !== channel) {
            throw new Error(`release channel ${channel} does not match its configuration`);
        }
        channels[channel] = validateChannelSettings({ ...value, channel });
    }
    const defaultChannel = input.defaultChannel || input.channel;
    if (!channels[defaultChannel]) {
        throw new Error('default release channel is not configured');
    }
    const selected = channels[defaultChannel];
    return Object.freeze({
        ...selected,
        defaultChannel,
        dynamic: true,
        channels: Object.freeze(channels)
    });
}

function settingsForChannel(settings, channel) {
    if (!settings?.enabled) return null;
    if (!settings.dynamic) return settings.channel === channel ? settings : null;
    return settings.channels[channel] || null;
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
        const serializedChannels = environment[names.channels];
        if (serializedChannels) {
            return validateSettings({
                defaultChannel: environment[names.channel],
                channels: JSON.parse(serializedChannels)
            });
        }
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
    buildReleaseUpdateSettings,
    settingsForChannel
};
