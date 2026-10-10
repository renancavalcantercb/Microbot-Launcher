const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    generateReleaseSigningKey
} = require('../scripts/generate-release-signing-key');

describe('release signing key generation', () => {
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-release-key-'));
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('writes separate private and public key files', () => {
        const privateKeyPath = path.join(directory, 'private.pem');
        const publicKeyPath = path.join(directory, 'public.json');
        generateReleaseSigningKey({
            keyId: 'release-staging-2026-01',
            privateKeyPath,
            publicKeyPath
        });

        expect(fs.readFileSync(privateKeyPath, 'utf8')).toContain('PRIVATE KEY');
        expect(JSON.parse(fs.readFileSync(publicKeyPath, 'utf8'))).toMatchObject({
            keyId: 'release-staging-2026-01',
            algorithm: 'RS256'
        });
        expect(fs.readFileSync(publicKeyPath, 'utf8')).not.toContain('PRIVATE KEY');
    });

    test('refuses to overwrite either output', () => {
        const privateKeyPath = path.join(directory, 'private.pem');
        const publicKeyPath = path.join(directory, 'public.json');
        fs.writeFileSync(privateKeyPath, 'existing');

        expect(() =>
            generateReleaseSigningKey({
                keyId: 'release-staging-2026-01',
                privateKeyPath,
                publicKeyPath
            })
        ).toThrow('refusing to overwrite');
        expect(fs.readFileSync(privateKeyPath, 'utf8')).toBe('existing');
        expect(fs.existsSync(publicKeyPath)).toBe(false);
    });
});
