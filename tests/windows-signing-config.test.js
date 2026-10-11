const {
    createWindowsProductionConfig
} = require('../libs/windows-signing-config');

describe('Windows production signing configuration', () => {
    const baseBuild = {
        appId: 'com.microbotcut.launcher',
        directories: { buildResources: 'build' },
        win: { target: 'nsis', icon: 'images/microbot_cut.png' }
    };

    test('creates a fail-closed PFX configuration without copying secrets', () => {
        const config = createWindowsProductionConfig(baseBuild, {
            MICROBOT_CUT_WINDOWS_SIGNING_MODE: 'pfx',
            MICROBOT_CUT_WINDOWS_PUBLISHER_NAME: 'Microbot Cut LLC',
            WIN_CSC_LINK: 'base64-secret',
            WIN_CSC_KEY_PASSWORD: 'password-secret'
        });

        expect(config).toMatchObject({
            forceCodeSigning: true,
            directories: {
                buildResources: 'build',
                output: 'dist-production'
            },
            win: {
                forceCodeSigning: true,
                verifyUpdateCodeSignature: true,
                signtoolOptions: {
                    publisherName: ['Microbot Cut LLC'],
                    signingHashAlgorithms: ['sha256']
                }
            }
        });
        expect(JSON.stringify(config)).not.toContain('base64-secret');
        expect(JSON.stringify(config)).not.toContain('password-secret');
    });

    test('creates an Azure Trusted Signing configuration', () => {
        const config = createWindowsProductionConfig(baseBuild, {
            MICROBOT_CUT_WINDOWS_SIGNING_MODE: 'azure',
            MICROBOT_CUT_WINDOWS_PUBLISHER_NAME: 'Microbot Cut LLC',
            MICROBOT_CUT_AZURE_SIGNING_ENDPOINT:
                'https://eus.codesigning.azure.net/',
            MICROBOT_CUT_AZURE_CERTIFICATE_PROFILE: 'production',
            MICROBOT_CUT_AZURE_SIGNING_ACCOUNT: 'microbot-cut'
        });

        expect(config.win.azureSignOptions).toEqual({
            endpoint: 'https://eus.codesigning.azure.net/',
            certificateProfileName: 'production',
            codeSigningAccountName: 'microbot-cut',
            publisherName: 'Microbot Cut LLC'
        });
        expect(config.win.signtoolOptions).toBeUndefined();
    });

    test('refuses missing credentials and unsupported modes', () => {
        expect(() =>
            createWindowsProductionConfig(baseBuild, {
                MICROBOT_CUT_WINDOWS_SIGNING_MODE: 'pfx',
                MICROBOT_CUT_WINDOWS_PUBLISHER_NAME: 'Microbot Cut LLC'
            })
        ).toThrow('WIN_CSC_LINK');

        expect(() =>
            createWindowsProductionConfig(baseBuild, {
                MICROBOT_CUT_WINDOWS_SIGNING_MODE: 'unknown',
                MICROBOT_CUT_WINDOWS_PUBLISHER_NAME: 'Microbot Cut LLC'
            })
        ).toThrow("Unsupported Windows signing mode 'unknown'");
    });
});
