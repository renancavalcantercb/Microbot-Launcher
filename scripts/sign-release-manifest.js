const fs = require('fs');
const path = require('path');

const { signReleaseManifest } = require('../libs/release-manifest-signing');

function usage() {
    return 'Usage: node scripts/sign-release-manifest.js <payload.json> <private-key.pem> <key-id> <output.json>';
}

function main(args = process.argv.slice(2)) {
    if (args.length !== 4) throw new Error(usage());
    const payloadPath = path.resolve(args[0]);
    const privateKeyPath = path.resolve(args[1]);
    const outputPath = path.resolve(args[3]);
    if (payloadPath === outputPath || privateKeyPath === outputPath) {
        throw new Error('output must not overwrite an input file');
    }

    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
    const envelope = signReleaseManifest(payload, {
        keyId: args[2],
        privateKeyPem
    });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx'
        });
        fs.renameSync(temporary, outputPath);
    } catch (error) {
        try {
            fs.unlinkSync(temporary);
        } catch (_) {}
        throw error;
    }
    process.stdout.write(`Signed ${payload.channel} release manifest with key ${args[2]}\n`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { main };
