const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
    buildPluginRepositoryVmArgs
} = require('../libs/plugin-repository-settings');

function publicKeyBase64() {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048
    });
    return publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64');
}

describe('plugin repository launcher settings', () => {
    test('stays disabled by default', () => {
        const log = { info: jest.fn(), error: jest.fn() };

        expect(buildPluginRepositoryVmArgs({ environment: {}, log })).toEqual({
            enabled: false,
            args: []
        });
        expect(log.info).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    test('maps a complete HTTPS configuration to JVM properties', () => {
        const key = publicKeyBase64();
        const log = { info: jest.fn(), error: jest.fn() };
        const result = buildPluginRepositoryVmArgs({
            environment: {
                MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED: 'true',
                MICROBOT_CUT_PLUGIN_MANIFEST_URL:
                    'https://staging.example/catalog.json',
                MICROBOT_CUT_PLUGIN_RELEASES_URL:
                    'https://cdn.example/plugins',
                MICROBOT_CUT_PLUGIN_RELEASES_API_URL:
                    'https://staging.example/releases',
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY: key,
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID: 'staging-2026'
            },
            log
        });

        expect(result.enabled).toBe(true);
        expect(result.args).toEqual(
            expect.arrayContaining([
                '-Dmicrobot.plugins.repository.enabled=true',
                '-Dmicrobot.plugins.manifestUrl=https://staging.example/catalog.json',
                '-Dmicrobot.plugins.releasesUrl=https://cdn.example/plugins',
                '-Dmicrobot.plugins.releasesApiUrl=https://staging.example/releases',
                `-Dmicrobot.plugins.publicKey=${key}`,
                '-Dmicrobot.plugins.publicKeyId=staging-2026'
            ])
        );
        expect(log.error).not.toHaveBeenCalled();
    });

    test('accepts the checked-in public staging trust configuration', () => {
        const config = JSON.parse(
            fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    'config',
                    'plugin-repository.staging.json'
                ),
                'utf8'
            )
        );
        const result = buildPluginRepositoryVmArgs({
            environment: {
                MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED: 'true',
                MICROBOT_CUT_PLUGIN_MANIFEST_URL: config.manifestUrl,
                MICROBOT_CUT_PLUGIN_RELEASES_URL: config.releasesUrl,
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY: config.publicKey,
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID: config.publicKeyId
            },
            log: { info: jest.fn(), error: jest.fn() }
        });

        expect(result.enabled).toBe(true);
        expect(result.args).toContain(
            `-Dmicrobot.plugins.manifestUrl=${config.manifestUrl}`
        );
    });

    test.each([
        ['an HTTP manifest', { MICROBOT_CUT_PLUGIN_MANIFEST_URL: 'http://example/catalog.json' }],
        ['a manifest with credentials', { MICROBOT_CUT_PLUGIN_MANIFEST_URL: 'https://user:pass@example/catalog.json' }],
        ['an invalid public key', { MICROBOT_CUT_PLUGIN_PUBLIC_KEY: 'not-a-key' }],
        ['an unsafe key id', { MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID: '../key' }]
    ])('fails closed for %s', (_, override) => {
        const log = { info: jest.fn(), error: jest.fn() };
        const result = buildPluginRepositoryVmArgs({
            environment: {
                MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED: 'true',
                MICROBOT_CUT_PLUGIN_MANIFEST_URL:
                    'https://staging.example/catalog.json',
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY: publicKeyBase64(),
                MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID: 'staging-2026',
                ...override
            },
            log
        });

        expect(result).toEqual({ enabled: false, args: [] });
        expect(log.error).toHaveBeenCalledWith(
            expect.stringContaining('keeping it disabled')
        );
    });
});
