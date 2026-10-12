const childProcess = require('child_process');
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

    describe('wrangler wrapper', () => {
        const config = () => ({ bucket: 'bucket-staging', backendRepository: path.join(directory, 'backend') });
        const installWrangler = () => {
            fs.mkdirSync(path.join(directory, 'backend', 'node_modules', 'wrangler', 'bin'), { recursive: true });
            fs.writeFileSync(path.join(directory, 'backend', 'node_modules', 'wrangler', 'bin', 'wrangler.js'), '');
        };

        test('explains how to fix a missing wrangler installation', () => {
            expect(() => io.r2Get(config(), 'k', path.join(directory, 'out'))).toThrow(/Wrangler is not installed/);
        });

        test('reads objects remotely and reports a missing key only when asked to tolerate it', () => {
            installWrangler();
            const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
                status: 1, stdout: '', stderr: 'The specified key does not exist. (10007)'
            });
            const destination = path.join(directory, 'out');
            fs.writeFileSync(destination, 'stale');
            expect(io.r2Get(config(), 'releases/x', destination, { allowMissing: true })).toBe(false);
            expect(fs.existsSync(destination)).toBe(false);
            expect(spawn.mock.calls[0][1].slice(1)).toEqual([
                'r2', 'object', 'get', 'bucket-staging/releases/x', '--remote', '--file', destination
            ]);
            expect(() => io.r2Get(config(), 'releases/x', destination)).toThrow(/Wrangler failed/);
        });

        test('does not hide other failures behind allowMissing', () => {
            installWrangler();
            jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: 'Authentication error [code: 10000]' });
            expect(() => io.r2Get(config(), 'k', path.join(directory, 'out'), { allowMissing: true })).toThrow(/Authentication error/);
        });

        test('uploads remotely with the content type, and never relies on --force for immutability', () => {
            installWrangler();
            const spawn = jest.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 0, stdout: '', stderr: '' });
            io.r2Put(config(), 'releases/x', 'file.bin', 'application/json');
            expect(spawn.mock.calls[0][1].slice(1)).toEqual([
                'r2', 'object', 'put', 'bucket-staging/releases/x', '--remote',
                '--file', 'file.bin', '--content-type', 'application/json', '--force'
            ]);
        });

        test('wrangler uploads are limited to 300 MiB', () => {
            expect(io.MAX_WRANGLER_UPLOAD_BYTES).toBe(300 * 1024 * 1024);
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
                for (const command of ['stage', 'promote']) {
                    await expect(clientCli.main([command, '--version', 'cut-2.6.31', '--sequence', '5', '--config', configPath, '--confirm-promote']))
                        .rejects.toThrow(/another publication holds the staging lock.*launcher promote/);
                }
            } finally {
                Object.assign(clientCli.deps, original);
            }
        });
    });
});
