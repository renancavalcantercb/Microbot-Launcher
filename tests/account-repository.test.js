const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    AccountRepository,
    ACCOUNT_SCHEMA_VERSION
} = require('../libs/account-repository');

describe('AccountRepository', () => {
    let directory;
    let accountsPath;
    let log;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-repo-'));
        accountsPath = path.join(directory, 'accounts.json');
        log = { error: jest.fn() };
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('sanitizes legacy accounts before returning them to the renderer', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                {
                    accountId: 'character-1',
                    displayName: 'Fake One',
                    userHash: 'user-hash',
                    sessionId: 'fake-session-secret',
                    createdOn: '2026-10-09T00:00:00.000Z',
                    profile: 'main'
                }
            ])
        );
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log
        });

        const publicAccounts = repository.listPublicAccounts();

        expect(publicAccounts).toEqual([
            {
                accountId: 'character-1',
                displayName: 'Fake One',
                createdOn: '2026-10-09T00:00:00.000Z',
                profile: 'main'
            }
        ]);
        expect(JSON.stringify(publicAccounts)).not.toContain('session');
        expect(JSON.stringify(publicAccounts)).not.toContain('user-hash');
        expect(repository.getAccountForLaunch('character-1')).toMatchObject({
            accountId: 'character-1',
            sessionId: 'fake-session-secret'
        });
    });

    test('reveals a protected session only for internal launch use', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify({
                schemaVersion: ACCOUNT_SCHEMA_VERSION,
                accounts: [
                    {
                        accountId: 'character-2',
                        displayName: 'Fake Two',
                        sessionRef: 'session-ref'
                    }
                ],
                sessions: {
                    'session-ref': {
                        protection: 'electron-safe-storage-v1',
                        value: 'protected-value'
                    }
                }
            })
        );
        const secretStore = {
            reveal: jest.fn(() => 'revealed-session')
        };
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore
        });

        expect(repository.listPublicAccounts()[0]).not.toHaveProperty(
            'sessionRef'
        );
        expect(repository.getAccountForLaunch('character-2')).toMatchObject({
            accountId: 'character-2',
            sessionId: 'revealed-session'
        });
        expect(secretStore.reveal).toHaveBeenCalledTimes(1);
    });

    test('updates legacy metadata without losing its session', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                {
                    accountId: 'character-3',
                    displayName: 'Fake Three',
                    sessionId: 'keep-this-session'
                }
            ])
        );
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log
        });

        expect(repository.setProfile('character-3', 'profile-a')).toBe(true);

        expect(JSON.parse(fs.readFileSync(accountsPath, 'utf8'))).toEqual([
            {
                accountId: 'character-3',
                displayName: 'Fake Three',
                sessionId: 'keep-this-session',
                profile: 'profile-a'
            }
        ]);
    });

    test('migrates legacy accounts and deduplicates shared sessions', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                {
                    accountId: 'character-1',
                    displayName: 'Fake One',
                    sessionId: 'shared-session',
                    profile: 'main'
                },
                {
                    accountId: 'character-2',
                    displayName: 'Fake Two',
                    sessionId: 'shared-session'
                }
            ])
        );
        const secretStore = {
            isAvailable: jest.fn(() => true),
            protect: jest.fn((value) => ({
                protection: 'test',
                value: Buffer.from(value).toString('base64')
            })),
            reveal: jest.fn((entry) =>
                Buffer.from(entry.value, 'base64').toString('utf8')
            )
        };
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore,
            createSessionRef: () => 'shared-ref'
        });

        expect(repository.migrateLegacy()).toEqual({
            migrated: true,
            accounts: 2,
            sessions: 1
        });

        const migrated = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        expect(migrated).toEqual({
            schemaVersion: ACCOUNT_SCHEMA_VERSION,
            accounts: [
                {
                    accountId: 'character-1',
                    displayName: 'Fake One',
                    profile: 'main',
                    sessionRef: 'shared-ref'
                },
                {
                    accountId: 'character-2',
                    displayName: 'Fake Two',
                    sessionRef: 'shared-ref'
                }
            ],
            sessions: {
                'shared-ref': {
                    protection: 'test',
                    value: Buffer.from('shared-session').toString('base64')
                }
            }
        });
        expect(JSON.stringify(migrated)).not.toContain('shared-session');
        expect(secretStore.protect).toHaveBeenCalledTimes(1);
        expect(repository.getAccountForLaunch('character-2').sessionId).toBe(
            'shared-session'
        );
    });

    test('migration is idempotent', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify({
                schemaVersion: ACCOUNT_SCHEMA_VERSION,
                accounts: [],
                sessions: {}
            })
        );
        const before = fs.readFileSync(accountsPath, 'utf8');
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore: {
                isAvailable: jest.fn(() => true),
                protect: jest.fn(),
                reveal: jest.fn()
            }
        });

        expect(repository.migrateLegacy()).toEqual({
            migrated: false,
            accounts: 0
        });
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe(before);
        expect(repository.secretStore.protect).not.toHaveBeenCalled();
    });

    test('keeps the legacy file when protected-session verification fails', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                {
                    accountId: 'character-1',
                    sessionId: 'original-session'
                }
            ])
        );
        const before = fs.readFileSync(accountsPath, 'utf8');
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore: {
                isAvailable: () => true,
                protect: () => ({ protection: 'test', value: 'bad' }),
                reveal: () => 'different-session'
            }
        });

        expect(() => repository.migrateLegacy()).toThrow(
            'Protected Jagex session verification failed'
        );
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe(before);
        expect(
            fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))
        ).toEqual([]);
    });

    test('fails closed when secure storage is unavailable', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                { accountId: 'character-1', sessionId: 'original-session' }
            ])
        );
        const before = fs.readFileSync(accountsPath, 'utf8');
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore: { isAvailable: () => false }
        });

        expect(() => repository.migrateLegacy()).toThrow(
            'Secure account storage is unavailable'
        );
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe(before);
    });

    test('keeps the legacy file when the atomic replacement fails', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                { accountId: 'character-1', sessionId: 'original-session' }
            ])
        );
        const before = fs.readFileSync(accountsPath, 'utf8');
        const failingFs = Object.create(fs);
        failingFs.renameSync = jest.fn(() => {
            throw new Error('simulated rename failure');
        });
        const repository = new AccountRepository({
            fs: failingFs,
            path,
            microbotDir: directory,
            log,
            secretStore: {
                isAvailable: () => true,
                protect: (value) => ({ protection: 'test', value }),
                reveal: (entry) => entry.value
            },
            createSessionRef: () => 'session-ref'
        });

        expect(() => repository.migrateLegacy()).toThrow(
            'simulated rename failure'
        );
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe(before);
        expect(
            fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))
        ).toEqual([]);
    });

    test('stores fetched accounts without persisting a plaintext session', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify({
                schemaVersion: ACCOUNT_SCHEMA_VERSION,
                accounts: [
                    {
                        accountId: 'character-1',
                        displayName: 'Old Name',
                        profile: 'main',
                        sessionRef: 'old-ref'
                    }
                ],
                sessions: {
                    'old-ref': { protection: 'test', value: 'old-session' }
                }
            })
        );
        const secretStore = {
            reveal: jest.fn((entry) => entry.value),
            protect: jest.fn((value) => ({ protection: 'test', value }))
        };
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore,
            createSessionRef: () => 'new-ref'
        });

        expect(
            repository.storeFetchedAccounts(
                [
                    {
                        accountId: 'character-1',
                        displayName: 'New Name',
                        userHash: 'hash-1'
                    },
                    {
                        accountId: 'character-2',
                        displayName: 'Second',
                        userHash: 'hash-1'
                    }
                ],
                'new-session',
                '2026-10-09T12:00:00.000Z'
            )
        ).toEqual({ added: 1, updated: 1 });

        const stored = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        expect(stored.accounts).toEqual([
            {
                accountId: 'character-1',
                displayName: 'New Name',
                profile: 'main',
                sessionRef: 'new-ref',
                userHash: 'hash-1'
            },
            {
                accountId: 'character-2',
                displayName: 'Second',
                userHash: 'hash-1',
                sessionRef: 'new-ref',
                createdOn: '2026-10-09T12:00:00.000Z'
            }
        ]);
        expect(stored.sessions['new-ref']).toEqual({
            protection: 'test',
            value: 'new-session'
        });
        expect(JSON.stringify(stored.accounts)).not.toContain('new-session');
    });

    test('reuses an existing protected session when refreshing accounts', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify({
                schemaVersion: ACCOUNT_SCHEMA_VERSION,
                accounts: [
                    {
                        accountId: 'character-1',
                        displayName: 'Keep Name',
                        sessionRef: 'shared-ref'
                    }
                ],
                sessions: {
                    'shared-ref': { protection: 'test', value: 'shared-session' }
                }
            })
        );
        const secretStore = {
            reveal: jest.fn((entry) => entry.value),
            protect: jest.fn()
        };
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore
        });

        expect(
            repository.storeFetchedAccounts(
                [{ accountId: 'character-1', displayName: '' }],
                'shared-session',
                'unused'
            )
        ).toEqual({ added: 0, updated: 0 });
        expect(secretStore.protect).not.toHaveBeenCalled();
        expect(repository.listPublicAccounts()[0].displayName).toBe('Keep Name');
    });

    test('refuses to update a legacy document before migration', () => {
        fs.writeFileSync(
            accountsPath,
            JSON.stringify([
                { accountId: 'character-1', sessionId: 'legacy-session' }
            ])
        );
        const before = fs.readFileSync(accountsPath, 'utf8');
        const repository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log,
            secretStore: { reveal: jest.fn(), protect: jest.fn() }
        });

        expect(() =>
            repository.storeFetchedAccounts([], 'new-session', 'now')
        ).toThrow('Legacy accounts must be migrated before updating');
        expect(fs.readFileSync(accountsPath, 'utf8')).toBe(before);
    });
});
