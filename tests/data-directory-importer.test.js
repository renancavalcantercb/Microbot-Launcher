const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    DataDirectoryImporter,
    IMPORT_MARKER
} = require('../libs/data-directory-importer');
const { AccountRepository } = require('../libs/account-repository');
const { resolveActiveDataDirectory } = require('../libs/dir-module');
const { guardDirectory } = require('./helpers/legacy-write-guard');

const PLAIN_SESSION = 'plain-session-id-AAAA';
const SECOND_SESSION = 'plain-session-id-BBBB';

// A secret store whose blobs only decrypt under the same key, like safeStorage under another app.
function fakeStore({ key = 'k1', available = true, failProtect = false, failReveal = false } = {}) {
    return {
        isAvailable: () => available,
        protect: jest.fn((value) => {
            if (failProtect) throw new Error('protect failed');
            return {
                protection: 'electron-safe-storage-v1',
                value: Buffer.from(`${key}:${value}`).toString('base64')
            };
        }),
        reveal: jest.fn((entry) => {
            if (failReveal) throw new Error('reveal failed');
            const text = Buffer.from(entry.value, 'base64').toString('utf8');
            if (!text.startsWith(`${key}:`)) throw new Error('cannot decrypt');
            return text.slice(key.length + 1);
        })
    };
}

function snapshot(directory) {
    const result = {};
    for (const name of fs.readdirSync(directory).sort()) {
        const full = path.join(directory, name);
        const stat = fs.statSync(full);
        result[name] = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        };
    }
    return result;
}

