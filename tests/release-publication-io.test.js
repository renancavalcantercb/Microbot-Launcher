const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const io = require('../libs/release-publication-io');
const clientCli = require('../scripts/publish-client-release');

describe('release publication I/O', () => {
    let directory;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-release-io-'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function writeConfiguration(overrides = {}) {
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        fs.writeFileSync(path.join(directory, 'staging.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
        fs.writeFileSync(path.join(directory, 'staging.public.json'), JSON.stringify({
            keyId: 'release-staging-test',
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        }));
        const configPath = path.join(directory, 'release-publication.staging.json');
        fs.writeFileSync(configPath, JSON.stringify({
            channel: 'staging',
            bucket: 'bucket-staging',
            publicBaseUrl: 'https://cut-staging.example/api/v1/',
            manifestUrl: 'https://cut-staging.example/api/v1/releases/staging/manifest',
            keyId: 'release-staging-test',
            privateKeyFile: 'staging.pem',
            publicKeyFile: 'staging.public.json',
            minimumLauncherVersion: '3.2.10',
            clientRepository: 'client',
            backendRepository: 'backend',
            gradleUserHome: 'gradle',
            sourceJar: 'source.jar',
            ...overrides
        }));
        return configPath;
    }

    describe('loadConfiguration', () => {
        test('resolves paths next to the configuration and reads the public key', () => {
            const config = io.loadConfiguration(writeConfiguration());
            expect(config.channel).toBe('staging');
            expect(config.privateKeyPath).toBe(path.join(directory, 'staging.pem'));
            expect(config.backendRepository).toBe(path.join(directory, 'backend'));
            expect(typeof config.publicKey).toBe('string');
        });

        test('refuses a public key whose ID is not the configured one', () => {
            const configPath = writeConfiguration({ keyId: 'another-key' });
            expect(() => io.loadConfiguration(configPath)).toThrow('publication and public key IDs do not match');
        });
    });

    describe('tracked configurations', () => {
        test.each(['staging', 'production'])('%s sets the launcher minimum apart from the client minimum', (name) => {
            const config = io.loadConfiguration(path.join(io.launcherRoot, 'config', `release-publication.${name}.json`));
            expect(config.channel).toBe(name);
            expect(config.minimumSupportedLauncherVersion).toBe('3.2.11');
            expect(config.minimumLauncherVersion).toBe('3.2.10');
        });
    });

    describe('publication lock', () => {
        const lockFile = () => path.join(directory, 'staging.publish.lock');
        const writeLock = (record) => fs.writeFileSync(lockFile(), JSON.stringify(record));

        test('is exclusive per channel and released once', () => {
            const release = io.acquirePublicationLock(directory, 'staging', 'launcher stage 3.2.11');
            expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8'))).toMatchObject({ pid: process.pid, command: 'launcher stage 3.2.11' });
            expect(() => io.acquirePublicationLock(directory, 'staging', 'client stage x')).toThrow(/launcher stage 3.2.11/);
            const production = io.acquirePublicationLock(directory, 'production', 'client stage x');
            production();
            release();
            release();
            expect(fs.existsSync(lockFile())).toBe(false);
            io.acquirePublicationLock(directory, 'staging', 'again')();
        });

        test('clears a lock whose process is gone on this machine', () => {
            writeLock({ pid: 2147483000, host: os.hostname(), command: 'old', startedAt: 'x' });
            const release = io.acquirePublicationLock(directory, 'staging', 'new');
            expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).command).toBe('new');
            release();
        });

        test('never clears a lock held by a live process or by another machine', () => {
            writeLock({ pid: process.pid, host: os.hostname(), command: 'live', startedAt: 'x' });
            expect(() => io.acquirePublicationLock(directory, 'staging', 'new')).toThrow(/live/);
            writeLock({ pid: 1, host: 'elsewhere', command: 'remote', startedAt: 'x' });
            expect(() => io.acquirePublicationLock(directory, 'staging', 'new')).toThrow(/remote.*elsewhere|elsewhere.*remote/);
            fs.writeFileSync(lockFile(), 'not json');
            expect(() => io.acquirePublicationLock(directory, 'staging', 'new')).toThrow(/unreadable lock file/);
            expect(fs.existsSync(lockFile())).toBe(true);
        });
    });

    describe('the client CLI shares the lock', () => {
        test('stage and promote are refused while another publication holds the channel', async () => {
            const configPath = writeConfiguration();
            const original = { ...clientCli.deps };
            clientCli.deps.workRoot = path.join(directory, 'work');
            fs.mkdirSync(clientCli.deps.workRoot, { recursive: true });
            fs.writeFileSync(path.join(clientCli.deps.workRoot, 'staging.publish.lock'), JSON.stringify({
                pid: process.pid, host: os.hostname(), command: 'launcher promote 3.2.11', startedAt: 'x'
            }));
            try {
                for (const extra of [['stage'], ['promote', '--confirm-promote']]) {
                    await expect(clientCli.main([...extra, '--version', 'cut-2.6.31', '--sequence', '5', '--config', configPath]))
                        .rejects.toThrow(/another publication holds the staging lock.*launcher promote/);
                }
            } finally {
                Object.assign(clientCli.deps, original);
            }
        });
    });
});
