const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../libs/oauth-jagex.js', () => ({
    startAuthFlow: jest.fn(),
    cancelAuthFlow: jest.fn(),
    writeAccountsToFile: jest.fn(),
    configureAccountRepository: jest.fn()
}));

test('migrates legacy accounts before configuring OAuth', async () => {
    const microbotDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'account-migration-startup-')
    );
    const accountRepository = {
        migrateLegacy: jest.fn(() => ({
            migrated: true,
            accounts: 2,
            sessions: 1
        }))
    };
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    try {
        await require('../libs/ipc-handlers')({
            ipcMain: { handle: jest.fn() },
            axios: {},
            microbotDir,
            packageJson: { version: '1.0.0-test' },
            path,
            log,
            dialog: {},
            fs,
            projectDir: path.join(__dirname, '..'),
            app: {},
            safeStorage: {
                isEncryptionAvailable: () => true,
                encryptString: jest.fn(),
                decryptString: jest.fn()
            },
            accountRepository
        });

        const oauth = require('../libs/oauth-jagex.js');
        expect(accountRepository.migrateLegacy).toHaveBeenCalledTimes(1);
        expect(oauth.configureAccountRepository).toHaveBeenCalledWith(
            accountRepository
        );
        expect(
            accountRepository.migrateLegacy.mock.invocationCallOrder[0]
        ).toBeLessThan(
            oauth.configureAccountRepository.mock.invocationCallOrder[0]
        );
        expect(log.info).toHaveBeenCalledWith(
            'Migrated 2 Jagex account(s) into 1 protected session(s).'
        );
    } finally {
        fs.rmSync(microbotDir, { recursive: true, force: true });
    }
});
