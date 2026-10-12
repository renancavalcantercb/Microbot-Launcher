const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { PROFILE_NAMES } = require('../libs/distribution-profile');
const { requireSameSourceCandidates } = require('../libs/launcher-release-publication');

// Builds the staging and production installers from one clean checkout of HEAD:
//   node scripts/build-candidates.js
// A temporary worktree gets `npm ci` (no copied node_modules, no junctions), then
// scripts/build-distribution.js runs once per profile. Nothing is published.

const root = path.join(__dirname, '..');
const workRoot = path.join(root, '.release-work');
let outputRoot = null;
let testResults = null;
// Short on purpose: deep node_modules paths exceed Windows path limits in longer worktree names.
const worktree = path.join(workRoot, 'b');

function run(command, args, cwd, label) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label || command} failed with exit code ${result.status}`);
}

function output(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout.trim();
}

function runTests(cwd) {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm test -- --ci --coverage=false'], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    });
    const log = `${result.stdout || ''}\n${result.stderr || ''}`;
    const line = (label) => (new RegExp(`^${label}:\\s+(.*)$`, 'm').exec(log) || [])[1] || null;
    const summary = { suites: line('Test Suites'), tests: line('Tests'), passed: result.status === 0 };
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, 'test-results.txt'), log, { flag: 'wx' });
    if (!summary.passed) throw new Error(`tests failed on the npm ci tree: ${summary.tests || 'see test-results.txt'}`);
    return summary;
}

function removeWorktree() {
    if (!fs.existsSync(worktree)) return;
    // Plain removal fails on long node_modules paths; the extended-length prefix does not. The
    // command line is passed verbatim because Node would otherwise re-escape its quotes.
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `rd /s /q "\\\\?\\${worktree}"`], {
        stdio: 'ignore',
        windowsVerbatimArguments: true
    });
    spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
    if (fs.existsSync(worktree)) throw new Error(`could not remove the temporary worktree: ${worktree}`);
}

function main() {
    if (process.platform !== 'win32') throw new Error('The Windows installer must be built on Windows.');
    // The build uses a worktree of HEAD, so uncommitted edits in this checkout are not included.
    if (output('git', ['status', '--porcelain', '--untracked-files=no'], root)) {
        console.warn('Warning: this checkout has uncommitted changes. They are NOT part of the candidates.');
    }
    const commit = output('git', ['rev-parse', 'HEAD'], root);
    const version = JSON.parse(output('git', ['show', 'HEAD:package.json'], root)).version;
    outputRoot = path.join(workRoot, 'candidates', version);
    if (fs.existsSync(outputRoot)) throw new Error(`candidates already exist: ${outputRoot}`);
    removeWorktree();

    try {
        run('git', ['worktree', 'add', '--detach', worktree, commit], root, 'git worktree add');
        run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci'], worktree, 'npm ci');

        // package.json must already match product-config.js: syncing may not change anything.
        run(process.execPath, ['scripts/sync-product-config.js'], worktree, 'product:sync');
        // Only line endings may differ (the script writes LF); restore the committed bytes after.
        if (output('git', ['diff', '--ignore-cr-at-eol', '--stat'], worktree)) {
            throw new Error('product:sync changed package.json; commit the synchronized file first.');
        }
        run('git', ['checkout', '--', 'package.json'], worktree, 'git checkout package.json');

        // The installers carry the npm ci dependency tree, so the tests must run on that tree.
        testResults = runTests(worktree);

        for (const profile of PROFILE_NAMES) {
            run(process.execPath, [
                'scripts/build-distribution.js',
                '--profile', profile,
                '--output', path.join(outputRoot, profile)
            ], worktree, `build ${profile}`);
        }
    } finally {
        removeWorktree();
    }

    const read = (profile) => JSON.parse(
        fs.readFileSync(path.join(outputRoot, profile, 'candidate.json'), 'utf8')
    );
    const staging = read('staging');
    const production = read('production');
    requireSameSourceCandidates(staging, production);
    if (staging.sourceCommit !== commit) throw new Error('candidates were not built from HEAD');
    const summary = {
        version,
        sourceCommit: commit,
        testsOnNpmCiTree: testResults,
        dependencyVersions: {
            electron: staging.tools.electron,
            electronBuilder: staging.tools.electronBuilder,
            node: staging.tools.node
        },
        candidates: [staging, production].map((candidate) => ({
            profile: candidate.profile,
            file: path.join(outputRoot, candidate.profile, candidate.file),
            size: candidate.size,
            sha256: candidate.sha256,
            sha512Base64: candidate.sha512Base64,
            embeddedProfileSha256: candidate.embeddedProfileSha256,
            appAsarSha256: candidate.appAsarSha256,
            effectiveConfiguration: candidate.effectiveConfiguration
        }))
    };
    fs.writeFileSync(path.join(outputRoot, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(summary, null, 2));
}

try {
    main();
} catch (error) {
    console.error(`build-candidates failed: ${error.message}`);
    process.exit(1);
}
