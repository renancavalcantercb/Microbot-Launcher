const os = require('os');

// Decision 14 (B-3.8): XP Tracker, Chat Commands and OSRS Wiki Crowdsourcing are off by default in
// Microbot Cut. A new client carries this as `enabledByDefault = false`; this launcher-side step
// covers an older client that runs under this launcher. It writes `false` for a plugin only when
// the profile has no saved value for it, so a user's explicit choice (on or off) is never changed.
const POLICY_VERSION = 1;
const POLICY_KEYS = [
    'runelite.xptrackerplugin',
    'runelite.chatcommandsplugin',
    'runelite.crowdsourcingplugin'
];
const PROFILES_DIRECTORY = 'microbot-profiles';
const PROFILES_INDEX = 'profiles.json';
const PROFILES_LOCK = 'profiles.lck';
const MARKER_FILE = 'profile-privacy-policy.json';
const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ECANCELED', 'ENOLCK']);

// Raised when the policy was needed and could not be applied. The launcher must not start the
// client then: an older client would run the three plugins with their unsafe defaults.
class PrivacyPolicyError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'PrivacyPolicyError';
        this.cause = cause;
        this.failSafe = true;
    }
}

function unescapeKey(raw) {
    return raw
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
}

// Keys present in a Java properties text (the format the client reads), without values.
function propertyKeys(text) {
    const physical = text.split(/\r\n|\n|\r/);
    const keys = new Set();
    for (let index = 0; index < physical.length; index++) {
        let line = physical[index].replace(/^[ \t\f]+/, '');
        if (line === '' || line[0] === '#' || line[0] === '!') continue;
        while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && index + 1 < physical.length) {
            line = line.slice(0, -1) + physical[++index].replace(/^[ \t\f]+/, '');
        }
        let end = 0;
        while (end < line.length) {
            const char = line[end];
            if (char === '\\') {
                end += 2;
                continue;
            }
            if (char === '=' || char === ':' || char === ' ' || char === '\t' || char === '\f') break;
            end++;
        }
        keys.add(unescapeKey(line.slice(0, end)));
    }
    return keys;
}

function endsWithContinuation(text) {
    const trimmed = text.replace(/(?:\r\n|\n|\r)$/, '');
    return /(?:^|[^\\])(?:\\\\)*\\$/.test(trimmed);
}

function defaultLockProbe(fs, lockPath) {
    // Java holds an exclusive lock on the whole file while the client edits the profiles; on
    // Windows that makes a read from another handle fail. A missing file means nobody holds it.
    let descriptor;
    try {
        descriptor = fs.openSync(lockPath, 'r');
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        return LOCK_ERROR_CODES.has(error.code);
    }
    try {
        fs.readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
        return false;
    } catch (error) {
        return LOCK_ERROR_CODES.has(error.code);
    } finally {
        try {
            fs.closeSync(descriptor);
        } catch (_) {}
    }
}

class ProfilePrivacyPolicy {
    constructor({
        fs,
        path,
        runeliteDir,
        productDataDir,
        log,
        probeLock = null,
        lockAttempts = 10,
        lockDelayMs = 200,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now = () => new Date().toISOString()
    }) {
        this.fs = fs;
        this.path = path;
        this.profilesDir = path.join(runeliteDir, PROFILES_DIRECTORY);
        this.markerPath = path.join(productDataDir, MARKER_FILE);
        this.log = log;
        this.probeLock =
            probeLock || ((lockPath) => defaultLockProbe(fs, lockPath));
        this.lockAttempts = lockAttempts;
        this.lockDelayMs = lockDelayMs;
        this.sleep = sleep;
        this.now = now;
    }

    readMarker() {
        try {
            const marker = JSON.parse(this.fs.readFileSync(this.markerPath, 'utf8'));
            if (marker && typeof marker.profiles === 'object' && marker.profiles) return marker;
        } catch (_) {}
        return { version: POLICY_VERSION, profiles: {} };
    }

    writeMarker(marker) {
        const temporary = `${this.markerPath}.${process.pid}.tmp`;
        try {
            this.fs.mkdirSync(this.path.dirname(this.markerPath), { recursive: true });
            this.fs.writeFileSync(temporary, JSON.stringify(marker, null, 2), 'utf8');
            this.fs.renameSync(temporary, this.markerPath);
        } catch (error) {
            try {
                this.fs.rmSync(temporary, { force: true });
            } catch (_) {}
            // Not fatal for safety: the keys are already written and a second run changes nothing.
            this.log.warn(`Could not record the privacy policy marker: ${error.code || error.message}`);
        }
    }

