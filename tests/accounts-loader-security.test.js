const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountRepository } = require('../libs/account-repository');

describe('accounts IPC boundary', () => {
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-ipc-'));
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('read-accounts returns a public DTO without the Jagex session', async () => {
        fs.writeFileSync(
            path.join(directory, 'accounts.json'),
            JSON.stringify([
                {
                    accountId: 'fake-account',
                    displayName: 'Fake Character',
                    userHash: 'fake-user-hash',
                    sessionId: 'fake-session-secret',
                    profile: 'default'
                }
            ])
        );
        const handlers = {};
        const log = { info: jest.fn(), error: jest.fn() };
        const accountRepository = new AccountRepository({
            fs,
            path,
            microbotDir: directory,
            log
        });

        await require('../libs/accounts-loader')({
            fs,
            path,
            microbotDir: directory,
            log,
            accountRepository,
            ipcMain: {
                handle: (channel, handler) => {
                    handlers[channel] = handler;
                }
            }
        });

        const accounts = await handlers['read-accounts']();

        expect(accounts).toEqual([
            {
                accountId: 'fake-account',
                displayName: 'Fake Character',
                profile: 'default'
            }
        ]);
        expect(JSON.stringify(accounts)).not.toContain('fake-session-secret');
        expect(JSON.stringify(accounts)).not.toContain('fake-user-hash');
    });
});
