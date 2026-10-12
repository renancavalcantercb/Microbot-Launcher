const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const crypto = require('crypto');

function userHome() {
    try {
        return os.userInfo().homedir;
    } catch (_) {
        return os.homedir();
    }
}

const JDKS = {
    8: process.env.M07_JAVA8_HOME,
    11: process.env.M07_JAVA11_HOME || path.join(userHome(), '.jdks', 'temurin-11.0.28'),
    17: process.env.M07_JAVA17_HOME || '/usr/lib/jvm/java-17-openjdk-amd64'
};
const hasJdk = (major) => Boolean(JDKS[major]) && fs.existsSync(path.join(JDKS[major], 'bin', 'java'));
const withJdk = (major) => (hasJdk(major) ? test : test.skip);
const VERSION = '9.9.9';
const HOMES = [...new Set([os.homedir(), userHome()])];

let workDir;
let microbotDir;
let originalPath;
let originalMode;
let originalPluginDevelopmentMode;
let originalPluginRepositoryEnvironment;
const PLUGIN_REPOSITORY_ENVIRONMENT_VARIABLES = [
    'MICROBOT_CUT_PLUGIN_DEV_ARTIFACT',
    'MICROBOT_CUT_PLUGIN_DEV_ARTIFACT_NAME',
    'MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED',
    'MICROBOT_CUT_PLUGIN_MANIFEST_URL',
    'MICROBOT_CUT_PLUGIN_RELEASES_URL',
    'MICROBOT_CUT_PLUGIN_RELEASES_API_URL',
    'MICROBOT_CUT_PLUGIN_PUBLIC_KEY',
    'MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID'
];

function buildTestJar() {
    const javac = path.join(JDKS[17], 'bin', 'javac');
    const jar = path.join(JDKS[17], 'bin', 'jar');
    const classes = path.join(workDir, 'classes');
    fs.mkdirSync(classes, { recursive: true });
    childProcess.execFileSync(javac, [
        '--release', '8', '-d', classes,
        path.join(__dirname, '__fixtures__', 'launch-jar', 'Main.java')
    ]);
    childProcess.execFileSync(jar, [
        '--create', '--file', path.join(microbotDir, `microbot-${VERSION}.jar`),
        '--main-class', 'Main', '-C', classes, '.'
    ]);
}

function createHarness({
    clipboard = true,
    response = 0,
    startupWindowMs = 2500
} = {}) {
    const handlers = {};
    const spawnCalls = [];
    const dialogs = [];
    let resolveDialog;
    const dialogShown = new Promise((resolve) => {
        resolveDialog = resolve;
    });
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const launchAccount = {
        accountId: 'test-account',
        displayName: 'Test Account',
        sessionId: 'abc123'
    };
    const deps = {
        spawn: (command, args, options) => {
            spawnCalls.push({ command, args, options });
            return childProcess.spawn(command, args, { ...options, env: { ...process.env } });
        },
        path,
        fs,
        log,
        microbotDir,
        accountRepository: {
            getAccountForLaunch: jest.fn((accountId) =>
                accountId === launchAccount.accountId
                    ? { ...launchAccount }
                    : null
            )
        },
        productSessionService: {
            createClientTicket: jest.fn().mockResolvedValue({
                ticket: 'header.payload.signature',
                apiBaseUrl: 'https://staging.example/api/v1',
                keyId: 'staging-2026-01',
                audience: 'microbot-cut-client'
            })
        },
        clientTicketBroker: {
            ensureStarted: jest.fn().mockResolvedValue(undefined),
            createGrant: jest.fn().mockResolvedValue({
                environment: {
                    MICROBOT_CUT_AUTH_BROKER_URL: 'http://127.0.0.1:43123/v1/client-ticket',
                    MICROBOT_CUT_AUTH_BROKER_CAPABILITY: 'test-child-capability',
                    MICROBOT_CUT_AUTH_BROKER_DISCOVERY_FILE: path.join(
                        microbotDir,
                        'client-ticket-broker.json'
                    )
                },
                secrets: ['test-child-capability'],
                release: jest.fn()
            })
        },
        startupWindowMs,
        packageJson: { version: '3.2.8-test' },
        ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
        shell: { openExternal: jest.fn() },
        clipboard: clipboard ? { writeText: jest.fn() } : undefined,
        dialog: {
            showMessageBox: jest.fn((options) => {
                dialogs.push(options);
                resolveDialog(options);
                return Promise.resolve({ response });
            }),
            showErrorBox: jest.fn()
        }
    };
    return {
        deps,
        handlers,
        spawnCalls,
        dialogs,
        dialogShown,
        log,
        launchAccount
    };
}

