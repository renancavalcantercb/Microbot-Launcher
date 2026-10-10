const fs = require('fs');
const os = require('os');
const path = require('path');

const product = require('../product-config');
const { syncPackageJson } = require('../scripts/sync-product-config');

describe('product identity', () => {
    test('uses a distinct provisional identity and preserves upstream credit', () => {
        expect(product).toMatchObject({
            productId: 'microbot-cut',
            productName: 'Microbot Cut',
            launcherName: 'Microbot Cut Launcher',
            appId: 'com.microbotcut.launcher',
            clientVersion: '2.6.30',
            updateApiBase: null,
            updateFilesBase: null,
            landingPageUrl: null,
            productApiBaseUrl: 'http://localhost:5173/api/v1',
            productApiEnvironmentVariable: 'MICROBOT_CUT_API_BASE_URL',
            pluginDevelopmentEnvironmentVariable:
                'MICROBOT_CUT_PLUGIN_DEV',
            pluginRepositoryEnvironmentVariables: {
                enabled: 'MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED',
                manifestUrl: 'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
                releasesUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_URL',
                releasesApiUrl: 'MICROBOT_CUT_PLUGIN_RELEASES_API_URL',
                publicKey: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
                publicKeyId: 'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID'
            },
            creditLine: 'Based on Microbot'
        });
        expect(product.dataDirectoryName).not.toBe(
            product.legacyDataDirectoryName
        );
    });

    test('maps product and legacy data directories without importing yet', () => {
        const temporaryHome = fs.mkdtempSync(
            path.join(os.tmpdir(), 'product-dirs-')
        );

        try {
            const directories = require('../libs/dir-module');
            expect(directories.resolveDataDirectories(temporaryHome)).toEqual({
                productDataDir: path.join(temporaryHome, '.microbot-cut'),
                legacyDataDir: path.join(temporaryHome, '.microbot')
            });
        } finally {
            fs.rmSync(temporaryHome, { recursive: true, force: true });
        }
    });

    test('synchronizes package metadata from the single product config', () => {
        const directory = fs.mkdtempSync(
            path.join(os.tmpdir(), 'product-package-')
        );
        const packagePath = path.join(directory, 'package.json');
        fs.writeFileSync(
            packagePath,
            JSON.stringify({ build: { nsis: {}, publish: { provider: 'generic' } } })
        );

        try {
            const synchronized = syncPackageJson(packagePath);
            expect(synchronized).toMatchObject({
                name: product.packageName,
                description: product.packageDescription,
                build: {
                    appId: product.appId,
                    productName: product.launcherName,
                    win: { icon: product.iconFile },
                    mac: { icon: product.iconFile },
                    dmg: { icon: product.iconFile },
                    linux: { icon: product.iconFile },
                    nsis: { shortcutName: product.shortcutName }
                }
            });
            expect(synchronized.build.publish).toBeUndefined();
            expect(synchronized.build.files).toContain('product-config.js');
            expect(synchronized.scripts.release).toContain('--publish never');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
