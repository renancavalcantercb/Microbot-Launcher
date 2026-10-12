const io = require('../libs/release-publication-io');
const ops = require('../libs/release-store-ops');
const { openStore } = require('../libs/r2-store');

// Run once per bucket, before the first real publication, with read-write R2 credentials:
//   node scripts/probe-r2-conditional-writes.js --config <config> --confirm-probe
// It writes one tiny object under releases/<channel>/probes/ and checks that R2 refuses a second
// create (If-None-Match: *) and a write under a stale If-Match. It touches no release object.

const deps = { openStore };

async function main(argv = process.argv.slice(2)) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--confirm-probe') options.confirm = true;
        else if (token === '--config' && argv[index + 1] && !argv[index + 1].startsWith('--')) {
            options.config = argv[index + 1];
            index += 1;
        } else throw new Error(`unexpected argument: ${token}\nUsage: node scripts/probe-r2-conditional-writes.js --config <config> --confirm-probe`);
    }
    if (!options.confirm) throw new Error('the probe writes one object to the bucket; pass --confirm-probe to run it');
    const config = io.loadConfiguration(options.config);
    const { key } = await ops.probeConditionalWrites(deps.openStore(config, { writable: true }), config.channel);
    process.stdout.write(`R2 enforces If-None-Match: * and If-Match on ${config.bucket} (probe object ${key}).\n`);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { deps, main };