async function launch(harness, { ram = '', proxy = null, profile, displayName } = {}) {
    await require('../libs/jar-executor')(harness.deps);
    const accountId = profile || displayName ? harness.launchAccount.accountId : null;
    if (profile) harness.launchAccount.profile = profile;
    if (displayName) harness.launchAccount.displayName = displayName;
    return harness.handlers['open-client']({}, VERSION, proxy, accountId, ram);
}

function useJava(major) {
    process.env.PATH = `${path.join(JDKS[major], 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`;
}

const within = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm07-launch-'));
    microbotDir = path.join(workDir, '.microbot');
    fs.mkdirSync(microbotDir);
    if (hasJdk(17)) buildTestJar();
});

afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
    originalPath = process.env.PATH;
    originalMode = process.env.M07_MODE;
    originalPluginDevelopmentMode = process.env.MICROBOT_CUT_PLUGIN_DEV;
    originalPluginRepositoryEnvironment = Object.fromEntries(
        PLUGIN_REPOSITORY_ENVIRONMENT_VARIABLES.map((name) => [
            name,
            process.env[name]
        ])
    );
    delete process.env.MICROBOT_CUT_PLUGIN_DEV;
    for (const name of PLUGIN_REPOSITORY_ENVIRONMENT_VARIABLES) {
        delete process.env[name];
    }
    delete process.env.DEBUG;
    jest.resetModules();
});

