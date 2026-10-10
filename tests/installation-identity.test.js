const fs = require('fs');
const os = require('os');
const path = require('path');
const { InstallationIdentity } = require('../libs/installation-identity');

describe('installation identity', () => {
    test('creates one random identity and reuses it across instances', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installation-id-'));
        try {
            const first = new InstallationIdentity({ fs, path, productDataDir: directory });
            const firstId = first.getOrCreate();
            const second = new InstallationIdentity({ fs, path, productDataDir: directory });

            expect(second.getOrCreate()).toBe(firstId);
            expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('rejects a corrupted identity instead of silently replacing it', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installation-id-'));
        try {
            fs.writeFileSync(
                path.join(directory, 'installation.json'),
                JSON.stringify({ version: 1, installationId: 'invalid' })
            );
            const identity = new InstallationIdentity({ fs, path, productDataDir: directory });
            expect(() => identity.getOrCreate()).toThrow('invalid installation identity');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
