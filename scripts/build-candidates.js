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

function removeWorktree() {
    if (!fs.existsSync(worktree)) return;
    // Plain removal fails on long node_modules paths; the extended-length prefix does not.
    spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `rd /s /q "\\\\?\\${worktree}"`], { stdio: 'ignore' });
    spawnSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' });
}

function main() {
    if (process.platform !== 'win32') throw new Error('The Windows installer must be built on Windows.');
    if (output('git', ['status', '--porcelain', '--untracked-files=no'], root)) {
        throw new Error('The working tree has uncommitted changes; candidates are built from the committed HEAD only.');
    }
    const commit = output('git', ['rev-parse', 'HEAD'], root);
    const version = JSON.parse(output('git', ['show', 'HEAD:package.json'], root)).version;
    const outputRoot = path.join(workRoot, 'candidates', version);
    if (fs.existsSync(outputRoot)) throw new Error(`candidates already exist: ${outputRoot}`);
    removeWorktree();

    try {
        run('git', ['worktree', 'add', '--detach', worktree, commit], root, 'git worktree add');
        run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci'], worktree, 'npm ci');

        // package.json must already match product-config.js: syncing may not change anything.
        run(process.execPath, ['scripts/sync-product-config.js'], worktree, 'product:sync');
        if (output('git', ['status', '--porcelain', '--untracked-files=no'], worktree)) {
            throw new Error('product:sync changed package.json; commit the synchronized file first.');
        }

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
