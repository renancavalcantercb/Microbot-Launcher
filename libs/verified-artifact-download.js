const crypto = require('crypto');
const fs = require('fs');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        bytes += chunk.length;
        hash.update(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
}

async function removeIfPresent(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function downloadVerifiedArtifact({
    httpClient,
    url,
    destination,
    expectedSize,
    expectedSha256,
    onProgress = () => {}
}) {
    if (typeof httpClient !== 'function') throw new Error('httpClient is required');
    if (!(url instanceof URL) || url.protocol !== 'https:') {
        throw new Error('artifact URL must use HTTPS');
    }
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
        throw new Error('artifact size must be a positive safe integer');
    }
    if (!SHA256_PATTERN.test(expectedSha256 || '')) {
        throw new Error('artifact SHA-256 is invalid');
    }

    try {
        const existing = await hashFile(destination);
        if (existing.bytes === expectedSize && existing.sha256 === expectedSha256) {
            return { ...existing, path: destination, reused: true };
        }
        throw new Error('existing artifact does not match the signed release manifest');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const temporary = `${destination}.${process.pid}.${Date.now()}.${crypto
        .randomBytes(6)
        .toString('hex')}.part`;
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    const verifier = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > expectedSize) {
                callback(new Error('downloaded artifact exceeds its signed byte count'));
                return;
            }
            hash.update(chunk);
            onProgress({ bytes, total: expectedSize });
            callback(null, chunk);
        }
    });

    try {
        const response = await httpClient({
            method: 'get',
            url: url.toString(),
            responseType: 'stream'
        });
        if (!response || !response.data || typeof response.data.pipe !== 'function') {
            throw new Error('artifact response is not a readable stream');
        }
        await pipeline(
            response.data,
            verifier,
            fs.createWriteStream(temporary, { flags: 'wx' })
        );
        const actualSha256 = hash.digest('hex');
        if (bytes !== expectedSize) {
            throw new Error(`artifact size mismatch: expected ${expectedSize}, received ${bytes}`);
        }
        if (actualSha256 !== expectedSha256) {
            throw new Error('artifact SHA-256 does not match the signed release manifest');
        }
        await fs.promises.rename(temporary, destination);
        return {
            bytes,
            sha256: actualSha256,
            path: destination,
            reused: false
        };
    } catch (error) {
        await removeIfPresent(temporary);
        throw error;
    }
}

module.exports = {
    downloadVerifiedArtifact,
    hashFile
};
