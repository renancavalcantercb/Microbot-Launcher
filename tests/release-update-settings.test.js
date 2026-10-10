const crypto = require('crypto');

const {
    buildReleaseUpdateSettings
} = require('../libs/release-update-settings');

function publicKey() {
    return crypto
        .generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64');
}

describe('release update settings', () => {
    test('remain disabled by default', () => {
        expect(buildReleaseUpdateSettings({ environment: {}, productConfig: {} })).toEqual({
            enabled: false
        });
    });

    test('ignore environment-provided trust configuration outside development', () => {
        expect(
            buildReleaseUpdateSettings({
                environment: { MICROBOT_CUT_RELEASE_UPDATES_ENABLED: 'true' },
                productConfig: {},
                allowEnvironmentConfiguration: false
            })
        ).toEqual({ enabled: false });
    });

    test('accept valid explicit development configuration', () => {
        const settings = buildReleaseUpdateSettings({
            environment: {
                MICROBOT_CUT_RELEASE_UPDATES_ENABLED: 'true',
                MICROBOT_CUT_RELEASE_CHANNEL: 'staging',
                MICROBOT_CUT_RELEASE_MANIFEST_URL: 'https://cut.example/releases/staging/manifest.json',
                MICROBOT_CUT_RELEASE_ARTIFACT_BASE_URL: 'https://cut.example/',
                MICROBOT_CUT_RELEASE_PUBLIC_KEY: publicKey(),
                MICROBOT_CUT_RELEASE_PUBLIC_KEY_ID: 'release-staging-2026'
            },
            productConfig: {},
            allowEnvironmentConfiguration: true
        });

        expect(settings).toMatchObject({
            enabled: true,
            channel: 'staging',
            manifestUrl: 'https://cut.example/releases/staging/manifest.json',
            artifactBaseUrl: 'https://cut.example/'
        });
        expect(settings.trustedKeys['release-staging-2026']).toBeTruthy();
    });

    test('disables invalid development configuration', () => {
        const log = { error: jest.fn() };
        expect(
            buildReleaseUpdateSettings({
                environment: {
                    MICROBOT_CUT_RELEASE_UPDATES_ENABLED: 'true',
                    MICROBOT_CUT_RELEASE_CHANNEL: 'staging',
                    MICROBOT_CUT_RELEASE_MANIFEST_URL: 'http://cut.example/manifest.json'
                },
                productConfig: {},
                allowEnvironmentConfiguration: true,
                log
            })
        ).toEqual({ enabled: false });
        expect(log.error).toHaveBeenCalled();
    });
});