function walkText(directory) {
    return fs
        .readdirSync(directory)
        .map((name) => fs.readFileSync(path.join(directory, name), 'utf8'))
        .join('\n');
}

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
        fs.mkdirSync(productDataDir);
        log = { info: jest.fn(), error: jest.fn() };
    });

    afterEach(() => {
        fs.rmSync(home, { recursive: true, force: true });
    });

    function importer({ fileSystem = fs, secretStore = fakeStore() } = {}) {
        let counter = 0;
        return new DataDirectoryImporter({
            fs: fileSystem,
            path,
            legacyDataDir,
            productDataDir,
            productId: 'microbot-cut',
            log,
            secretStore,
            createSessionRef: () => `ref-${++counter}`
        });
    }

    function writePlainAccounts() {
        fs.writeFileSync(
            path.join(legacyDataDir, 'accounts.json'),
            JSON.stringify([
                { accountId: 'a1', displayName: 'One', sessionId: PLAIN_SESSION },
                { accountId: 'a2', displayName: 'Two', sessionId: SECOND_SESSION }
            ])
        );
    }

    function schema2Document(key) {
        const store = fakeStore({ key });
        return {
            schemaVersion: 2,
            accounts: [{ accountId: 's1', displayName: 'S', sessionRef: 'r1' }],
            sessions: { r1: store.protect('schema2-session-CCCC') }
        };
    }

    function repositoryOn(directory, fileSystem = fs) {
        return new AccountRepository({
            fs: fileSystem,
            path,
            microbotDir: directory,
            log,
            secretStore: fakeStore()
        });
    }

    test('imports recognized files and keeps the legacy directory byte-identical', () => {
        writePlainAccounts();
        fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
        fs.writeFileSync(path.join(legacyDataDir, 'microbot-cut-2.6.30.jar'), 'jar');
        fs.writeFileSync(path.join(legacyDataDir, 'microbot-2.6.20.jar.bak'), 'backup');
        fs.writeFileSync(path.join(legacyDataDir, 'unrelated.txt'), 'ignore');
        const before = snapshot(legacyDataDir);

        const result = importer().importLegacyData();

        expect(result).toMatchObject({
            imported: true,
            accounts: 'converted',
            files: ['accounts.json', 'microbot-cut-2.6.30.jar', 'resource_versions.json'],
            restartRequired: true
        });
        expect(fs.existsSync(path.join(productDataDir, 'unrelated.txt'))).toBe(false);
        expect(fs.existsSync(path.join(productDataDir, 'microbot-2.6.20.jar.bak'))).toBe(false);
        expect(snapshot(legacyDataDir)).toEqual(before);
        expect(resolveActiveDataDirectory(fs, productDataDir, legacyDataDir)).toBe(productDataDir);
        expect(fs.readdirSync(home).filter((n) => n.includes('.import-'))).toEqual([]);
    });

    test('converts plain sessions in memory: no plain-text session reaches the product directory', () => {
        writePlainAccounts();
        importer().importLegacyData();

        const text = walkText(productDataDir);
        expect(text).not.toContain(PLAIN_SESSION);
        expect(text).not.toContain(SECOND_SESSION);
        const accounts = JSON.parse(
            fs.readFileSync(path.join(productDataDir, 'accounts.json'), 'utf8')
        );
        expect(accounts.schemaVersion).toBe(2);
        expect(accounts.accounts.every((a) => !('sessionId' in a))).toBe(true);
        const repository = repositoryOn(productDataDir);
        expect(repository.getAccountForLaunch('a1').sessionId).toBe(PLAIN_SESSION);
        expect(repository.getAccountForLaunch('a2').sessionId).toBe(SECOND_SESSION);
    });

    test('never writes plain text anywhere on disk during the import', () => {
        writePlainAccounts();
        const written = [];
        const spyFs = Object.create(fs);
        spyFs.writeFileSync = (file, ...rest) => {
            fs.writeFileSync(file, ...rest);
            written.push(fs.readFileSync(file, 'utf8'));
        };
        spyFs.copyFileSync = (source, destination) => {
            fs.copyFileSync(source, destination);
            written.push(fs.readFileSync(destination, 'utf8'));
        };
        importer({ fileSystem: spyFs }).importLegacyData();
        expect(written.length).toBeGreaterThan(0);
        for (const content of written) {
            expect(content).not.toContain(PLAIN_SESSION);
            expect(content).not.toContain(SECOND_SESSION);
        }
    });

    test('the marker holds no token, session id or credential hash', () => {
        writePlainAccounts();
        fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
        importer().importLegacyData();

        const markerText = fs.readFileSync(path.join(productDataDir, IMPORT_MARKER), 'utf8');
        const marker = JSON.parse(markerText);
        expect(marker).toMatchObject({
            schemaVersion: 1,
            productId: 'microbot-cut',
            sourceDirectoryName: '.microbot',
            accounts: 'converted'
        });
        const accountsEntry = marker.files.find((entry) => entry.name === 'accounts.json');
        expect(accountsEntry).toEqual({ name: 'accounts.json', handling: 'converted' });
        const sha = (file) =>
            crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        expect(markerText).not.toContain(sha(path.join(legacyDataDir, 'accounts.json')));
        expect(markerText).not.toContain(sha(path.join(productDataDir, 'accounts.json')));
        expect(markerText).not.toContain(PLAIN_SESSION);
    });

    test('carries a schema 2 file that this install can decrypt, re-protected', () => {
        fs.writeFileSync(
            path.join(legacyDataDir, 'accounts.json'),
            JSON.stringify(schema2Document('k1'))
        );
        const result = importer().importLegacyData();
        expect(result.accounts).toBe('carried');
        expect(repositoryOn(productDataDir).getAccountForLaunch('s1').sessionId).toBe(
            'schema2-session-CCCC'
        );
    });

    test('a schema 2 file this install cannot decrypt is not imported; the user signs in again', () => {
        fs.writeFileSync(
            path.join(legacyDataDir, 'accounts.json'),
            JSON.stringify(schema2Document('other-key'))
        );
        fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
        const before = snapshot(legacyDataDir);

        const result = importer().importLegacyData();

        expect(result.accounts).toBe('undecryptable');
        expect(result.files).toEqual(['resource_versions.json']);
        expect(fs.existsSync(path.join(productDataDir, 'accounts.json'))).toBe(false);
        expect(snapshot(legacyDataDir)).toEqual(before);
    });

    test('refuses when the product directory already has its own accounts (G8)', () => {
        writePlainAccounts();
        fs.writeFileSync(path.join(productDataDir, 'accounts.json'), '{"keep":true}');
        expect(() => importer().importLegacyData()).toThrow('already has its own accounts');
        expect(fs.readFileSync(path.join(productDataDir, 'accounts.json'), 'utf8')).toBe(
            '{"keep":true}'
        );
        expect(importer().status()).toMatchObject({ productHasData: true, offerImport: false });
    });

    test('does not replace product files that already exist and reports them', () => {
        writePlainAccounts();
        fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{"legacy":1}');
        fs.writeFileSync(path.join(productDataDir, 'resource_versions.json'), '{"mine":1}');
        const result = importer().importLegacyData();
        expect(result.skippedExisting).toEqual(['resource_versions.json']);
        expect(fs.readFileSync(path.join(productDataDir, 'resource_versions.json'), 'utf8')).toBe(
            '{"mine":1}'
        );
    });

    test('is idempotent after a completed import and reports no offer', () => {
        writePlainAccounts();
        const subject = importer();
        expect(subject.importLegacyData().imported).toBe(true);
        expect(subject.importLegacyData()).toEqual({ imported: false, alreadyImported: true });
        expect(subject.status()).toMatchObject({
            importComplete: true,
            productHasData: true,
            offerImport: false,
            active: 'product'
        });
    });

    test('offers the import only for an empty product directory with legacy data', () => {
        expect(importer().status().offerImport).toBe(false);
        writePlainAccounts();
        expect(importer().status()).toMatchObject({ offerImport: true, productHasData: false });
    });

    describe('failure leaves no partly usable state and never touches the original', () => {
        function assertClean(before) {
            expect(snapshot(legacyDataDir)).toEqual(before);
            expect(fs.existsSync(path.join(productDataDir, 'accounts.json'))).toBe(false);
            expect(fs.existsSync(path.join(productDataDir, IMPORT_MARKER))).toBe(false);
            expect(fs.readdirSync(home).filter((n) => n.includes('.import-'))).toEqual([]);
            expect(importer().hasCompletedImport()).toBe(false);
        }

        test.each([
            ['protect fails (DPAPI error)', { failProtect: true }],
            ['secure storage unavailable', { available: false }],
            ['verification by decrypting fails', { failReveal: true }]
        ])('plain source, %s', (_label, options) => {
            writePlainAccounts();
            fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
            const before = snapshot(legacyDataDir);
            expect(() =>
                importer({ secretStore: fakeStore(options) }).importLegacyData()
            ).toThrow();
            assertClean(before);
        });

        test('no secret store at all', () => {
            writePlainAccounts();
            const before = snapshot(legacyDataDir);
            expect(() => importer({ secretStore: null }).importLegacyData()).toThrow();
            assertClean(before);
        });

        test('corrupt copy of another file', () => {
            writePlainAccounts();
            fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
            const before = snapshot(legacyDataDir);
            const corruptingFs = Object.create(fs);
            corruptingFs.copyFileSync = (source, destination) => {
                fs.copyFileSync(source, destination);
                fs.appendFileSync(destination, 'corrupt');
            };
            expect(() => importer({ fileSystem: corruptingFs }).importLegacyData()).toThrow(
                'Imported file verification failed: resource_versions.json'
            );
            assertClean(before);
        });

        test('unreadable legacy accounts file', () => {
            fs.writeFileSync(path.join(legacyDataDir, 'accounts.json'), '{not json');
            const before = snapshot(legacyDataDir);
            expect(() => importer().importLegacyData()).toThrow();
            assertClean(before);
        });

        test('interrupted while moving into the product directory (marker rename fails)', () => {
            writePlainAccounts();
            fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
            const before = snapshot(legacyDataDir);
            const interruptingFs = Object.create(fs);
            interruptingFs.renameSync = (from, to) => {
                if (path.basename(to) === IMPORT_MARKER) throw new Error('interrupted');
                return fs.renameSync(from, to);
            };
            expect(() => importer({ fileSystem: interruptingFs }).importLegacyData()).toThrow(
                'interrupted'
            );
            assertClean(before);
            expect(fs.existsSync(path.join(productDataDir, 'resource_versions.json'))).toBe(false);
        });

        test('cleanup removes only files of this attempt, not product files already there', () => {
            writePlainAccounts();
            fs.writeFileSync(path.join(productDataDir, 'resource_versions.json'), '{"mine":1}');
            fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
            const interruptingFs = Object.create(fs);
            interruptingFs.renameSync = (from, to) => {
                if (path.basename(to) === IMPORT_MARKER) throw new Error('interrupted');
                return fs.renameSync(from, to);
            };
            expect(() => importer({ fileSystem: interruptingFs }).importLegacyData()).toThrow();
            expect(
                fs.readFileSync(path.join(productDataDir, 'resource_versions.json'), 'utf8')
            ).toBe('{"mine":1}');
        });
    });

    describe('no write ever reaches the legacy directory (guarantees G1 and G7)', () => {
        test.each([
            ['success with a plain source', true, () => writePlainAccounts()],
            ['failure with a plain source', false, () => writePlainAccounts()],
            [
                'schema 2 source that cannot be decrypted',
                true,
                () =>
                    fs.writeFileSync(
                        path.join(legacyDataDir, 'accounts.json'),
                        JSON.stringify(schema2Document('other-key'))
                    )
            ]
        ])('%s', (_label, works, setup) => {
            setup();
            fs.writeFileSync(path.join(legacyDataDir, 'resource_versions.json'), '{}');
            const guard = guardDirectory(fs, legacyDataDir);
            const subject = importer({
                fileSystem: guard.fs,
                secretStore: fakeStore({ failProtect: !works })
            });
            if (works) subject.importLegacyData();
            else expect(() => subject.importLegacyData()).toThrow();
            expect(guard.violations).toEqual([]);
        });

        test('repository operations, including removeAll, act on the product directory only', () => {
            writePlainAccounts();
            const guard = guardDirectory(fs, legacyDataDir);
            const active = resolveActiveDataDirectory(guard.fs, productDataDir, legacyDataDir);
            const repository = repositoryOn(active, guard.fs);
            repository.migrateLegacy();
            repository.storeFetchedAccounts([{ accountId: 'n1' }], 'fresh-session', 'now');
            repository.setProfile('n1', 'profile');
            repository.deleteAccount('n1');
            repository.removeAll();
            expect(guard.violations).toEqual([]);
            expect(fs.existsSync(path.join(legacyDataDir, 'accounts.json'))).toBe(true);
        });

        test('the guard itself catches a write (self-check)', () => {
            const guard = guardDirectory(fs, legacyDataDir);
            expect(() => guard.fs.writeFileSync(path.join(legacyDataDir, 'x'), '1')).toThrow(
                'guarded directory'
            );
            expect(() =>
                guard.fs.renameSync(path.join(legacyDataDir, 'x'), path.join(productDataDir, 'x'))
            ).toThrow('guarded directory');
            expect(guard.violations).toHaveLength(2);
        });
    });
});
