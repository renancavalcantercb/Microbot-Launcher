const crypto = require('crypto');

// A distributed launcher belongs to exactly one environment, decided when the installer is built.
// The profile below is embedded in the app and is the only source of the backend, release channel
// and plugin repository. Nothing at runtime (DEBUG, MICROBOT_CUT_* variables) can replace it, and a
// packaged app without a valid profile refuses to start instead of falling back to localhost.

const PROFILE_FILE = 'distribution-profile.json';
const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_NAMES = Object.freeze(['staging', 'production']);

// Cross-environment guards: a staging profile can never point at production hosts or keys.
const ENVIRONMENT_RULES = Object.freeze({
    staging: Object.freeze({
        apiOrigin: 'https://cut-staging.xulixnacc.online',
        pluginSegment: 'microbot-cut-plugin-staging',
        releaseKeyIdPrefix: 'release-staging-',
        pluginKeyIdPrefix: 'staging-'
    }),
    production: Object.freeze({
        apiOrigin: 'https://cut.xulixnacc.online',
        pluginSegment: 'microbot-cut-plugin-production',
        releaseKeyIdPrefix: 'release-production-',
        pluginKeyIdPrefix: 'production-'
    })
});

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

class DistributionProfileError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DistributionProfileError';
    }
}

function fail(message) {
    throw new DistributionProfileError(message);
}

function plainObject(value, label, allowedKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is required`);
    const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unknown.length) fail(`${label} has unknown field: ${unknown[0]}`);
    return value;
}

function requiredString(object, key, label) {
    const value = object[key];
    if (typeof value !== 'string' || !value.trim()) fail(`${label}.${key} is required`);
    return value;
}

function httpsUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_) {
        fail(`${label} must be a valid HTTPS URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
        fail(`${label} must be an HTTPS URL without credentials, query or fragment`);
    }
    if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        fail(`${label} must not point at localhost`);
    }
    return parsed;
}

function rsaPublicKey(value, label) {
    const normalized = String(value || '').replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) fail(`${label} must be base64 X.509 DER`);
    try {
        const key = crypto.createPublicKey({ key: Buffer.from(normalized, 'base64'), format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
    } catch (_) {
        fail(`${label} must be a valid RSA X.509 DER key`);
    }
    return normalized;
}

function keyId(object, key, label, prefix) {
    const value = requiredString(object, key, label);
    if (!KEY_ID_PATTERN.test(value)) fail(`${label}.${key} is invalid`);
    if (!value.startsWith(prefix)) fail(`${label}.${key} must start with ${prefix}`);
    return value;
}

function validateSource(source) {
    plainObject(source, 'profile.source', ['commit', 'version']);
    if (!COMMIT_PATTERN.test(source.commit || '')) fail('profile.source.commit must be a full git commit hash');
    if (!VERSION_PATTERN.test(source.version || '')) fail('profile.source.version must be a launcher version');
    return Object.freeze({ commit: source.commit, version: source.version });
}

function validateProfile(raw, { requireSource = false } = {}) {
    plainObject(raw, 'profile', ['schemaVersion', 'environment', 'api', 'release', 'pluginRepository', 'source']);
    if (raw.schemaVersion !== PROFILE_SCHEMA_VERSION) fail(`profile.schemaVersion must be ${PROFILE_SCHEMA_VERSION}`);
    if (!PROFILE_NAMES.includes(raw.environment)) fail('profile.environment must be staging or production');
    const environment = raw.environment;
    const rules = ENVIRONMENT_RULES[environment];

    const api = plainObject(raw.api, 'profile.api', ['baseUrl']);
    const apiBaseUrl = requiredString(api, 'baseUrl', 'profile.api');
    httpsUrl(apiBaseUrl, 'profile.api.baseUrl');
    if (apiBaseUrl !== `${rules.apiOrigin}/api/v1`) {
        fail(`profile.api.baseUrl must be ${rules.apiOrigin}/api/v1`);
    }

    const release = plainObject(raw.release, 'profile.release', [
        'channel', 'manifestUrl', 'artifactBaseUrl', 'publicKeyId', 'publicKey'
    ]);
    if (release.channel !== environment) fail('profile.release.channel must equal the environment');
    const manifestUrl = requiredString(release, 'manifestUrl', 'profile.release');
    httpsUrl(manifestUrl, 'profile.release.manifestUrl');
    if (manifestUrl !== `${rules.apiOrigin}/api/v1/releases/${environment}/manifest`) {
        fail(`profile.release.manifestUrl must be ${rules.apiOrigin}/api/v1/releases/${environment}/manifest`);
    }
    const artifactBaseUrl = requiredString(release, 'artifactBaseUrl', 'profile.release');
    httpsUrl(artifactBaseUrl, 'profile.release.artifactBaseUrl');
    if (artifactBaseUrl !== `${rules.apiOrigin}/api/v1/`) {
        fail(`profile.release.artifactBaseUrl must be ${rules.apiOrigin}/api/v1/`);
    }
    const releaseKeyId = keyId(release, 'publicKeyId', 'profile.release', rules.releaseKeyIdPrefix);
    const releasePublicKey = rsaPublicKey(release.publicKey, 'profile.release.publicKey');

    const plugins = plainObject(raw.pluginRepository, 'profile.pluginRepository', [
        'manifestUrl', 'releasesUrl', 'releasesApiUrl', 'publicKeyId', 'publicKey'
    ]);
    const other = PROFILE_NAMES.find((name) => name !== environment);
    const pluginUrls = {};
    for (const field of ['manifestUrl', 'releasesUrl', 'releasesApiUrl']) {
        if (field === 'releasesApiUrl' && plugins[field] === undefined) continue;
        const value = requiredString(plugins, field, 'profile.pluginRepository');
        const parsed = httpsUrl(value, `profile.pluginRepository.${field}`);
        if (field !== 'releasesApiUrl') {
            if (!parsed.pathname.includes(`/${rules.pluginSegment}/`)) {
                fail(`profile.pluginRepository.${field} must be inside ${rules.pluginSegment}`);
            }
            if (parsed.pathname.includes(ENVIRONMENT_RULES[other].pluginSegment)) {
                fail(`profile.pluginRepository.${field} points at the ${other} repository`);
            }
        }
        pluginUrls[field] = value;
    }
    const pluginKeyId = keyId(plugins, 'publicKeyId', 'profile.pluginRepository', rules.pluginKeyIdPrefix);
    const pluginPublicKey = rsaPublicKey(plugins.publicKey, 'profile.pluginRepository.publicKey');

    let source;
    if (raw.source !== undefined) source = validateSource(raw.source);
    else if (requireSource) fail('profile.source is required in an embedded profile');

    return Object.freeze({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        environment,
        api: Object.freeze({ baseUrl: apiBaseUrl }),
        release: Object.freeze({
            channel: environment,
            manifestUrl,
            artifactBaseUrl,
            publicKeyId: releaseKeyId,
            publicKey: releasePublicKey
        }),
        pluginRepository: Object.freeze({
            ...pluginUrls,
            publicKeyId: pluginKeyId,
            publicKey: pluginPublicKey
        }),
        ...(source ? { source } : {})
    });
}

function profileSourcePath(path, root, name) {
    if (!PROFILE_NAMES.includes(name)) {
        fail(`distribution profile is required: choose one of ${PROFILE_NAMES.join(', ')}`);
    }
    return path.join(root, 'config', 'distribution', `${name}.json`);
}

function loadProfileSource({ fs, path, root, name }) {
    const file = profileSourcePath(path, root, name);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`distribution profile ${name} cannot be read: ${error.message}`);
    }
    const profile = validateProfile(raw);
    if (profile.environment !== name) fail(`distribution profile ${name} declares ${profile.environment}`);
    return profile;
}

