const fs = require('fs');
const path = require('path');
const os = require('os');

const baseProductConfig = require('../product-config');
const { buildPluginRepositoryVmArgs } = require('../libs/plugin-repository-settings');
const { buildReleaseUpdateSettings, settingsForChannel } = require('../libs/release-update-settings');
const { resolveApiBaseUrl } = require('../libs/product-session');
const profileLib = require('../libs/distribution-profile');

const root = path.join(__dirname, '..');
const SOURCE = { commit: 'a'.repeat(40), version: '3.2.11' };
const log = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

function profile(name) {
    return JSON.parse(fs.readFileSync(path.join(root, 'config', 'distribution', `${name}.json`), 'utf8'));
}
function json(file) {
    return JSON.parse(fs.readFileSync(path.join(root, 'config', file), 'utf8'));
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function rejection(mutate, name = 'staging') {
    const raw = clone(profile(name));
    mutate(raw);
    let caught = null;
    try {
        profileLib.validateProfile(raw);
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(profileLib.DistributionProfileError);
    return caught.message;
}
function lockedConfig(name) {
    return profileLib.applyDistributionProfile(
        baseProductConfig,
        profileLib.validateProfile({ ...profile(name), source: SOURCE }, { requireSource: true })
    );
}
function withTempDir(callback) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-profile-'));
    try {
        return callback(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('committed distribution profiles', () => {
    test.each(['staging', 'production'])('%s validates and matches the existing channel configuration', (name) => {
        const parsed = profileLib.loadProfileSource({ fs, path, root, name });
        const plugins = json(`plugin-repository.${name}.json`);
        const publication = json(`release-publication.${name}.json`);
        const key = json(publication.publicKeyFile);
        expect(parsed.environment).toBe(name);
        expect(parsed.api.baseUrl).toBe(plugins.productApiBaseUrl);
        expect(parsed.release).toEqual({
            channel: name,
            manifestUrl: publication.manifestUrl,
            artifactBaseUrl: publication.publicBaseUrl,
            publicKeyId: key.keyId,
            publicKey: key.publicKey
        });
        expect(parsed.pluginRepository).toEqual({
            manifestUrl: plugins.manifestUrl,
            releasesUrl: plugins.releasesUrl,
            publicKeyId: plugins.publicKeyId,
            publicKey: plugins.publicKey
        });
    });

    test('the two profiles share no endpoint or key', () => {
        const a = profile('staging');
        const b = profile('production');
        for (const [left, right] of [
            [a.api.baseUrl, b.api.baseUrl],
            [a.release.manifestUrl, b.release.manifestUrl],
            [a.release.publicKey, b.release.publicKey],
            [a.pluginRepository.manifestUrl, b.pluginRepository.manifestUrl],
            [a.pluginRepository.publicKey, b.pluginRepository.publicKey]
        ]) {
            expect(left).not.toBe(right);
        }
    });
});

describe('profile validation fails closed', () => {
    test.each([
        ['a missing backend', (p) => { delete p.api; }, 'profile.api'],
        ['an empty backend URL', (p) => { p.api.baseUrl = ''; }, 'profile.api.baseUrl'],
        ['localhost as the backend', (p) => { p.api.baseUrl = 'http://localhost:5173/api/v1'; }, 'HTTPS'],
        ['http as the backend', (p) => { p.api.baseUrl = 'http://cut-staging.xulixnacc.online/api/v1'; }, 'HTTPS'],
        ['the production backend in a staging profile', (p) => { p.api.baseUrl = 'https://cut.xulixnacc.online/api/v1'; }, 'must be'],
        ['a mismatched release channel', (p) => { p.release.channel = 'production'; }, 'channel'],
        ['the production manifest in staging', (p) => {
            p.release.manifestUrl = 'https://cut.xulixnacc.online/api/v1/releases/production/manifest';
        }, 'manifestUrl'],
        ['a missing release key', (p) => { delete p.release.publicKey; }, 'publicKey'],
        ['a non-RSA release key', (p) => { p.release.publicKey = 'AAAA'; }, 'publicKey'],
        ['the production release key id in staging', (p) => { p.release.publicKeyId = 'release-production-2026-01'; }, 'publicKeyId'],
        ['a missing plugin repository', (p) => { delete p.pluginRepository; }, 'pluginRepository'],
        ['the production plugin repository in staging', (p) => {
            p.pluginRepository.manifestUrl = 'https://renancavalcantercb.github.io/microbot-cut-plugin-production/catalog.json';
        }, 'microbot-cut-plugin-staging'],
        ['an unrelated plugin host path', (p) => { p.pluginRepository.releasesUrl = 'https://example.com/other/'; }, 'releasesUrl'],
        ['the production plugin key id in staging', (p) => { p.pluginRepository.publicKeyId = 'production-2026'; }, 'publicKeyId'],
        ['an unknown field', (p) => { p.debug = true; }, 'unknown field'],
        ['an unknown nested field', (p) => { p.api.fallback = 'http://localhost'; }, 'unknown field'],
        ['an unsupported schema', (p) => { p.schemaVersion = 2; }, 'schemaVersion'],
        ['an unknown environment', (p) => { p.environment = 'dev'; }, 'environment']
    ])('rejects %s', (_name, mutate, fragment) => {
        expect(rejection(mutate)).toContain(fragment);
    });

    test('rejects the same mistakes in the production profile', () => {
        expect(rejection((p) => { p.api.baseUrl = 'https://cut-staging.xulixnacc.online/api/v1'; }, 'production'))
            .toContain('must be');
    });

    test('an embedded profile requires its source commit and version', () => {
        const raw = clone(profile('staging'));
        expect(() => profileLib.validateProfile(raw, { requireSource: true })).toThrow('source');
        raw.source = { commit: 'abc', version: '3.2.11' };
        expect(() => profileLib.validateProfile(raw, { requireSource: true })).toThrow('commit');
    });

    test('asking for a profile that does not exist is an error, not a default', () => {
        for (const name of [undefined, 'dev', '../staging']) {
            expect(() => profileLib.loadProfileSource({ fs, path, root, name })).toThrow('profile is required');
        }
    });
});

describe('embedded profile', () => {
    test('is serialized deterministically and read back unchanged', () => withTempDir((dir) => {
        const text = profileLib.serializeEmbeddedProfile(profile('staging'), SOURCE);
        expect(profileLib.serializeEmbeddedProfile(profile('staging'), SOURCE)).toBe(text);
        fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), text);
        const loaded = profileLib.loadEmbeddedProfile({ fs, path, root: dir });
        expect(loaded.environment).toBe('staging');
        expect(loaded.source).toEqual(SOURCE);
    }));

    test('a packaged build without a profile refuses to start instead of using localhost', () => withTempDir((dir) => {
        expect(() => profileLib.resolveRuntimeProductConfig({
            productConfig: baseProductConfig, isPackaged: true, fs, path, root: dir
        })).toThrow('no valid distribution profile');
    }));

    test('a packaged build with a corrupted profile refuses to start', () => withTempDir((dir) => {
        fs.writeFileSync(path.join(dir, profileLib.PROFILE_FILE), '{"environment":"staging"}');
        expect(() => profileLib.resolveRuntimeProductConfig({
            productConfig: baseProductConfig, isPackaged: true, fs, path, root: dir
        })).toThrow(profileLib.DistributionProfileError);
    }));

    test('an unpackaged checkout keeps the development configuration', () => {
        expect(profileLib.resolveRuntimeProductConfig({
            productConfig: baseProductConfig, isPackaged: false, fs, path, root
        })).toBe(baseProductConfig);
    });

    test('a packaged build takes backend, channel and repository from the profile', () => {
        const config = lockedConfig('production');
        expect(config.productApiBaseUrl).toBe('https://cut.xulixnacc.online/api/v1');
        expect(config.distribution).toEqual({ locked: true, environment: 'production', source: SOURCE });
        expect(config.updateFilesBase).toBeNull();
        expect(config.updateApiBase).toBeNull();
    });
});

describe('a distributed launcher ignores the local environment', () => {
    const hostile = {
        DEBUG: 'true',
        MICROBOT_CUT_API_BASE_URL: 'http://localhost:5173/api/v1',
        MICROBOT_CUT_RELEASE_UPDATES_ENABLED: 'true',
        MICROBOT_CUT_RELEASE_CHANNEL: 'production',
        MICROBOT_CUT_RELEASE_MANIFEST_URL: 'https://evil.example/manifest',
        MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED: 'true',
        MICROBOT_CUT_PLUGIN_MANIFEST_URL: 'https://evil.example/catalog.json',
        MICROBOT_CUT_PLUGIN_DEV: 'true'
    };

    test('activation targets the profile backend', () => {
        expect(resolveApiBaseUrl(lockedConfig('staging'), hostile)).toBe('https://cut-staging.xulixnacc.online/api/v1');
        expect(resolveApiBaseUrl(lockedConfig('production'), hostile)).toBe('https://cut.xulixnacc.online/api/v1');
    });

    test('an unpackaged development launcher still honors the override', () => {
        expect(resolveApiBaseUrl(baseProductConfig, { MICROBOT_CUT_API_BASE_URL: 'https://cut-staging.xulixnacc.online/api/v1' }))
            .toBe('https://cut-staging.xulixnacc.online/api/v1');
    });

    test.each(['staging', 'production'])('client downloads use only the %s channel and key', (name) => {
        const settings = buildReleaseUpdateSettings({
            environment: hostile,
            productConfig: lockedConfig(name),
            allowEnvironmentConfiguration: true,
            log: log()
        });
        const expected = profile(name).release;
        expect(settings.enabled).toBe(true);
        expect(settings.dynamic).toBeUndefined();
        expect(settings.channel).toBe(name);
        expect(settings.manifestUrl).toBe(expected.manifestUrl);
        expect(settings.artifactBaseUrl).toBe(expected.artifactBaseUrl);
        expect(Object.keys(settings.trustedKeys)).toEqual([expected.publicKeyId]);
        const other = name === 'staging' ? 'production' : 'staging';
        expect(settingsForChannel(settings, name)).toBe(settings);
        expect(settingsForChannel(settings, other)).toBeNull();
    });

    test.each(['staging', 'production'])('plugin installation uses the %s repository natively', (name) => {
        const logger = log();
        const result = buildPluginRepositoryVmArgs({ environment: hostile, productConfig: lockedConfig(name), log: logger });
        const expected = profile(name).pluginRepository;
        expect(result.enabled).toBe(true);
        expect(result.args).toEqual([
            '-Dmicrobot.plugins.repository.enabled=true',
            `-Dmicrobot.plugins.manifestUrl=${expected.manifestUrl}`,
            `-Dmicrobot.plugins.releasesUrl=${expected.releasesUrl}`,
            `-Dmicrobot.plugins.publicKey=${expected.publicKey}`,
            `-Dmicrobot.plugins.publicKeyId=${expected.publicKeyId}`,
            '-Dmicrobot.plugins.developmentMode=false',
            '-Dmicrobot.plugins.releasesApiUrl='
        ]);
        expect(result.args.join(' ')).not.toContain('evil.example');
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('the plugin repository needs no script and no variable', () => {
        const result = buildPluginRepositoryVmArgs({ environment: {}, productConfig: lockedConfig('staging'), log: log() });
        expect(result.enabled).toBe(true);
    });

    test('a broken locked repository profile is an error, never a silent disable', () => {
        const config = {
            ...lockedConfig('staging'),
            pluginRepository: {
                enabled: true,
                manifestUrl: 'http://x',
                releasesUrl: 'https://x/',
                publicKey: 'AAAA',
                publicKeyId: 'staging-1'
            }
        };
        expect(() => buildPluginRepositoryVmArgs({ environment: {}, productConfig: config, log: log() })).toThrow();
    });

    test('MICROBOT_CUT_* variables are not passed to the client process', () => {
        const env = { PATH: 'p', DEBUG: 'true', MICROBOT_CUT_API_BASE_URL: 'x', microbot_cut_plugin_dev: 'true' };
        expect(profileLib.launchEnvironmentFor(lockedConfig('staging'), env)).toEqual({ PATH: 'p', DEBUG: 'true' });
        expect(profileLib.launchEnvironmentFor(baseProductConfig, env)).toEqual(env);
    });
});

describe('packaging', () => {
    test('package.json lists the embedded profile among the packaged files', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(packageJson.build.files).toContain(profileLib.PROFILE_FILE);
    });
});
