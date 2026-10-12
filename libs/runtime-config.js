const fs = require('fs');
const path = require('path');

const { resolveRuntimeProductConfig } = require('./distribution-profile');

// The product configuration this process runs with: the embedded distribution profile in a
// packaged app, the plain development configuration otherwise. Resolved once and shared, so the
// data directories, tray, window and services all see the same environment.
let resolved = null;

function isPackagedApp() {
    try {
        const electron = require('electron');
        return Boolean(electron && electron.app && electron.app.isPackaged);
    } catch (_) {
        return false;
    }
}

function getProductConfig() {
    if (!resolved) {
        resolved = resolveRuntimeProductConfig({
            productConfig: require('../product-config'),
            isPackaged: isPackagedApp(),
            fs,
            path,
            root: path.join(__dirname, '..')
        });
    }
    return resolved;
}

module.exports = { getProductConfig };