    // Names and ids of the non-internal profiles the client might open. profiles.json can hold
    // encrypted credentials: it is parsed in memory and nothing from it is logged.
    candidateProfiles(profileName) {
        const indexPath = this.path.join(this.profilesDir, PROFILES_INDEX);
        let parsed;
        try {
            parsed = JSON.parse(this.fs.readFileSync(indexPath, 'utf8').replace(/^﻿/, ''));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.log.warn('The profile index could not be read; the client will not reuse it.');
            }
            return [];
        }
        const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
        return profiles
            .filter(
                (profile) =>
                    profile &&
                    typeof profile.name === 'string' &&
                    !profile.name.startsWith('$') &&
                    (typeof profile.id === 'number' || typeof profile.id === 'string') &&
                    (profileName ? profile.name === profileName : true)
            )
            .map((profile) => ({ id: String(profile.id), name: profile.name }));
    }

    profileFile(profile) {
        const file = this.path.join(this.profilesDir, `${profile.name}-${profile.id}.properties`);
        const relative = this.path.relative(this.profilesDir, file);
        if (relative.startsWith('..') || this.path.isAbsolute(relative) || relative.includes(this.path.sep)) {
            return null;
        }
        return file;
    }

    async waitUntilUnlocked() {
        const lockPath = this.path.join(this.profilesDir, PROFILES_LOCK);
        for (let attempt = 0; attempt < this.lockAttempts; attempt++) {
            if (!this.probeLock(lockPath)) return;
            await this.sleep(this.lockDelayMs);
        }
        throw new PrivacyPolicyError(
            'The client profiles are in use by another Microbot Cut process, so the privacy defaults ' +
                'could not be applied. Close other clients and try again.'
        );
    }

    /**
     * Returns { status, profiles } where status is 'none', 'unchanged' or 'applied'.
     * Throws PrivacyPolicyError when a profile needed the policy and it could not be applied.
     */
    async apply({ profileName = null } = {}) {
        const candidates = this.candidateProfiles(profileName);
        if (candidates.length === 0) return { status: 'none', profiles: [] };

        const marker = this.readMarker();
        const pending = candidates.filter(
            (profile) => !(marker.profiles[profile.id]?.policy >= POLICY_VERSION)
        );
        if (pending.length === 0) return { status: 'unchanged', profiles: [] };

        await this.waitUntilUnlocked();

        const changed = [];
        let markerChanged = false;
        for (const profile of pending) {
            const file = this.profileFile(profile);
            if (!file) {
                throw new PrivacyPolicyError(
                    'A client profile name is not a valid file name, so the privacy defaults could not be applied.'
                );
            }
            if (!this.fs.existsSync(file)) continue;
            const wrote = this.applyToFile(file);
            if (wrote) changed.push(profile.id);
            marker.profiles[profile.id] = { policy: POLICY_VERSION, at: this.now() };
            markerChanged = true;
        }
        if (markerChanged) {
            marker.version = POLICY_VERSION;
            this.writeMarker(marker);
        }
        if (changed.length > 0) {
            this.log.info(
                `Privacy defaults (XP Tracker, Chat Commands, Wiki Crowdsourcing off) were applied to ${changed.length} profile(s): ${changed.join(', ')}.`
            );
        }
        return { status: changed.length > 0 ? 'applied' : 'unchanged', profiles: changed };
    }

    // Appends `key=false` for each missing key and keeps every existing byte. Returns true when
    // it wrote. The original is replaced only after the temporary file is verified.
    applyToFile(file) {
        const temporary = `${file}.policy-${process.pid}.tmp`;
        try {
            const before = this.fs.statSync(file);
            const original = this.fs.readFileSync(file);
            if (original.includes(0)) {
                throw new Error('profile file is not a text properties file');
            }
            const text = original.toString('utf8');
            if (endsWithContinuation(text)) {
                throw new Error('profile file ends inside a continued line');
            }
            const present = propertyKeys(text);
            const missing = POLICY_KEYS.filter((key) => !present.has(key));
            if (missing.length === 0) return false;

            const eol = text.includes('\r\n') ? '\r\n' : text.includes('\n') ? '\n' : os.EOL;
            const needsEol = original.length > 0 && !/[\r\n]$/.test(text);
            const addition = Buffer.from(
                (needsEol ? eol : '') + missing.map((key) => `${key}=false`).join(eol) + eol,
                'utf8'
            );
            const next = Buffer.concat([original, addition]);

            this.fs.writeFileSync(temporary, next);
            const written = this.fs.readFileSync(temporary);
            const keys = propertyKeys(written.toString('utf8'));
            if (
                !written.subarray(0, original.length).equals(original) ||
                !POLICY_KEYS.every((key) => keys.has(key))
            ) {
                throw new Error('verification of the updated profile file failed');
            }
            // The file must not have changed since it was read (a client may be writing it).
            const after = this.fs.statSync(file);
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
                throw new Error('profile file changed while the privacy defaults were applied');
            }
            this.fs.renameSync(temporary, file);
            return true;
        } catch (error) {
            try {
                this.fs.rmSync(temporary, { force: true });
            } catch (_) {}
            this.log.error(`Privacy defaults could not be applied to a profile file: ${error.code || error.message}`);
            throw new PrivacyPolicyError(
                'The privacy defaults could not be applied to your client profile, so the client was not started. ' +
                    'Close other Microbot Cut clients and try again.',
                error
            );
        }
    }
}

module.exports = {
    ProfilePrivacyPolicy,
    PrivacyPolicyError,
    POLICY_KEYS,
    POLICY_VERSION,
    MARKER_FILE,
    propertyKeys
};
