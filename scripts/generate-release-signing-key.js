const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function generateReleaseSigningKey({ keyId, privateKeyPath, publicKeyPath }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId || '')) {
        throw new Error('release signing key ID is invalid');
    }
    const privateTarget = path.resolve(privateKeyPath);
    const publicTarget = path.resolve(publicKeyPath);
    if (privateTarget === publicTarget) {
        throw new Error('private and public key outputs must be different files');
    }
    if (fs.existsSync(privateTarget) || fs.existsSync(publicTarget)) {
        throw new Error('refusing to overwrite an existing release signing key');
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 3072,
        publicExponent: 0x10001
    });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicDer = publicKey.export({ type: 'spki', format: 'der' });
    fs.mkdirSync(path.dirname(privateTarget), { recursive: true });
    fs.mkdirSync(path.dirname(publicTarget), { recursive: true });

    const privateTemporary = `${privateTarget}.${process.pid}.tmp`;
    const publicTemporary = `${publicTarget}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(privateTemporary, privatePem, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
        fs.writeFileSync(
            publicTemporary,
            `${JSON.stringify({
                keyId,
                algorithm: 'RS256',
                publicKey: publicDer.toString('base64')
            }, null, 2)}\n`,
            { encoding: 'utf8', flag: 'wx' }
        );
        fs.renameSync(privateTemporary, privateTarget);
        fs.renameSync(publicTemporary, publicTarget);
    } catch (error) {
        for (const temporary of [privateTemporary, publicTemporary]) {
            try {
                fs.unlinkSync(temporary);
            } catch (_) {}
        }
        try {
            fs.unlinkSync(privateTarget);
        } catch (_) {}
        throw error;
    }
    return { keyId, privateKeyPath: privateTarget, publicKeyPath: publicTarget };
}

function main(args = process.argv.slice(2)) {
    if (args.length !== 3) {
        throw new Error(
            'Usage: node scripts/generate-release-signing-key.js <key-id> <private-key.pem> <public-key.json>'
        );
    }
    const result = generateReleaseSigningKey({
        keyId: args[0],
        privateKeyPath: args[1],
        publicKeyPath: args[2]
    });
    process.stdout.write(
        `Generated ${result.keyId}; private key saved without printing; public metadata saved to ${result.publicKeyPath}\n`
    );
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { generateReleaseSigningKey };
