const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JAVA_SETTINGS_OUTPUT = [
    'Property settings:',
    '    java.home = C:\\fake\\jre',
    '    java.vendor = Eclipse Adoptium',
    '    java.version = 17.0.20.1',
    '    os.arch = amd64',
    '    sun.arch.data.model = 64',
    'openjdk version "17.0.20.1" 2026-07-21'
].join('\n');

function fakeChild({ output = '', exitCode = null } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    child.stderr.destroy = () => {};
    child.unref = () => {};
    child.kill = () => {};
    child.pid = 4242;
    if (exitCode !== null) {
        setImmediate(() => {
            if (output) child.stderr.emit('data', output);
            child.emit('close', exitCode, null);
        });
    }
    return child;
}

/**
 * Harness for the jar-executor with a fake `spawn`: the first call is the Java probe (answers
 * with a Java 17 banner), the next one is the client process (stays running). Nothing real runs.
 */
function createFakeLaunchHarness({ spawnEnvironment = {}, extraDeps = {}, javaSettings = JAVA_SETTINGS_OUTPUT } = {}) {
    const handlers = {};
    const spawnCalls = [];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-launch-'));
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const launchAccount = {
        accountId: 'test-account',
        displayName: 'Test Account',
        sessionId: 'abc123'
    };
    const deps = {
        spawn: (command, args, options) => {
            spawnCalls.push({ command, args, options, env: { ...process.env, ...spawnEnvironment } });
            const isProbe = args.includes('-version');
            return isProbe
                ? fakeChild({ output: javaSettings, exitCode: 0 })
                : fakeChild();
        },
        path,
        fs,
        log,
        microbotDir: dataDir,
        accountRepository: {
            getAccountForLaunch: jest.fn((id) =>
                id === launchAccount.accountId ? { ...launchAccount } : null
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
                environment: {},
                secrets: [],
                release: jest.fn()
            })
        },
        startupWindowMs: 50,
        packageJson: { version: '3.2.12-test' },
        ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
        shell: { openExternal: jest.fn() },
        dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 0 }), showErrorBox: jest.fn() },
        ...extraDeps
    };
    const waitForClientSpawn = async () => {
        for (let i = 0; i < 100; i++) {
            const client = spawnCalls.find((call) => !call.args.includes('-version'));
            if (client) return client;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('the client process was never spawned');
    };
    return {
        deps,
        handlers,
        spawnCalls,
        dataDir,
        log,
        launchAccount,
        waitForClientSpawn,
        cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true })
    };
}

module.exports = { createFakeLaunchHarness, fakeChild, JAVA_SETTINGS_OUTPUT };
