const {
    app,
    BrowserWindow,
    dialog,
    shell,
    nativeImage,
    clipboard,
    safeStorage,
    Tray,
    Menu
} = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { ipcMain } = require('electron');
const AdmZip = require('adm-zip');
const packageJson = require(path.join(__dirname, 'package.json'));
const {
    isLocked: isDistributionLocked,
    resolveRuntimeProductConfig
} = require(path.join(__dirname, 'libs', 'distribution-profile.js'));
// A packaged launcher runs only with the profile embedded at build time. There is no fallback:
// without a valid profile it stops here instead of reaching for localhost or the environment.
let productConfig;
try {
    productConfig = resolveRuntimeProductConfig({
        productConfig: require(path.join(__dirname, 'product-config.js')),
        isPackaged: app.isPackaged,
        fs,
        path,
        root: __dirname
    });
} catch (error) {
    log.error(`Distribution profile error: ${error.message}`);
    dialog.showErrorBox('Microbot Cut Launcher cannot start', error.message);
    process.exit(1);
}
const { spawn } = require('child_process');
const {
    microbotDir,
    productDataDir,
    legacyDataDir,
    openLocation
} = require(path.join(
    __dirname,
    'libs',
    'dir-module.js'
));

process.on('uncaughtException', (error) => {
    log.error('Uncaught Exception:', error);
});

let mainWindow = null;
const { ClientLifecycle } = require(path.join(__dirname, 'libs', 'client-lifecycle.js'));
const { LauncherTrayController } = require(path.join(__dirname, 'libs', 'launcher-tray.js'));
const clientLifecycle = new ClientLifecycle();
const trayController = new LauncherTrayController({
    app,
    Tray,
    Menu,
    iconPath: path.join(__dirname, productConfig.iconFile),
    launcherName: productConfig.launcherName,
    clientLifecycle,
    log
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Ensure the .microbot directory exists
if (!fs.existsSync(microbotDir)) {
    fs.mkdirSync(microbotDir);
}

async function loadLibraries() {
    log.info('Loading libraries...');

    const ipcHandlersPath = path.join(__dirname, 'libs', 'ipc-handlers.js');

    try {
        log.info('Requiring ipc-handlers...');
        const handler = require(ipcHandlersPath);
        const deps = {
            AdmZip: AdmZip,
            axios: axios,
            ipcMain: ipcMain,
            microbotDir: microbotDir,
            productDataDir: productDataDir,
            legacyDataDir: legacyDataDir,
            packageJson: packageJson,
            path: path,
            log: log,
            spawn: spawn,
            dialog: dialog,
            shell: shell,
            clipboard: clipboard,
            projectDir: __dirname,
            productConfig: productConfig,
            fs: fs,
            app: app,
            safeStorage: safeStorage,
            mainWindow: mainWindow,
            getMainWindow: () => mainWindow,
            clientLifecycle
        };
        try {
            const mockAuthHandler = require(path.join(
                __dirname,
                'libs',
                'mock-auth.js'
            ));
            if (typeof mockAuthHandler === 'function') {
                mockAuthHandler({ ipcMain, log, allowMock: !isDistributionLocked(productConfig) });
            } else {
                log.error('mock-auth does not export a function');
            }
        } catch (authError) {
            log.error('Error requiring mock-auth:', authError);
        }
        if (typeof handler === 'function') {
            await handler(deps);
        } else {
            log.error('ipcHandlers does not export a function');
        }
        log.info('Done requiring ipcHandlers...');
    } catch (error) {
        log.error('Error requiring ipcHandlers:', error);
    }
}

async function createWindow() {
    // Create the main window, but don't show it yet
    mainWindow = new BrowserWindow({
        width: 1280,
        height: process.env.DEBUG !== 'true' ? 750 : 800,
        show: false, // Don't show the main window immediately
        title: productConfig.launcherName,
        autoHideMenuBar: process.env.DEBUG !== 'true',
        icon: path.join(__dirname, productConfig.iconFile),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: true,
            contextIsolation: true,
            webviewTag: true
        },
        titleBarStyle: process.env.DEBUG !== 'true' ? 'hidden' : '',
        frame: process.env.DEBUG === 'true'
    });

    if (process.platform === 'darwin') {
        mainWindow.setWindowButtonVisibility(false);
    }
    trayController.attach(mainWindow);

    try {
        const extraHandlers = require(path.join(
            __dirname,
            'libs',
            'extra-ipc-handlers.js'
        ));
        if (typeof extraHandlers === 'function') {
            await extraHandlers(app, ipcMain, mainWindow, log, openLocation);
        } else {
            log.error('extra-ipc-handlers does not export a function');
        }
    } catch (e) {
        log.error('Failed to load extra-ipc-handlers:', e);
    }

    await mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

autoUpdater.autoDownload = false;
autoUpdater.disableWebInstaller = true;

autoUpdater.on('update-available', (info) => {
    dialog
        .showMessageBox({
            type: 'info',
            title: 'Update available',
            detail: `Would you like to download version ${info.version} and install it now?`,
            message: `New version of launcher available!`,
            buttons: ['Install', 'Later'],
            cancelId: 1,
            defaultId: 0,
            noLink: false
        })
        .then((result) => {
            if (result.response === 0) {
                dialog.showMessageBox({
                    type: 'info',
                    title: 'Downloading',
                    message: `Downloading version ${info.version} of the launcher...`
                });
                autoUpdater.downloadUpdate();
            }
        });
});

autoUpdater.on('update-downloaded', () => {
    dialog
        .showMessageBox({
            title: 'Install Updates',
            message:
                'Updates downloaded. The application will now quit and install the updates.'
        })
        .then(() => {
            autoUpdater.quitAndInstall();
        });
});

if (!hasSingleInstanceLock) {
    log.info('Another launcher instance is already running; exiting this instance.');
    app.quit();
} else {
    app.on('second-instance', () => {
        trayController.showWindow();
    });

    app.whenReady().then(async () => {
        log.info('App starting...');

        await loadLibraries();
        await createWindow();

        if (process.env.DEBUG !== 'true') {
            mainWindow.show();
            if (productConfig.updateFilesBase) {
                autoUpdater.checkForUpdates();
            } else {
                log.info('Launcher updates are disabled: no product update endpoint configured.');
            }
        } else {
            mainWindow.show();
        }
    });

    app.on('window-all-closed', function () {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('activate', () => {
        trayController.showWindow();
    });
}
