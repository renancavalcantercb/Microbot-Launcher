const crypto = require('crypto');

const DEFAULT_ENVIRONMENT_VARIABLES = Object.freeze({
    enabled: 'MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED',
    manifestUrl: 'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
    releasesUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_URL',
    releasesApiUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_API_URL',
    publicKey: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
    publicKeyId: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID'
});

const PROPERTY_NAMES = Object.freeze({
    enabled: 'microbot.plugins.repository.enabled',
    manifestUrl: 'microbot.plugins.manifestUrl',
    releasesUrl: 'microbot.plugins.releasesUrl',
    releasesApiUrl: 'microbot.plugins.releasesApiUrl',
    publicKey: 'microbot.plugins.publicKey',
    publicKeyId: 'microbot.plugins.publicKeyId'
});

const DEVELOPMENT_MODE_PROPERTY = 'microbot.plugins.developmentMode';

function parseHttpsUrl(value, label) {
    if (!value) return null;

    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        throw new Error(`${label} must be a valid HTTPS URL`);
    }
    if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password
    ) {
        throw new Error(`${label} must be a valid HTTPS URL without credentials`);
    }
    return parsed.toString();
}

function parseRsaPublicKey(value) {
    const normalized = (value || '').replace(/\s/g, '');
    if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
        throw new Error('plugin repository public key must be base64 X.509 DER');
    }

    try {
        const key = crypto.createPublicKey({
            key: Buffer.from(normalized, 'base64'),
            format: 'der',
            type: 'spki'
        });
        if (key.asymmetricKeyType !== 'rsa') {
            throw new Error('not RSA');
        }
    } catch (_) {
        throw new Error('plugin repository public key must be a valid RSA X.509 DER key');
    }
    return normalized;
}

function buildLockedPluginRepositoryVmArgs(productConfig, log) {
    const repository = productConfig.pluginRepository;
    const settings = {
        enabled: 'true',
        manifestUrl: parseHttpsUrl(repository.manifestUrl, 'plugin repository manifest URL'),
        releasesUrl: parseHttpsUrl(repository.releasesUrl, 'plugin repository releases URL'),
        publicKey: parseRsaPublicKey(repository.publicKey),
        publicKeyId: repository.publicKeyId
    };
    if (!settings.manifestUrl || !settings.releasesUrl) {
        throw new Error('plugin repository profile is incomplete');
    }
    const args = Object.entries(settings).map(
        ([name, value]) => `-D${PROPERTY_NAMES[name]}=${value}`
    );
    // Pin the properties a stray JAVA_TOOL_OPTIONS could otherwise add.
    args.push(
        `-D${DEVELOPMENT_MODE_PROPERTY}=false`,
        `-D${PROPERTY_NAMES.releasesApiUrl}=${
            repository.releasesApiUrl
                ? parseHttpsUrl(repository.releasesApiUrl, 'plugin repository releases API URL')
                : ''
        }`
    );
    log.info(
        `Plugin repository from the distribution profile: key ${settings.publicKeyId}, manifest ${settings.manifestUrl}`
    );
    return { enabled: true, args };
}

function buildPluginRepositoryVmArgs({
    environment = process.env,
    productConfig = {},
    log = console
} = {}) {
    // The embedded profile is authoritative: environment variables are not consulted and a
    // problem is fatal instead of silently disabling the repository.
    if (productConfig.distribution?.locked) {
        return buildLockedPluginRepositoryVmArgs(productConfig, log);
    }
    const names = {
        ...DEFAULT_ENVIRONMENT_VARIABLES,
        ...(productConfig.pluginRepositoryEnvironmentVariables || {})
    };
    if (environment[names.enabled] !== 'true') {
        return { enabled: false, args: [] };
    }

    try {
        const manifestUrl = parseHttpsUrl(
            environment[names.manifestUrl],
            names.manifestUrl
        );
        if (!manifestUrl) {
            throw new Error(`${names.manifestUrl} is required`);
        }

        const publicKey = parseRsaPublicKey(environment[names.publicKey]);
        const publicKeyId = (environment[names.publicKeyId] || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(publicKeyId)) {
            throw new Error(
                `${names.publicKeyId} must contain 1-64 safe identifier characters`
            );
        }

        const settings = {
            enabled: 'true',
            manifestUrl,
            publicKey,
            publicKeyId
        };
        for (const field of ['releasesUrl', 'releasesApiUrl']) {
            const value = environment[names[field]];
            if (value) settings[field] = parseHttpsUrl(value, names[field]);
        }

        const args = Object.entries(settings).map(
            ([name, value]) => `-D${PROPERTY_NAMES[name]}=${value}`
        );
        log.info(
            `Plugin repository enabled with key ${publicKeyId} and manifest ${manifestUrl}`
        );
        return { enabled: true, args };
    } catch (error) {
        log.error(
            `Plugin repository configuration is invalid; keeping it disabled: ${error.message}`
        );
        return { enabled: false, args: [] };
    }
}

module.exports = {
    DEFAULT_ENVIRONMENT_VARIABLES,
    buildPluginRepositoryVmArgs
};
