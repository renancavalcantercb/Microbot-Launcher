const path = require('path');
const { spawnSync } = require('child_process');

function run(command, args, environment = process.env) {
    const result = spawnSync(command, args, {
        cwd: path.join(__dirname, '..'),
        env: environment,
        stdio: 'inherit'
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        process.exit(result.status || 1);
    }
}

if (process.platform !== 'win32') {
    throw new Error('Production Windows packages must be built on Windows.');
}

const root = path.join(__dirname, '..');
const electronBuilderCli = require.resolve('electron-builder/cli.js');
const configPath = path.join(root, 'electron-builder.production.js');
const verifierPath = path.join(
    root,
    'scripts',
    'verify-windows-signatures.ps1'
);

run(process.execPath, [
    electronBuilderCli,
    '--win',
    'nsis',
    '--publish',
    'never',
    '--config',
    configPath
]);

run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    verifierPath,
    '-OutputDirectory',
    path.join(root, 'dist-production'),
    '-ExpectedPublisher',
    process.env.MICROBOT_CUT_WINDOWS_PUBLISHER_NAME
]);