// The embedded file is the validated profile plus the source it was built from. JSON key order
// is fixed here so two builds of one commit embed byte-identical profiles.
function serializeEmbeddedProfile(profile, source) {
    const embedded = validateProfile({ ...profile, source }, { requireSource: true });
    return `${JSON.stringify({
        schemaVersion: embedded.schemaVersion,
        environment: embedded.environment,
        api: embedded.api,
        release: embedded.release,
        pluginRepository: embedded.pluginRepository,
        source: embedded.source
    }, null, 2)}\n`;
}

function loadEmbeddedProfile({ fs, path, root }) {
    const file = path.join(root, PROFILE_FILE);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`this launcher build has no valid distribution profile (${PROFILE_FILE}): ${error.message}`);
    }
    return validateProfile(raw, { requireSource: true });
}

function applyDistributionProfile(productConfig, profile) {
    return Object.freeze({
        ...productConfig,
        productApiBaseUrl: profile.api.baseUrl,
        releaseUpdates: Object.freeze({
            enabled: true,
            channel: profile.release.channel,
            manifestUrl: profile.release.manifestUrl,
            artifactBaseUrl: profile.release.artifactBaseUrl,
            publicKey: profile.release.publicKey,
            publicKeyId: profile.release.publicKeyId
        }),
        pluginRepository: Object.freeze({ enabled: true, ...profile.pluginRepository }),
        distribution: Object.freeze({
            locked: true,
            environment: profile.environment,
            source: profile.source || null
        })
    });
}

// Packaged builds must use the embedded profile. Only an unpackaged checkout (npm run dev*)
// keeps the development behavior, which is configured by the start-*.ps1 scripts.
function resolveRuntimeProductConfig({ productConfig, isPackaged, fs, path, root }) {
    if (!isPackaged) return productConfig;
    return applyDistributionProfile(productConfig, loadEmbeddedProfile({ fs, path, root }));
}

function isLocked(productConfig) {
    return productConfig?.distribution?.locked === true;
}

// Variables that could redirect a distributed launcher or its client are not passed down.
function launchEnvironmentFor(productConfig, environment) {
    if (!isLocked(productConfig)) return { ...environment };
    const clean = {};
    for (const [name, value] of Object.entries(environment)) {
        if (!name.toUpperCase().startsWith('MICROBOT_CUT_')) clean[name] = value;
    }
    return clean;
}

module.exports = {
    DistributionProfileError,
    ENVIRONMENT_RULES,
    PROFILE_FILE,
    PROFILE_NAMES,
    PROFILE_SCHEMA_VERSION,
    applyDistributionProfile,
    isLocked,
    launchEnvironmentFor,
    loadEmbeddedProfile,
    loadProfileSource,
    resolveRuntimeProductConfig,
    serializeEmbeddedProfile,
    validateProfile
};
