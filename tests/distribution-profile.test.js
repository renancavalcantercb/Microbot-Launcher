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

describe('installer identity and data isolation', () => {
    test('production keeps exactly the identity the launcher always had', () => {
        const production = lockedConfig('production');
        for (const key of [
            'appId', 'launcherName', 'shortcutName', 'dataDirectoryName',
            'legacyDataDirectoryName', 'launcherDataDirectoryName'
        ]) {
            expect(production[key]).toBe(baseProductConfig[key]);
        }
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(packageJson.build.appId).toBe(production.appId);
        expect(packageJson.build.productName).toBe(production.launcherName);
        expect(production.distribution.clientHomeDirectoryName).toBeNull();
        expect(production.distribution.userDataDirectoryName).toBeNull();
    });

    test('staging is clearly identified and shares no identity field with production', () => {
        const staging = profile('staging').identity;
        const production = profile('production').identity;
        expect(staging.productName).toContain('Staging');
        expect(staging.shortcutName).toContain('Staging');
        expect(staging.appId).toMatch(/staging/);
        for (const key of ['appId', 'productName', 'shortcutName', 'dataDirectoryName']) {
            expect(staging[key]).not.toBe(production[key]);
        }
        expect(staging.legacyDataDirectoryName).toBeNull();
        expect(staging.userDataDirectoryName).toBeTruthy();
        expect(staging.clientHomeDirectoryName).toBeTruthy();
    });

    test.each([
        ['staging reusing the production app id', 'staging', (p) => { p.identity.appId = 'com.microbotcut.launcher'; }, 'appId'],
        ['staging reusing the production data directory', 'staging', (p) => { p.identity.dataDirectoryName = '.microbot-cut'; }, 'dataDirectoryName'],
        ['staging importing the legacy directory', 'staging', (p) => { p.identity.legacyDataDirectoryName = '.microbot'; }, 'legacyDataDirectoryName'],
        ['staging sharing the production Electron data', 'staging', (p) => { p.identity.userDataDirectoryName = null; }, 'userDataDirectoryName'],
        ['staging without its own client home', 'staging', (p) => { p.identity.clientHomeDirectoryName = null; }, 'clientHomeDirectoryName'],
        ['a missing identity', 'staging', (p) => { delete p.identity; }, 'profile.identity'],
        ['production changing its app id', 'production', (p) => { p.identity.appId = 'com.microbotcut.launcher.staging'; }, 'appId'],
        ['production changing its name', 'production', (p) => { p.identity.productName = 'Other'; }, 'productName']
    ])('rejects %s', (_label, name, mutate, fragment) => {
        expect(rejection(mutate, name)).toContain(fragment);
    });

    function dataLayout(name) {
        let layout;
        jest.isolateModules(() => {
            jest.doMock('../libs/runtime-config', () => ({ getProductConfig: () => lockedConfig(name) }));
            const dirModule = require('../libs/dir-module');
            const home = path.join(os.tmpdir(), 'home-never-created');
            layout = { ...dirModule.resolveDataDirectories(home), home, config: lockedConfig(name) };
            layout.active = dirModule.resolveActiveDataDirectory(fs, layout.productDataDir, layout.legacyDataDir);
        });
        jest.dontMock('../libs/runtime-config');
        return layout;
    }

    const disjoint = (a, b) => {
        const down = path.relative(b, a);
        const up = path.relative(a, b);
        return (down.startsWith('..') || path.isAbsolute(down)) && (up.startsWith('..') || path.isAbsolute(up));
    };

    test('every persistent location of staging is disjoint from production', () => {
        const staging = dataLayout('staging');
        const production = dataLayout('production');
        const stagingDirs = [
            staging.productDataDir,
            profileLib.clientHomeDirectory(staging.config, staging.productDataDir, path),
            path.join('C:/AppData/Roaming', staging.config.distribution.userDataDirectoryName)
        ];
        const productionDirs = [
            production.productDataDir,
            production.legacyDataDir,
            path.join(production.home, '.runelite'),
            path.join('C:/AppData/Roaming', 'microbot-launcher')
        ];
        for (const a of stagingDirs) {
            for (const b of productionDirs) expect(disjoint(a, b)).toBe(true);
        }
        expect(staging.legacyDataDir).toBeNull();
        expect(staging.active).toBe(staging.productDataDir);
        expect(production.active).toBe(production.legacyDataDir);
    });

    test('production data locations are unchanged', () => {
        const production = dataLayout('production');
        expect(production.productDataDir).toBe(path.join(production.home, '.microbot-cut'));
        expect(production.legacyDataDir).toBe(path.join(production.home, '.microbot'));
    });

    test('only staging moves the client home', () => {
        expect(profileLib.clientHomeDirectory(lockedConfig('production'), '/data', path)).toBeNull();
        expect(profileLib.clientHomeDirectory(lockedConfig('staging'), '/data', path))
            .toBe(path.join('/data', 'client-home'));
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
        expect(config.distribution).toEqual({
            locked: true,
            environment: 'production',
            userDataDirectoryName: null,
            clientHomeDirectoryName: null,
            source: SOURCE
        });
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

describe('session storage and development tools in a distributed launcher', () => {
    const { ProductSessionService } = require('../libs/product-session');
    const mockAuth = require('../libs/mock-auth');
    const secretStore = {
        isAvailable: () => true,
        protect: (value) => ({ protection: 'test', value: Buffer.from(value).toString('base64') }),
        reveal: (value) => Buffer.from(value.value, 'base64').toString('utf8')
    };
    const session = {
        tokenType: 'Bearer',
        accessToken: 'mbc_at_selector_123.secret_access_value_abcdefghijklmnopqrstuvwxyz',
        accessExpiresAt: new Date(Date.now() + 900000).toISOString(),
        refreshToken: 'mbc_rt_selector_123.secret_refresh_value_abcdefghijklmnopqrstuvwxyz',
        refreshExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        device: { id: 'device-id', name: 'Test PC' }
    };
    const service = (dir, productConfig) => new ProductSessionService({
        axios: {},
        fs,
        path,
        productDataDir: dir,
        productConfig,
        packageJson: { version: '3.2.11' },
        secretStore,
        installationIdentity: { getOrCreate: () => 'id' },
        log: { warn: jest.fn(), info: jest.fn() },
        environment: {}
    });

    test('staging and production keep separate session files', () => withTempDir((dir) => {
        const staging = service(dir, lockedConfig('staging'));
        const production = service(dir, lockedConfig('production'));
        expect(path.basename(staging.filePath)).toBe('product-session-staging.json');
        expect(path.basename(production.filePath)).toBe('product-session-production.json');
        staging.save(session);
        expect(production.load()).toBeNull();
        expect(staging.load().device.id).toBe('device-id');
    }));

    test('a distributed launcher never reads the shared legacy session file', () => withTempDir((dir) => {
        const development = service(dir, baseProductConfig);
        development.save(session);
        expect(fs.existsSync(path.join(dir, 'product-session.json'))).toBe(true);
        for (const name of ['staging', 'production']) {
            const locked = service(dir, lockedConfig(name));
            expect(locked.legacyFilePath).toBe(locked.filePath);
            expect(locked.load()).toBeNull();
        }
        expect(fs.existsSync(path.join(dir, 'product-session.json'))).toBe(true);
    }));

    test('mock authentication stays off in a distributed launcher even with MOCK_AUTH set', async () => {
        const original = process.env.MOCK_AUTH;
        process.env.MOCK_AUTH = '1';
        try {
            const handlers = new Map();
            const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
            mockAuth({ ipcMain, log: log(), allowMock: false });
            expect(await handlers.get('auth:status')(null)).toEqual({ authenticated: true, mock: false });
        } finally {
            if (original === undefined) delete process.env.MOCK_AUTH;
            else process.env.MOCK_AUTH = original;
        }
    });

    test('the signed production configuration keeps the profile packaging settings', () => {
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        const config = require('../libs/windows-signing-config').createWindowsProductionConfig(packageJson.build, {
            MICROBOT_CUT_WINDOWS_SIGNING_MODE: 'pfx',
            MICROBOT_CUT_WINDOWS_PUBLISHER_NAME: 'Test Publisher',
            WIN_CSC_LINK: 'x',
            WIN_CSC_KEY_PASSWORD: 'y'
        });
        expect(config.beforePack).toBe('scripts/require-distribution-profile.js');
        expect(config.files).toContain(profileLib.PROFILE_FILE);
    });
});