afterEach(() => {
    process.env.PATH = originalPath;
    if (originalMode === undefined) delete process.env.M07_MODE;
    else process.env.M07_MODE = originalMode;
    if (originalPluginDevelopmentMode === undefined)
        delete process.env.MICROBOT_CUT_PLUGIN_DEV;
    else process.env.MICROBOT_CUT_PLUGIN_DEV = originalPluginDevelopmentMode;
    for (const [name, value] of Object.entries(
        originalPluginRepositoryEnvironment
    )) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('open-client launch diagnostics with real Java runtimes', () => {
    test('resolves the selected account in the main process by account id', async () => {
        const empty = path.join(workDir, 'account-id-empty-bin');
        fs.mkdirSync(empty, { recursive: true });
        process.env.PATH = empty;
        const harness = createHarness();

        expect(
            await launch(harness, {
                profile: 'MainAccount',
                displayName: 'Fake Character'
            })
        ).toEqual({ success: true });

        expect(
            harness.deps.accountRepository.getAccountForLaunch
        ).toHaveBeenCalledWith('test-account');
    });

    test('rejects account objects received over IPC', async () => {
        const harness = createHarness();
        await require('../libs/jar-executor')(harness.deps);

        const result = await harness.handlers['open-client'](
            {},
            VERSION,
            null,
            { accountId: 'test-account', sessionId: 'must-not-cross-ipc' },
            ''
        );

        expect(result).toEqual({ error: 'Selected account was not found' });
    });

    test('missing Java shows the download dialog and preserves the Temurin link', async () => {
        const empty = path.join(workDir, 'empty-bin');
        fs.mkdirSync(empty, { recursive: true });
        process.env.PATH = empty;
        const harness = createHarness({ response: 0 });
        expect(await launch(harness)).toEqual({ success: true });
        const shown = await within(harness.dialogShown, 5000);
        expect(shown).toMatchObject({ title: 'Java Not Found', buttons: ['Yes, Download JDK', 'Copy details', 'Cancel'] });
        expect(shown.detail).toContain('(missing-java)');
        await flush();
        expect(harness.deps.shell.openExternal).toHaveBeenCalledWith(
            require('../libs/java-runtime').javaDownloadUrl(process.platform, process.arch)
        );
        expect(harness.spawnCalls).toHaveLength(1);
    });

    withJdk(8)('Java 8 is rejected before launch as incompatible', async () => {
        useJava(8);
        const harness = createHarness({ response: 1 });
        await launch(harness);
        const shown = await within(harness.dialogShown, 10000);
        expect(shown.title).toBe('Incompatible Java');
        expect(shown.message).toContain('Java 8 is too old');
        expect(shown.detail).toMatch(/Runtime: Java 1\.8\.0_\d+ Temurin \(amd64, 64-bit\)/);
        await flush();
        expect(harness.deps.clipboard.writeText).toHaveBeenCalledWith(shown.detail);
        expect(harness.spawnCalls).toHaveLength(1);
    });

    withJdk(11)('Java 11 launches without ZGC flags from the probed runtime home', async () => {
        useJava(11);
        process.env.M07_MODE = 'sleep';
        const harness = createHarness();
        await launch(harness);
        const shown = await within(harness.dialogShown, 5000);
        expect(shown).toBeNull();
        const [, launchCall] = harness.spawnCalls;
        expect(launchCall.command).toBe(path.join(fs.realpathSync(JDKS[11]), 'bin', 'java'));
        expect(launchCall.args).not.toContain('-XX:+UseZGC');
        expect(launchCall.args).toContain('-Xmx600m');
        expect(launchCall.options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
        expect(harness.log.info).toHaveBeenCalledWith(expect.stringMatching(/^Java 11\.0\.28 .* cannot use ZGC; launching without ZGC flags\.$/));
    }, 15000);

    withJdk(11)('Java 11 VM startup failure is reported with stderr and a specific fix', async () => {
        useJava(11);
        fs.renameSync(path.join(microbotDir, `microbot-${VERSION}.jar`), path.join(workDir, 'hidden.jar'));
        try {
            const harness = createHarness({ response: 1 });
            await launch(harness);
            const shown = await within(harness.dialogShown, 10000);
            expect(shown.title).toBe('Java Could Not Start The Client');
            expect(shown.detail).toContain('(vm-failure)');
            expect(shown.detail).toContain('Error: Unable to access jarfile');
            expect(shown.detail).toContain('Delete it from the .microbot folder');
            for (const home of HOMES) expect(shown.detail).not.toContain(home);
        } finally {
            fs.renameSync(path.join(workDir, 'hidden.jar'), path.join(microbotDir, `microbot-${VERSION}.jar`));
        }
    }, 15000);

    withJdk(17)('Java 17 keeps ZGC flags and succeeds without a dialog', async () => {
        useJava(17);
        process.env.M07_MODE = 'sleep';
        const harness = createHarness();
        await launch(harness);
        expect(await within(harness.dialogShown, 5000)).toBeNull();
        expect(harness.spawnCalls[1].args).toContain('-XX:+UseZGC');
    }, 15000);

    withJdk(17)('256 MB RAM setting starts on Java 17 with a soft heap target below the maximum', async () => {
        useJava(17);
        process.env.M07_MODE = 'sleep';
        const harness = createHarness();
        await launch(harness, { ram: '256m' });
        expect(await within(harness.dialogShown, 5000)).toBeNull();
        const args = harness.spawnCalls[1].args;
        expect(args).toEqual(expect.arrayContaining(['-Xms256m', '-Xmx256m', '-XX:+UseZGC', '-XX:SoftMaxHeapSize=204m']));
        expect(args).not.toContain('-XX:SoftMaxHeapSize=500m');
    }, 15000);

    withJdk(17)('2 GB RAM setting keeps the maximum but no longer reserves it up front', async () => {
        useJava(17);
        process.env.M07_MODE = 'sleep';
        const harness = createHarness();
        await launch(harness, { ram: '2g' });
        expect(await within(harness.dialogShown, 5000)).toBeNull();
        const args = harness.spawnCalls[1].args;
        expect(args).toEqual(expect.arrayContaining(['-Xms256m', '-Xmx2g', '-XX:SoftMaxHeapSize=1638m']));
        expect(args).not.toContain('-Xms2g');
    }, 15000);

    withJdk(17)('rejected heap setting is explained as a VM memory failure', async () => {
        useJava(17);
        const harness = createHarness({ response: 1 });
        await launch(harness, { ram: '0.5m' });
        const shown = await within(harness.dialogShown, 15000);
        expect(shown.title).toBe('Java Could Not Start The Client');
        expect(shown.detail).toContain('Lower the client RAM setting');
        expect(shown.detail).toContain('Invalid initial heap size: -Xms0.5m');
        expect(shown.buttons).toEqual(['Copy details', 'Cancel']);
    }, 20000);

    withJdk(17)('client crash during startup is distinguished from VM failure', async () => {
        useJava(17);
        process.env.M07_MODE = 'crash';
        const harness = createHarness({ response: 1 });
        await launch(harness);
        const shown = await within(harness.dialogShown, 10000);
        expect(shown.title).toBe('Client Closed During Startup');
        expect(shown.detail).toContain('(client-startup)');
        expect(shown.detail).toContain('plugin manager failed');
    }, 15000);

    withJdk(17)('stderr in dialogs is redacted and bounded', async () => {
        useJava(17);
        process.env.M07_MODE = 'secrets';
        const harness = createHarness({ response: 1 });
        await launch(harness, {
            proxy: { proxyIp: '10.0.0.5:1080:bob:hunter2' },
            profile: 'MainAccount',
            displayName: 'Zezima the Great'
        });
        const shown = await within(harness.dialogShown, 10000);
        expect(shown.detail).toContain('logged in as ***');
        for (const secret of ['hunter2', 'abc123', 'MainAccount', 'bob@example.com', 'Zezima', ...HOMES]) {
            expect(shown.detail).not.toContain(secret);
        }
        expect(shown.detail).toContain('-proxy=***');
        expect(shown.detail).toContain('~/.microbot');

        jest.resetModules();
        process.env.M07_MODE = 'spam';
        const spam = createHarness({ response: 1 });
        await launch(spam);
        const spamShown = await within(spam.dialogShown, 10000);
        const output = spamShown.detail.split('Java output:\n')[1];
        expect(output.split('\n')).toHaveLength(21);
        expect(output).toContain('noise line 499');
        expect(output).not.toContain('noise line 100\n');
    }, 25000);

    function fakeRuntimeHarness(probeOutput) {
        const { EventEmitter } = require('events');
        const harness = createHarness({ response: 1 });
        harness.deps.spawn = (command, args, options) => {
            harness.spawnCalls.push({ command, args, options });
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.stderr.destroy = jest.fn();
            proc.unref = jest.fn();
            proc.kill = jest.fn();
            setImmediate(() => {
                if (args[0] === '-XshowSettings:properties') {
                    proc.stderr.emit('data', Buffer.from(probeOutput));
                    proc.emit('close', 0);
                }
            });
            return proc;
        };
        return harness;
    }

    test('passes Jagex credentials only in the client process environment', async () => {
        const probeOutput = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const harness = fakeRuntimeHarness(probeOutput);

        await launch(harness, {
            profile: 'MainAccount',
            displayName: 'Fake Character'
        });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(harness.spawnCalls).toHaveLength(2);
        expect(harness.spawnCalls[0].options).toBeUndefined();
        const launchCall = harness.spawnCalls[1];
        expect(launchCall.options.env).toEqual(
            expect.objectContaining({
                JX_CHARACTER_ID: 'test-account',
                JX_SESSION_ID: 'abc123',
                JX_REFRESH_TOKEN: '',
                JX_DISPLAY_NAME: 'Fake Character',
                JX_ACCESS_TOKEN: '',
                MICROBOT_CUT_CLIENT_TICKET: 'header.payload.signature',
                MICROBOT_CUT_PRODUCT_API_BASE_URL: 'https://staging.example/api/v1',
                MICROBOT_CUT_CLIENT_TICKET_KEY_ID: 'staging-2026-01',
                MICROBOT_CUT_CLIENT_TICKET_AUDIENCE: 'microbot-cut-client'
            })
        );
        expect(launchCall.args.join(' ')).not.toContain('abc123');
        expect(launchCall.args.join(' ')).not.toContain('header.payload.signature');
        expect(harness.log.info.mock.calls.flat().join(' ')).not.toContain('header.payload.signature');
    });

    test('plugin development mode requires an explicit launcher environment variable', async () => {
        process.env.MICROBOT_CUT_PLUGIN_DEV = 'true';
        process.env.MICROBOT_CUT_PLUGIN_DEV_ARTIFACT =
            'C:\\plugins\\remote-guardian.jar';
        process.env.MICROBOT_CUT_PLUGIN_DEV_ARTIFACT_NAME =
            'RemoteControlPlugin.jar';
        const probeOutput = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const harness = fakeRuntimeHarness(probeOutput);

        await launch(harness);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(harness.spawnCalls[1].args).toContain(
            '-Dmicrobot.plugins.developmentMode=true'
        );
        expect(harness.spawnCalls[1].args).toContain(
            '-Dmicrobot.plugins.developmentArtifact=C:\\plugins\\remote-guardian.jar'
        );
        expect(harness.spawnCalls[1].args).toContain(
            '-Dmicrobot.plugins.developmentArtifactName=RemoteControlPlugin.jar'
        );
        expect(harness.log.warn).toHaveBeenCalledWith(
            'Plugin development mode enabled by MICROBOT_CUT_PLUGIN_DEV.'
        );
    });

    test('development mode cannot mask a remote repository test', async () => {
        process.env.MICROBOT_CUT_PLUGIN_DEV = 'true';
        process.env.MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'true';
        const probeOutput = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const harness = fakeRuntimeHarness(probeOutput);

        await launch(harness);
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(harness.spawnCalls[1].args).toContain(
            '-Dmicrobot.plugins.developmentMode=true'
        );
        expect(harness.spawnCalls[1].args).not.toContain(
            '-Dmicrobot.plugins.repository.enabled=true'
        );
        expect(harness.log.warn).toHaveBeenCalledWith(
            'Plugin repository ignored while MICROBOT_CUT_PLUGIN_DEV is enabled.'
        );
    });

    test('passes a validated plugin repository without logging the public key', async () => {
        const { publicKey } = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048
        });
        const encodedKey = publicKey
            .export({ type: 'spki', format: 'der' })
            .toString('base64');
        process.env.MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'true';
        process.env.MICROBOT_CUT_PLUGIN_MANIFEST_URL =
            'https://staging.example/plugins/catalog.json';
        process.env.MICROBOT_CUT_PLUGIN_PUBLIC_KEY = encodedKey;
        process.env.MICROBOT_CUT_PLUGIN_PUBLIC_KEY_ID = 'staging-2026';
        const probeOutput = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const harness = fakeRuntimeHarness(probeOutput);

        await launch(harness);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const args = harness.spawnCalls[1].args;
        expect(args).toEqual(
            expect.arrayContaining([
                '-Dmicrobot.plugins.repository.enabled=true',
                '-Dmicrobot.plugins.manifestUrl=https://staging.example/plugins/catalog.json',
                `-Dmicrobot.plugins.publicKey=${encodedKey}`,
                '-Dmicrobot.plugins.publicKeyId=staging-2026'
            ])
        );
        const launchLog = harness.log.info.mock.calls
            .map((call) => call.join(' '))
            .find((message) => message.includes('-jar'));
        expect(launchLog).toContain(
            '-Dmicrobot.plugins.publicKey=<configured>'
        );
        expect(launchLog).not.toContain(encodedKey);
    });

    test('a distributed launcher uses its embedded plugin repository and drops local overrides', async () => {
        const profileLib = require('../libs/distribution-profile');
        const profile = profileLib.loadProfileSource({ fs, path, root: path.join(__dirname, '..'), name: 'staging' });
        const lockedConfig = profileLib.applyDistributionProfile(
            require('../product-config'),
            { ...profile, source: { commit: 'c'.repeat(40), version: '3.2.11' } }
        );
        process.env.DEBUG = 'true';
        process.env.MICROBOT_CUT_PLUGIN_DEV = 'true';
        process.env.MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED = 'true';
        process.env.MICROBOT_CUT_PLUGIN_MANIFEST_URL = 'https://evil.example/catalog.json';
        process.env.MICROBOT_CUT_API_BASE_URL = 'http://localhost:5173/api/v1';
        const probeOutput = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const harness = fakeRuntimeHarness(probeOutput);
        harness.deps.productConfig = lockedConfig;

        try {
            await launch(harness);
            await new Promise((resolve) => setTimeout(resolve, 50));

            const launchCall = harness.spawnCalls[1];
            expect(launchCall.args).toEqual(expect.arrayContaining([
                '-Dmicrobot.plugins.repository.enabled=true',
                `-Dmicrobot.plugins.manifestUrl=${profile.pluginRepository.manifestUrl}`,
                `-Dmicrobot.plugins.publicKeyId=${profile.pluginRepository.publicKeyId}`,
                '-Dmicrobot.plugins.developmentMode=false'
            ]));
            expect(launchCall.args).not.toContain('-Dmicrobot.plugins.developmentMode=true');
            expect(launchCall.args.join(' ')).not.toContain('evil.example');
            const names = Object.keys(launchCall.options.env);
            expect(names).not.toContain('MICROBOT_CUT_PLUGIN_DEV');
            expect(names).not.toContain('MICROBOT_CUT_PLUGIN_MANIFEST_URL');
            expect(names).not.toContain('MICROBOT_CUT_API_BASE_URL');
            expect(launchCall.options.env.MICROBOT_CUT_CLIENT_TICKET).toBe('header.payload.signature');
        } finally {
            delete process.env.MICROBOT_CUT_API_BASE_URL;
        }
    });

    test('an unparseable Java version warns and still launches', async () => {
        const harness = fakeRuntimeHarness('    java.vendor = Mystery\n    sun.arch.data.model = 64\nmystery version "banana"\n');
        await launch(harness, { ram: '1g' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(harness.deps.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(harness.spawnCalls).toHaveLength(2);
        expect(harness.spawnCalls[1].args).not.toContain('-XX:+UseZGC');
        expect(harness.log.warn).toHaveBeenCalledWith('The Java version could not be determined; launching anyway.');
    });

    test('32-bit Java 17 launches without ZGC flags', async () => {
        const harness = fakeRuntimeHarness(
            fs.readFileSync(path.join(__dirname, '__fixtures__', 'java-probe', 'synthetic-windows-temurin-17-x86.txt'), 'utf8')
        );
        await launch(harness, { ram: '512m' });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(harness.deps.dialog.showMessageBox).not.toHaveBeenCalled();
        const args = harness.spawnCalls[1].args;
        expect(args).toEqual(expect.arrayContaining(['-Xms256m', '-Xmx512m']));
        expect(args.some((arg) => /ZGC|SoftMaxHeapSize|ZUncommit/.test(arg))).toBe(false);
    });

    test('multibyte characters split across stderr chunks are still redacted', async () => {
        const { EventEmitter } = require('events');
        const { PassThrough } = require('stream');
        const probe = '    java.version = 17.0.1\n    sun.arch.data.model = 64\nopenjdk version "17.0.1"\n';
        const harness = createHarness({ response: 1 });
        harness.deps.spawn = (command, args) => {
            harness.spawnCalls.push({ command, args });
            const proc = new EventEmitter();
            proc.stdout = new PassThrough();
            proc.stderr = new PassThrough();
            proc.unref = jest.fn();
            proc.kill = jest.fn();
            setImmediate(() => {
                if (args[0] === '-XshowSettings:properties') {
                    proc.stderr.end(probe);
                    setImmediate(() => proc.emit('close', 0));
                    return;
                }
                const line = Buffer.from('logged in as Zézima\n', 'utf8');
                const split = line.indexOf(0xc3) + 1;
                proc.stderr.write(line.subarray(0, split));
                setImmediate(() => {
                    proc.stderr.end(line.subarray(split));
                    setImmediate(() => proc.emit('close', 1, null));
                });
            });
            return proc;
        };
        await launch(harness, { displayName: 'Zézima' });
        const shown = await within(harness.dialogShown, 5000);
        expect(shown.detail).toContain('logged in as ***');
        expect(shown.detail).not.toContain('ima');
        expect(shown.detail).not.toContain('\ufffd');
    });

    test('spawn failures of the resolved executable are process-launch problems', async () => {
        const fakeRuntime = [
            '    java.home = /opt/fake-jdk',
            '    java.version = 17.0.1',
            '    sun.arch.data.model = 64',
            'openjdk version "17.0.1"'
        ].join('\n');
        const { EventEmitter } = require('events');
        const harness = createHarness({ response: 1, clipboard: false });
        harness.deps.spawn = (command, args) => {
            harness.spawnCalls.push({ command, args });
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.stderr.destroy = jest.fn();
            proc.unref = jest.fn();
            proc.kill = jest.fn();
            setImmediate(() => {
                if (args[0] === '-XshowSettings:properties') {
                    proc.stderr.emit('data', Buffer.from(fakeRuntime));
                    proc.emit('close', 0);
                } else {
                    proc.emit('error', Object.assign(new Error(`spawn ${command} EACCES`), { code: 'EACCES' }));
                    proc.emit('close', -13, null);
                }
            });
            return proc;
        };
        await launch(harness);
        const shown = await within(harness.dialogShown, 5000);
        expect(shown.title).toBe('Client Could Not Be Started');
        expect(shown.detail).toContain('(process-launch)');
        expect(shown.buttons).toEqual(['Cancel']);
        expect(harness.deps.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });
});
