const { EventEmitter } = require('events');

class ClientLifecycle extends EventEmitter {
    constructor() {
        super();
        this.nextLaunchId = 1;
        this.pendingLaunches = new Set();
        this.activeProcesses = new Map();
    }

    beginLaunch() {
        const launchId = this.nextLaunchId++;
        this.pendingLaunches.add(launchId);
        this.emitChange();
        return launchId;
    }

    markStarted(launchId, processId) {
        this.pendingLaunches.delete(launchId);
        if (Number.isInteger(processId) && processId > 0) {
            this.activeProcesses.set(launchId, processId);
        }
        this.emitChange();
    }

    markFailed(launchId) {
        const changed = this.pendingLaunches.delete(launchId)
            || this.activeProcesses.delete(launchId);
        if (changed) this.emitChange();
    }

    markStopped(launchId) {
        const changed = this.pendingLaunches.delete(launchId)
            || this.activeProcesses.delete(launchId);
        if (changed) this.emitChange();
    }

    hasClients() {
        return this.pendingLaunches.size > 0 || this.activeProcesses.size > 0;
    }

    status() {
        return {
            pending: this.pendingLaunches.size,
            active: this.activeProcesses.size,
            total: this.pendingLaunches.size + this.activeProcesses.size
        };
    }

    emitChange() {
        this.emit('change', this.status());
    }
}

module.exports = { ClientLifecycle };
