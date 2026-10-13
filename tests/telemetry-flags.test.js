const {
    TELEMETRY_VM_ARG,
    TELEMETRY_PROGRAM_ARG,
    withTelemetryVmArg
} = require('../libs/telemetry-flags');
const { createFakeLaunchHarness } = require('./helpers/fake-java-launch');

describe('telemetry flags helper', () => {
    test('the two switches are the ones documented in A3-1', () => {
        expect(TELEMETRY_VM_ARG).toBe('-Dmicrobot.disableTelemetry=true');
        expect(TELEMETRY_PROGRAM_ARG).toBe('--disable-telemetry');
    });

    test('adds the property once and replaces a conflicting value', () => {
        expect(withTelemetryVmArg(['-Dfoo=1'])).toEqual(['-Dfoo=1', TELEMETRY_VM_ARG]);
        expect(
            withTelemetryVmArg(['-Dmicrobot.disableTelemetry=false', '-Dfoo=1', TELEMETRY_VM_ARG])
        ).toEqual(['-Dfoo=1', TELEMETRY_VM_ARG]);
    });
});

describe('both launch paths pass both switches (decision 9)', () => {
    let harness;

    beforeEach(() => {
        jest.resetModules();
        delete process.env.DEBUG;
    });

    afterEach(() => harness?.cleanup());

    function expectSwitches(call) {
        const args = call.args;
        const jarIndex = args.indexOf('-jar');
        expect(jarIndex).toBeGreaterThan(0);
        expect(args.slice(0, jarIndex).filter((a) => a === TELEMETRY_VM_ARG)).toHaveLength(1);
        expect(args.slice(jarIndex + 2).filter((a) => a === TELEMETRY_PROGRAM_ARG)).toHaveLength(1);
        expect(args.filter((a) => a.startsWith('-Dmicrobot.disableTelemetry='))).toEqual([
            TELEMETRY_VM_ARG
        ]);
    }

    test('open-client', async () => {
        harness = createFakeLaunchHarness();
        await require('../libs/jar-executor')(harness.deps);
        const result = await harness.handlers['open-client']({}, '9.9.9', null, 'test-account', '');
        expect(result).toEqual({ success: true });
        expectSwitches(await harness.waitForClientSpawn());
    });

    test('open-client with a proxy and a profile keeps the switches', async () => {
        harness = createFakeLaunchHarness();
        harness.launchAccount.profile = 'alt';
        await require('../libs/jar-executor')(harness.deps);
        await harness.handlers['open-client'](
            {},
            '9.9.9',
            { proxyIp: '127.0.0.1:1080' },
            'test-account',
            ''
        );
        const call = await harness.waitForClientSpawn();
        expectSwitches(call);
        expect(call.args).toContain('-profile=alt');
        expect(call.args.some((a) => a.startsWith('-proxy='))).toBe(true);
    });

    test('play-no-jagex-account', async () => {
        harness = createFakeLaunchHarness();
        await require('../libs/jar-executor')(harness.deps);
        await harness.handlers['play-no-jagex-account']({}, '9.9.9', null, '');
        const call = await harness.waitForClientSpawn();
        expectSwitches(call);
        expect(call.args).toContain('-clean-jagex-launcher');
    });

    test('a channel override that returns other flags cannot drop the property', async () => {
        harness = createFakeLaunchHarness({
            extraDeps: {
                productVmArgsForLaunch: () => ['-Dmicrobot.plugins.repository.enabled=false']
            }
        });
        await require('../libs/jar-executor')(harness.deps);
        await harness.handlers['open-client']({}, '9.9.9', null, 'test-account', '');
        const call = await harness.waitForClientSpawn();
        expectSwitches(call);
        expect(call.args).toContain('-Dmicrobot.plugins.repository.enabled=false');
    });
});
