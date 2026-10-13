const fs = require('fs');
const path = require('path');
const productConfig = require('../product-config');

const root = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('Windows installer release metadata', () => {
    it('identifies the project as Microbot Cut', () => {
        expect(packageJson.author).toBe('Microbot Cut');
        expect(packageJson.build.copyright).toBe('Copyright © 2026 Microbot Cut');
        expect(packageJson.build.productName).toBe('Microbot Cut Launcher');
        expect(JSON.stringify(packageJson)).not.toContain('Mocrosoft');
    });

    it('keeps package.json and package-lock.json on the same launcher version', () => {
        expect(packageJson.version).toBe('3.2.12');
        expect(packageLock.version).toBe(packageJson.version);
        expect(packageLock.packages[''].version).toBe(packageJson.version);
    });

    it('names the installer with hyphens so latest.yml and the file on disk agree', () => {
        expect(packageJson.build.win.artifactName)
            .toBe('Microbot-Cut-Launcher-Setup-${version}.${ext}');
        // The release contract forbids spaces in artifact paths.
        expect(packageJson.build.win.artifactName).not.toMatch(/\s/);
    });

    it('does not describe a publisher signature', () => {
        // publisherName and signing options belong only to the production signing config.
        expect(packageJson.build.win.publisherName).toBeUndefined();
        expect(packageJson.build.win.signtoolOptions).toBeUndefined();
        expect(packageJson.build.win.azureSignOptions).toBeUndefined();
    });
});

describe('launcher self-update stays disabled', () => {
    it('has no update feed in the product configuration', () => {
        expect(productConfig.updateFilesBase).toBeNull();
        expect(productConfig.updateApiBase).toBeNull();
    });

    it('does not ship an electron-updater publish configuration', () => {
        // Without build.publish, electron-builder emits no app-update.yml and the updater has no feed.
        expect(packageJson.build.publish).toBeUndefined();
    });
});
