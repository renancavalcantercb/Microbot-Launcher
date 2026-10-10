const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    DataDirectoryImporter,
    IMPORT_MARKER
} = require('../libs/data-directory-importer');
const { resolveActiveDataDirectory } = require('../libs/dir-module');

describe('DataDirectoryImporter', () => {
    let home;
    let legacyDataDir;
    let productDataDir;
    let log;

    beforeEach(() => {
        home = fs.mkdtempSync(path.join(os.tmpdir(), 'data-import-'));
        legacyDataDir = path.join(home, '.microbot');
        productDataDir = path.join(home, '.microbot-cut');
        fs.mkdirSync(legacyDataDir);
        log = { info: jest.fn() };
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    function importer(fileSystem = fs) {
        return new DataDirectoryImporter({
            fs: fileSystem,
            path,
            legacyDataDir,
            productDataDir,
            productId: 'microbot-cut',
            log
        });
    }

    test('copies only active data and recognized client jars', () => {
        fs.writeFileSync(path.join(legacyDataDir, 'accounts.json'), '{"safe":true}');
        fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
        fs.writeFileSync(path.join(legacyDataDir, 'microbot-cut-2.6.30.jar'), 'jar');
        fs.writeFileSync(path.join(legacyDataDir, 'microbot-2.6.20.jar.bak'), 'backup');
        fs.writeFileSync(path.join(legacyDataDir, 'unrelated.txt'), 'ignore');

        expect(importer().importLegacyData()).toEqual({
            imported: true,
            files: [
                'accounts.json',
                'microbot-cut-2.6.30.jar',
                'resource_versions.json'
            ],
            restartRequired: true
        });

        expect(fs.readFileSync(path.join(productDataDir, 'accounts.json'), 'utf8'))
            .toBe('{"safe":true}');
        expect(fs.existsSync(path.join(productDataDir, 'unrelated.txt'))).toBe(false);
        expect(fs.existsSync(path.join(productDataDir, 'microbot-2.6.20.jar.bak')))
            .toBe(false);
        const marker = JSON.parse(
            fs.readFileSync(path.join(productDataDir, IMPORT_MARKER), 'utf8')
        );
        expect(marker).toMatchObject({
            schemaVersion: 1,
            productId: 'microbot-cut',
            sourceDirectoryName: '.microbot'
        });
        expect(marker.files).toHaveLength(3);
        expect(resolveActiveDataDirectory(fs, productDataDir, legacyDataDir))
            .toBe(productDataDir);
        expect(fs.existsSync(path.join(legacyDataDir, 'accounts.json'))).toBe(true);
    });

    test('is idempotent after a completed import', () => {
        fs.writeFileSync(path.join(legacyDataDir, 'accounts.json'), '{}');
        const subject = importer();
        expect(subject.importLegacyData().imported).toBe(true);
        expect(subject.importLegacyData()).toEqual({
            imported: false,
            alreadyImported: true
        });
    });

    test('keeps legacy data and removes staging after verification failure', () => {
        const accountsPath = path.join(legacyDataDir, 'accounts.json');
        fs.writeFileSync(accountsPath, '{"original":true}');
        const corruptingFs = Object.create(fs);
        corruptingFs.copyFileSync = (source, destination) => {
            fs.copyFileSync(source, destination);
            fs.appendFileSync(destination, 'corrupt');
        };

        expect(() => importer(corruptingFs).importLegacyData()).toThrow(
            'Imported file verification failed: accounts.json'
        );
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe('{"original":true}');
        expect(fs.existsSync(productDataDir)).toBe(false);
        expect(
            fs.readdirSync(home).filter((name) => name.includes('.import-'))
        ).toEqual([]);
    });

    test('refuses to overwrite an unmarked product directory', () => {
        fs.writeFileSync(path.join(legacyDataDir, 'accounts.json'), '{}');
        fs.mkdirSync(productDataDir);
        fs.writeFileSync(path.join(productDataDir, 'keep.txt'), 'keep');

        expect(() => importer().importLegacyData()).toThrow(
            'Product data directory already exists without a valid import marker'
        );
        expect(fs.readFileSync(path.join(productDataDir, 'keep.txt'), 'utf8'))
            .toBe('keep');
    });
});
