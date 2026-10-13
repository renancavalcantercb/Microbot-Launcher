const fs = require('fs');
const path = require('path');
const profileLib = require('../libs/distribution-profile');
const { createFakeLaunchHarness } = require('./helpers/fake-java-launch');
const { createRuntimeFixture } = require('./helpers/runtime-fixture');

const root = path.join(__dirname, '..');
const exeName = (name) => (process.platform === 'win32' ? `${name}.exe` : name === 'javaw' ? 'java' : name);

function lockedConfig(name, runtimePin) {
    const profile = profileLib.loadProfileSource({ fs, path, root, name });
    return profileLib.applyDistributionProfile(require('../product-config'), {
        ...profile,
        source: { commit: 'c'.repeat(40), version: '3.2.12' },
        ...(runtimePin ? { embeddedRuntime: runtimePin } : {})
    });
}

const HOSTILE = {
    JAVA_TOOL_OPTIONS: '-javaagent:C:/evil/agent.jar',
    _JAVA_OPTIONS: '-Xmx1m',
    JDK_JAVA_OPTIONS: '--add-opens=java.base/java.lang=ALL-UNNAMED'
};

describe('the embedded Java runtime is the only Java a distributed launcher runs', () => {
    let fixture;
    let harness;
    let savedEnvironment;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.DEBUG;
        savedEnvironment = {};
        for (const [name, value] of Object.entries(HOSTILE)) {
            savedEnvironment[name] = process.env[name];
            process.env[name] = value;
        }
        fixture = createRuntimeFixture();
    });

    afterEach(() => {
        for (const [name, value] of Object.entries(savedEnvironment)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        harness?.cleanup();
        fixture.cleanup();
    });

    function distributed(options = {}) {
        harness = createFakeLaunchHarness({
            javaSettings: options.javaSettings || fixture.probeOutput,
            extraDeps: {
                productConfig: lockedConfig('production', options.pin === undefined ? fixture.pin : options.pin),
                embeddedRuntimeDirectory: options.directory || fixture.dir,
                profilePrivacyPolicy: { apply: jest.fn().mockResolvedValue({ status: 'none', profiles: [] }) }
            }
        });
        return harness;
    }

    async function launch() {
        await require('../libs/jar-executor')(harness.deps);
        return harness.handlers['open-client']({}, '9.9.9', null, 'test-account', '');
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

    test('probes and launches with the verified embedded executables, never a Java from PATH', async () => {
        distributed();
        expect(await launch()).toEqual({ success: true });
        const client = await harness.waitForClientSpawn();
        const probe = harness.spawnCalls[0];
        expect(probe.command).toBe(path.join(fixture.dir, 'bin', exeName('java')));
        expect(client.command).toBe(path.join(fixture.dir, 'bin', exeName('javaw')));
        expect(harness.spawnCalls.map((call) => call.command)).not.toContain('java');
        expect(harness.log.info.mock.calls.flat().join('\n')).toContain('Embedded Java runtime verified');
    });

    test('the Java child gets no JAVA_TOOL_OPTIONS, _JAVA_OPTIONS or JDK_JAVA_OPTIONS; the launcher keeps them', async () => {
        distributed();
        await launch();
        const client = await harness.waitForClientSpawn();
        for (const call of [harness.spawnCalls[0], client]) {
            const names = Object.keys(call.options.env).map((name) => name.toUpperCase());
            for (const hostile of Object.keys(HOSTILE)) expect(names).not.toContain(hostile);
        }
        for (const [name, value] of Object.entries(HOSTILE)) expect(process.env[name]).toBe(value);
        const warnings = harness.log.warn.mock.calls.flat().join('\n');
        expect(warnings).toContain('JAVA_TOOL_OPTIONS');
        expect(warnings).not.toContain('evil');
        expect(warnings).not.toContain('-Xmx1m');
    });

    test.each([
        ['one modified byte', (dir) => fs.writeFileSync(path.join(dir, 'lib', 'modules'), 'modules-imagE'), /modified file/],
        ['an extra file', (dir) => fs.writeFileSync(path.join(dir, 'bin', 'x.dll'), 'x'), /unexpected file/],
        ['a missing file', (dir) => fs.rmSync(path.join(dir, 'release')), /missing a file/]
    ])('tampering (%s) stops the launch and never starts a Java', async (_label, tamper, message) => {
        distributed();
        tamper(fixture.dir);
        const result = await launch();
        expect(result).toEqual({ success: true });
        await settle();
        expect(harness.spawnCalls).toEqual([]);
        const shown = harness.deps.dialog.showMessageBox.mock.calls[0][0];
        expect(shown.title).toBe('Java Runtime Damaged');
        expect(shown.detail).toMatch(message);
        expect(shown.buttons).not.toContain('Yes, Download JDK');
        expect((await harness.deps.clientTicketBroker.createGrant.mock.results[0].value).release).toHaveBeenCalled();
    });

    test('a missing runtime directory stops the launch with a reinstall message', async () => {
        distributed({ directory: path.join(fixture.dir, 'does-not-exist') });
        await launch();
        await settle();
        expect(harness.spawnCalls).toEqual([]);
        expect(harness.deps.dialog.showMessageBox.mock.calls[0][0].detail).toContain('Reinstall');
    });

    test('a profile without a runtime pin stops the launch (no silent system Java)', async () => {
        distributed({ pin: null });
        await launch();
        await settle();
        expect(harness.spawnCalls).toEqual([]);
        expect(harness.deps.dialog.showMessageBox.mock.calls[0][0].detail).toContain('no embedded Java runtime');
    });

    test('a different image than the pinned one is refused', async () => {
        distributed({ pin: { ...fixture.pin, imageSha256: 'f'.repeat(64) } });
        await launch();
        await settle();
        expect(harness.spawnCalls).toEqual([]);
        expect(harness.deps.dialog.showMessageBox.mock.calls[0][0].detail).toContain('does not match');
    });

    test('a runtime that reports another java.home is refused after the probe', async () => {
        distributed({ javaSettings: fixture.probeOutput.replace(fixture.dir, 'C:\\Program Files\\Other Java') });
        await launch();
        await settle();
        expect(harness.spawnCalls).toHaveLength(1);
        expect(harness.deps.dialog.showMessageBox.mock.calls[0][0].detail).toContain('unexpected location');
    });

    test('a development checkout (not locked) still uses the Java on PATH, with the options removed', async () => {
        harness = createFakeLaunchHarness({
            extraDeps: { profilePrivacyPolicy: { apply: jest.fn().mockResolvedValue({ status: 'none', profiles: [] }) } }
        });
        await launch();
        await harness.waitForClientSpawn();
        expect(harness.spawnCalls[0].command).toBe('java');
        const names = Object.keys(harness.spawnCalls[0].options.env).map((name) => name.toUpperCase());
        for (const hostile of Object.keys(HOSTILE)) expect(names).not.toContain(hostile);
    });

    test('play-no-jagex-account uses the same verified runtime', async () => {
        distributed();
        await require('../libs/jar-executor')(harness.deps);
        await harness.handlers['play-no-jagex-account']({}, '9.9.9', null, '');
        const client = await harness.waitForClientSpawn();
        expect(client.command).toBe(path.join(fixture.dir, 'bin', exeName('javaw')));
    });
});
