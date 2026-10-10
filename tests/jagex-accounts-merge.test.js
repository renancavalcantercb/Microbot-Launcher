const fs = require('fs');
const path = require('path');
const os = require('os');

const fixturePath = path.join(
    __dirname,
    '__fixtures__',
    'jagex-accounts-unnamed.json'
);

describe('writeAccountsToFile', () => {
    let tempHome;
    let originalHome;
    let originalUserProfile;
    let writeAccountsToFile;
    let configureAccountRepository;
    let axiosGet;
    let accountRepository;

    beforeEach(() => {
        tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mbtest-home-'));
        originalHome = process.env.HOME;
        originalUserProfile = process.env.USERPROFILE;
        process.env.HOME = tempHome;
        process.env.USERPROFILE = tempHome;
        fs.mkdirSync(path.join(tempHome, '.microbot'));
        fs.copyFileSync(
            fixturePath,
            path.join(tempHome, '.microbot', 'accounts.json')
        );
        axiosGet = jest.fn();
        jest.isolateModules(() => {
            jest.doMock('patchright', () => ({ chromium: {} }));
            jest.doMock('axios', () => ({ get: axiosGet, post: jest.fn() }));
            jest.doMock('electron-log', () => ({
                info: jest.fn(),
                error: jest.fn()
            }));
            ({
                writeAccountsToFile,
                configureAccountRepository
            } = require('../libs/oauth-jagex.js'));
        });
        accountRepository = { storeFetchedAccounts: jest.fn() };
        configureAccountRepository(accountRepository);
    });

    afterEach(() => {
        process.env.HOME = originalHome;
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
        fs.rmSync(tempHome, { recursive: true, force: true });
    });

    test('re-login writes names of already stored characters', async () => {
        axiosGet.mockResolvedValue({
            data: [
                { accountId: 'fake-char-1', displayName: 'FakeOne', userHash: 'fake-hash-a' },
                { accountId: 'fake-char-2', displayName: 'FakeTwo', userHash: 'fake-hash-a' }
            ]
        });

        accountRepository.storeFetchedAccounts.mockReturnValue({
            added: 0,
            updated: 2
        });

        const status = await writeAccountsToFile('fake-session-new');

        expect(status).toEqual({ ok: true, added: 0, updated: 2 });

        expect(axiosGet).toHaveBeenCalledWith(
            'https://auth.jagex.com/game-session/v1/accounts',
            { headers: { Authorization: 'Bearer fake-session-new' } }
        );
        expect(accountRepository.storeFetchedAccounts).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ accountId: 'fake-char-1' }),
                expect.objectContaining({ accountId: 'fake-char-2' })
            ]),
            'fake-session-new',
            expect.any(String)
        );
    });

    test('reports a failed session and leaves the file untouched', async () => {
        const accountsFile = path.join(tempHome, '.microbot', 'accounts.json');
        const before = fs.readFileSync(accountsFile, 'utf8');
        const error = new Error('Request failed with status code 401');
        error.response = { status: 401, data: {} };
        axiosGet.mockRejectedValue(error);

        const status = await writeAccountsToFile('fake-session-expired');

        expect(status).toMatchObject({ ok: false, status: 401 });
        expect(fs.readFileSync(accountsFile, 'utf8')).toBe(before);
    });

    test('reports a repository failure without writing files directly', async () => {
        const accountsFile = path.join(tempHome, '.microbot', 'accounts.json');
        fs.writeFileSync(accountsFile, '{ not json');
        const before = fs.readFileSync(accountsFile, 'utf8');
        axiosGet.mockResolvedValue({
            data: [{ accountId: 'fake-char-1', displayName: 'FakeOne' }]
        });
        accountRepository.storeFetchedAccounts.mockImplementation(() => {
            throw new Error('Unsupported or corrupted accounts file');
        });

        const status = await writeAccountsToFile('fake-session-new');

        expect(status.ok).toBe(false);
        expect(fs.readFileSync(accountsFile, 'utf8')).toBe(before);
        expect(
            fs.readdirSync(path.join(tempHome, '.microbot')).filter((f) =>
                f.endsWith('.tmp')
            )
        ).toEqual([]);
    });
});
