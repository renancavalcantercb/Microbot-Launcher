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

const { embedProfile } = require('../libs/distribution-build');

const root = path.join(__dirname, '..');
function gitOutput(...args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
    return result.stdout.trim();
}
// The signed installer is the production environment; its profile is embedded for this build only.
const embedded = embedProfile({
    root,
    name: 'production',
    commit: gitOutput('rev-parse', 'HEAD'),
    version: require('../package.json').version
});
process.on('exit', embedded.cleanup);
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
