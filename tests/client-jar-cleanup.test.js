const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

jest.mock('../libs/oauth-jagex.js', () => ({
    startAuthFlow: jest.fn(),
    writeAccountsToFile: jest.fn()
}));

const DAY = 24 * 60 * 60 * 1000;

describe('client jar cleanup and listing with an isolated home', () => {
    let homeDir;
    let microbotDir;
    let dirModule;

    function touch(name) {
        fs.writeFileSync(path.join(microbotDir, name), 'jar');
    }

    function exists(name) {
        return fs.existsSync(path.join(microbotDir, name));
    }

    function writeTtl(data) {
        fs.writeFileSync(
            path.join(microbotDir, 'clients_jar_ttl.json'),
            JSON.stringify(data)
        );
    }

    function readTtl() {
        return JSON.parse(
            fs.readFileSync(path.join(microbotDir, 'clients_jar_ttl.json'), 'utf8')
        );
    }

    function writeDownloaded(versions) {
        fs.writeFileSync(
            path.join(microbotDir, 'downloaded_clients.json'),
            JSON.stringify(versions)
        );
    }

    function readDownloaded() {
        return JSON.parse(
            fs.readFileSync(path.join(microbotDir, 'downloaded_clients.json'), 'utf8')
        );
    }

    beforeEach(() => {
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-home-'));
        microbotDir = path.join(homeDir, '.microbot-cut');
        fs.mkdirSync(microbotDir);
        jest.resetModules();
        jest.doMock('os', () => ({
            ...jest.requireActual('os'),
            homedir: () => homeDir
        }));
        dirModule = require('../libs/dir-module.js');
        if (dirModule.microbotDir !== microbotDir) {
            throw new Error('dir-module is not using the isolated home');
        }
    });

    afterEach(() => {
        jest.dontMock('os');
        fs.rmSync(homeDir, { recursive: true, force: true });
    });

    test('uses the isolated home directory', () => {
        expect(dirModule.microbotDir).toBe(microbotDir);
    });

    test('keeps stale jars the user placed manually', async () => {
        touch('microbot-2.6.28.jar');
        touch('microbot-2.6.22.jar');
        touch('microbot-2.6.28-dev.jar');
        const stale = Date.now() - 10 * DAY;
        writeTtl({ '2.6.28': stale, '2.6.22': stale, '2.6.28-dev': stale });

        const result = await dirModule.cleanupUnusedClientsJar('2.6.28');

        expect(result).toEqual({ success: true });
        expect(exists('microbot-2.6.22.jar')).toBe(true);
        expect(exists('microbot-2.6.28-dev.jar')).toBe(true);
        expect(exists('microbot-2.6.28.jar')).toBe(true);
    });

    test('still removes stale jars the launcher downloaded, except the latest', async () => {
        touch('microbot-2.6.28.jar');
        touch('microbot-2.6.27.jar');
        touch('microbot-2.6.26.jar');
        const stale = Date.now() - 10 * DAY;
        const fresh = Date.now() - DAY;
        writeTtl({ '2.6.28': stale, '2.6.27': stale, '2.6.26': fresh });
        writeDownloaded(['2.6.26', '2.6.27', '2.6.28']);

        const result = await dirModule.cleanupUnusedClientsJar('2.6.28');

        expect(result).toEqual({ success: true });
        expect(exists('microbot-2.6.28.jar')).toBe(true);
        expect(exists('microbot-2.6.27.jar')).toBe(false);
        expect(exists('microbot-2.6.26.jar')).toBe(true);
        expect(Object.keys(readTtl()).sort()).toEqual(['2.6.26', '2.6.28']);
        expect(readDownloaded()).toEqual(['2.6.26', '2.6.28']);
    });

    test('starts tracking newly placed custom jars without deleting them', async () => {
        touch('microbot-my build.jar');
        touch('microbot-launcher.jar');

        const result = await dirModule.cleanupUnusedClientsJar('2.6.28');

        expect(result).toEqual({ success: true });
        expect(Object.keys(readTtl())).toEqual(['my build']);
        expect(exists('microbot-launcher.jar')).toBe(true);
    });

    test('updates TTL for custom jar names with spaces', async () => {
        touch('microbot-2.6.28 (1).jar');

        const result = await dirModule.updateClientJarTTL('2.6.28 (1)');

        expect(result).toEqual({ success: true });
        expect(Object.keys(readTtl())).toEqual(['2.6.28 (1)']);
        expect(await dirModule.updateClientJarTTL('../x')).toEqual({
            success: false,
            error: 'Invalid version format'
        });
    });

    describe('IPC handlers', () => {
        let handlers;
        let axios;

        beforeEach(async () => {
            handlers = {};
            axios = jest.fn().mockResolvedValue({ data: Buffer.from('jar') });
            const ipcHandlers = require('../libs/ipc-handlers.js');
            await ipcHandlers({
                ipcMain: {
                    handle: (channel, fn) => {
                        handlers[channel] = fn;
                    }
                },
                axios,
                microbotDir,
                packageJson: { version: '1.0.0' },
                path,
                log: { info: jest.fn(), error: jest.fn() },
                dialog: {},
                fs,
                projectDir: path.join(__dirname, '..'),
                app: {},
                productConfig: {
                    ...require('../product-config'),
                    updateApiBase: 'https://microbot.test',
                    updateFilesBase: 'https://files.microbot.test'
                }
            });
        });

        test('list-jars and list-client-jars include older and custom jars', async () => {
            touch('microbot-2.6.28.jar');
            touch('microbot-2.6.22.jar');
            touch('microbot-custom.jar');
            touch('microbot-launcher.jar');

            expect(await handlers['list-jars']()).toEqual([
                'microbot-2.6.28.jar',
                'microbot-2.6.22.jar',
                'microbot-custom.jar'
            ]);
            expect(
                (await handlers['list-client-jars']({}, '2.6.28')).map((j) => j.label)
            ).toEqual(['2.6.28 (latest)', '2.6.22 (older)', 'custom (custom)']);
            expect(await handlers['client-exists']({}, 'custom')).toBe(true);
        });

        test('download-client records the version as launcher-managed', async () => {
            const sender = { send: jest.fn() };

            const result = await handlers['download-client']({ sender }, '2.6.28');

            expect(result.success).toBe(true);
            expect(exists('microbot-2.6.28.jar')).toBe(true);
            expect(readDownloaded()).toEqual(['2.6.28']);
        });

        test('rejects unsafe versions before touching the file system', async () => {
            const sender = { send: jest.fn() };
            const unsafe = ['../../escape', 'a/b', 'a\\b', '', null, 42];

            for (const version of unsafe) {
                expect(await handlers['download-client']({ sender }, version)).toEqual({
                    error: `Invalid client version: ${JSON.stringify(String(version))}`
                });
                expect(await handlers['client-exists']({}, version)).toEqual({
                    error: `Invalid client version: ${JSON.stringify(String(version))}`
                });
                expect((await handlers['open-client']({}, version, {}, {}, '1g')).error).toMatch(/^Invalid client version/);
                expect((await handlers['play-no-jagex-account']({}, version, {}, '1g')).error).toMatch(/^Invalid client version/);
            }
            expect(axios).not.toHaveBeenCalled();
            expect(fs.existsSync(path.join(homeDir, 'escape.jar'))).toBe(false);
        });

        test('keeps registering other jar-executor handlers unchanged', () => {
            expect(typeof handlers['open-client']).toBe('function');
            expect(typeof handlers['play-no-jagex-account']).toBe('function');
        });

        test('download-client does not claim a jar that already exists', async () => {
            touch('microbot-2.6.22.jar');
            const sender = { send: jest.fn() };

            const result = await handlers['download-client']({ sender }, '2.6.22');

            expect(result.success).toBe(true);
            expect(axios).not.toHaveBeenCalled();
            expect(exists('downloaded_clients.json')).toBe(false);
        });

        async function signedReleaseHandlers({
            downloadedArtifact,
            signedArtifact,
            minimumLauncherVersion = '3.2.10',
            launcherVersion = '3.2.10',
            authorizeReleaseChannel = jest.fn().mockResolvedValue({
                releaseCohort: 'beta',
                allowedReleaseChannels: ['production', 'staging']
            })
        }) {
            const releaseHandlers = {};
            const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
            const version = 'cut-2.6.31-p1';
            const payload = {
                schemaVersion: 1,
                channel: 'staging',
                sequence: 1,
                publishedAt: '2026-10-10T00:00:00.000Z',
                launcher: {
                    version: '3.2.11',
                    minimumSupportedVersion: '3.2.10',
                    platforms: {
                        'windows-x64': {
                            artifactPath: 'releases/artifacts/launcher/setup.exe',
                            updaterMetadataPath: 'releases/artifacts/launcher/latest.yml',
                            size: 123,
                            sha256: 'a'.repeat(64)
                        }
                    }
                },
                client: {
                    version,
                    minimumLauncherVersion,
                    artifactPath: `releases/artifacts/client/${version}/client.jar`,
                    size: signedArtifact.length,
                    sha256: crypto.createHash('sha256').update(signedArtifact).digest('hex')
                }
            };
            const envelope = require('../libs/release-manifest-signing')
                .signReleaseManifest(payload, {
                    keyId: 'release-staging-test',
                    privateKeyPem: keys.privateKey.export({
                        type: 'pkcs8',
                        format: 'pem'
                    })
                });
            const releaseAxios = jest.fn().mockResolvedValue({
                data: Readable.from(
                    Array.isArray(downloadedArtifact) ? downloadedArtifact : [downloadedArtifact]
                )
            });
            releaseAxios.get = jest.fn().mockResolvedValue({ data: envelope });
            const ipcHandlers = require('../libs/ipc-handlers.js');
            await ipcHandlers({
                ipcMain: {
                    handle: (channel, fn) => {
                        releaseHandlers[channel] = fn;
                    }
                },
                axios: releaseAxios,
                microbotDir,
                productDataDir: microbotDir,
                packageJson: { version: launcherVersion },
                path,
                log: { info: jest.fn(), error: jest.fn() },
                dialog: {},
                fs,
                projectDir: path.join(__dirname, '..'),
                app: {},
                environment: {},
                authorizeReleaseChannel,
                productConfig: {
                    ...require('../product-config'),
                    updateApiBase: null,
                    updateFilesBase: null,
                    releaseUpdates: {
                        enabled: true,
                        channel: 'staging',
                        manifestUrl: 'https://cut.example/releases/staging/manifest.json',
                        artifactBaseUrl: 'https://cut.example/',
                        publicKey: keys.publicKey
                            .export({ type: 'spki', format: 'der' })
                            .toString('base64'),
                        publicKeyId: 'release-staging-test'
                    }
                }
            });
            return { releaseHandlers, releaseAxios, payload, version };
        }

        test('uses the signed release for version discovery and verified download', async () => {
            const artifact = Buffer.from('signed-client-jar');
            const { releaseHandlers, releaseAxios, version } =
                await signedReleaseHandlers({
                    downloadedArtifact: artifact,
                    signedArtifact: artifact
                });
            const sender = { send: jest.fn() };

            await expect(releaseHandlers['fetch-launcher-version']()).resolves.toBe('3.2.11');
            await expect(releaseHandlers['fetch-client-version']()).resolves.toBe(version);
            await expect(
                releaseHandlers['download-client']({ sender }, version)
            ).resolves.toMatchObject({ success: true, verified: true });

            expect(fs.readFileSync(path.join(microbotDir, `microbot-${version}.jar`)))
                .toEqual(artifact);
            expect(readDownloaded()).toEqual([version]);
            expect(releaseAxios.get).toHaveBeenCalledTimes(3);
            expect(releaseAxios).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: `https://cut.example/releases/artifacts/client/${version}/client.jar`,
                    responseType: 'stream'
                })
            );
        });

        test('refuses a signed client that needs a newer launcher, before downloading it', async () => {
            const artifact = Buffer.from('signed-client-jar');
            const { releaseHandlers, releaseAxios, version } = await signedReleaseHandlers({
                downloadedArtifact: artifact,
                signedArtifact: artifact,
                minimumLauncherVersion: '3.2.13',
                launcherVersion: '3.2.12'
            });
            const sender = { send: jest.fn() };

            const result = await releaseHandlers['download-client']({ sender }, version);

            expect(result.error).toContain('needs Microbot Cut Launcher 3.2.13 or newer');
            expect(result.error).toContain('3.2.12');
            expect(releaseAxios).not.toHaveBeenCalled();
            expect(fs.existsSync(path.join(microbotDir, `microbot-${version}.jar`))).toBe(false);
            expect(exists('downloaded_clients.json')).toBe(false);
        });

        test.each([
            ['the same version', '3.2.12', '3.2.12'],
            ['an older minimum (3.2.11 manifests keep working)', '3.2.10', '3.2.12'],
            ['a minimum equal to the previous launcher', '3.2.11', '3.2.12']
        ])('downloads when the client needs %s', async (_label, minimum, launcher) => {
            const artifact = Buffer.from('signed-client-jar');
            const { releaseHandlers, version } = await signedReleaseHandlers({
                downloadedArtifact: artifact,
                signedArtifact: artifact,
                minimumLauncherVersion: minimum,
                launcherVersion: launcher
            });
            await expect(
                releaseHandlers['download-client']({ sender: { send: jest.fn() } }, version)
            ).resolves.toMatchObject({ success: true, verified: true });
        });

        test('limits renderer progress updates while streaming a signed client', async () => {
            const artifact = Buffer.alloc(1000, 7);
            const chunks = Array.from(artifact, (byte) => Buffer.from([byte]));
            const { releaseHandlers, version } = await signedReleaseHandlers({
                downloadedArtifact: chunks,
                signedArtifact: artifact
            });
            const sender = { send: jest.fn() };

            await expect(
                releaseHandlers['download-client']({ sender }, version)
            ).resolves.toMatchObject({ success: true, verified: true });

            expect(sender.send.mock.calls.length).toBeLessThanOrEqual(103);
            expect(sender.send).toHaveBeenLastCalledWith('progress', {
                percent: 100,
                status: 'Verified download completed!'
            });
        });

        test('reports release channel denial instead of treating a local client as missing', async () => {
            const denial = 'Your stable release cohort cannot access the staging channel';
            const artifact = Buffer.from('signed-client-jar');
            const { releaseHandlers, version } = await signedReleaseHandlers({
                downloadedArtifact: artifact,
                signedArtifact: artifact,
                authorizeReleaseChannel: jest.fn().mockRejectedValue(new Error(denial))
            });
            fs.writeFileSync(path.join(microbotDir, `microbot-${version}.jar`), artifact);

            await expect(releaseHandlers['client-exists']({}, version)).resolves.toEqual({
                error: denial
            });
        });

        test('rejects corrupt bytes from the signed client download', async () => {
            const { releaseHandlers, version } = await signedReleaseHandlers({
                downloadedArtifact: Buffer.from('mismatch-client-jar'),
                signedArtifact: Buffer.from('expected-client-jar')
            });

            const result = await releaseHandlers['download-client'](
                { sender: { send: jest.fn() } },
                version
            );

            expect(result.error).toMatch(/SHA-256/);
            expect(exists(`microbot-${version}.jar`)).toBe(false);
            expect(fs.readdirSync(microbotDir).some((name) => name.endsWith('.part')))
                .toBe(false);
        });

        test('blocks a signed client that is modified after installation', async () => {
            const artifact = Buffer.from('signed-client-jar');
            const { releaseHandlers, version } = await signedReleaseHandlers({
                downloadedArtifact: artifact,
                signedArtifact: artifact
            });
            await releaseHandlers['download-client'](
                { sender: { send: jest.fn() } },
                version
            );
            fs.writeFileSync(
                path.join(microbotDir, `microbot-${version}.jar`),
                Buffer.from('tampered-client-jar')
            );

            await expect(releaseHandlers['client-exists']({}, version)).resolves.toEqual({
                error: `client ${version} failed local integrity verification; reinstall this release`
            });
            await expect(
                releaseHandlers['open-client']({}, version, {}, null, '1g')
            ).resolves.toEqual({
                error: `client ${version} failed local integrity verification; reinstall this release`
            });
        });

        test('selects the signed release channel returned by the server cohort', async () => {
            const releaseHandlers = {};
            const signing = require('../libs/release-manifest-signing');
            const channels = {};
            const envelopes = {};
            for (const channel of ['staging', 'production']) {
                const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
                const keyId = `release-${channel}-test`;
                const version = channel === 'staging'
                    ? 'cut-2.6.31-p1'
                    : 'cut-2.6.30';
                channels[channel] = {
                    manifestUrl: `https://cut-${channel}.example/api/v1/releases/${channel}/manifest`,
                    artifactBaseUrl: `https://cut-${channel}.example/api/v1/`,
                    publicKey: keys.publicKey
                        .export({ type: 'spki', format: 'der' })
                        .toString('base64'),
                    publicKeyId: keyId
                };
                envelopes[channel] = signing.signReleaseManifest({
                    schemaVersion: 1,
                    channel,
                    sequence: 1,
                    publishedAt: '2026-10-11T00:00:00.000Z',
                    launcher: null,
                    client: {
                        version,
                        minimumLauncherVersion: '3.2.10',
                        artifactPath: `releases/artifacts/client/${version}/client.jar`,
                        size: 10,
                        sha256: 'a'.repeat(64)
                    }
                }, {
                    keyId,
                    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
                });
            }
            const releaseAxios = { get: jest.fn(async (url) => ({
                data: url.includes('/production/')
                    ? envelopes.production
                    : envelopes.staging
            })) };
            let access = {
                authenticated: true,
                releaseCohort: 'stable',
                allowedReleaseChannels: ['production'],
                selectedReleaseChannel: 'production'
            };
            const ipcHandlers = require('../libs/ipc-handlers.js');
            await ipcHandlers({
                ipcMain: { handle: (channel, fn) => (releaseHandlers[channel] = fn) },
                axios: releaseAxios,
                microbotDir,
                productDataDir: microbotDir,
                packageJson: { version: '3.2.10' },
                path,
                log: { info: jest.fn(), error: jest.fn() },
                dialog: {},
                fs,
                projectDir: path.join(__dirname, '..'),
                app: {},
                environment: {},
                releaseAccessStatus: async () => access,
                productConfig: {
                    ...require('../product-config'),
                    releaseUpdates: {
                        enabled: true,
                        defaultChannel: 'staging',
                        channels
                    }
                }
            });

            await expect(releaseHandlers['fetch-client-version']()).resolves.toBe('cut-2.6.30');
            expect(await releaseHandlers['client-release:status']()).toMatchObject({
                channel: 'production'
            });

            access = {
                authenticated: true,
                releaseCohort: 'beta',
                allowedReleaseChannels: ['production', 'staging'],
                selectedReleaseChannel: 'staging'
            };
            await expect(releaseHandlers['fetch-client-version']()).resolves.toBe('cut-2.6.31-p1');
            expect(await releaseHandlers['client-release:status']()).toMatchObject({
                channel: 'staging'
            });
        });

        test('uses local versions and disables downloads without product endpoints', async () => {
            const offlineHandlers = {};
            const offlineAxios = jest.fn();
            offlineAxios.get = jest.fn();
            const ipcHandlers = require('../libs/ipc-handlers.js');
            await ipcHandlers({
                ipcMain: {
                    handle: (channel, fn) => {
                        offlineHandlers[channel] = fn;
                    }
                },
                axios: offlineAxios,
                microbotDir,
                packageJson: { version: '1.0.0' },
                path,
                log: { info: jest.fn(), error: jest.fn() },
                dialog: {},
                fs,
                projectDir: path.join(__dirname, '..'),
                app: {},
                productConfig: require('../product-config')
            });

            expect(await offlineHandlers['fetch-launcher-version']()).toBe('1.0.0');
            expect(await offlineHandlers['fetch-client-version']()).toBe('2.6.30');
            expect(
                await offlineHandlers['download-client'](
                    { sender: { send: jest.fn() } },
                    '2.6.29'
                )
            ).toEqual({
                error:
                    'Client downloads are disabled until a product update endpoint is configured'
            });
            expect(offlineAxios).not.toHaveBeenCalled();
            expect(offlineAxios.get).not.toHaveBeenCalled();
        });
    });
});
