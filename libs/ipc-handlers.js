module.exports = async function (deps) {
    const {
        ipcMain,
        axios,
        microbotDir,
        packageJson,
        path,
        log,
        dialog,
        shell,
        fs,
        projectDir,
        app,
        safeStorage,
        productDataDir,
        legacyDataDir,
        mainWindow,
        getMainWindow
    } = deps;

    const productConfig =
        deps.productConfig ||
        require(path.join(projectDir, 'product-config.js'));
    const url = productConfig.updateApiBase;
    const filestorage = productConfig.updateFilesBase;
    const { buildReleaseUpdateSettings } = require(path.join(
        projectDir,
        'libs',
        'release-update-settings.js'
    ));
    const { ReleaseManifestService } = require(path.join(
        projectDir,
        'libs',
        'release-manifest-service.js'
    ));
    const { downloadVerifiedArtifact } = require(path.join(
        projectDir,
        'libs',
        'verified-artifact-download.js'
    ));
    const { VerifiedClientReleaseStore } = require(path.join(
        projectDir,
        'libs',
        'verified-client-release-store.js'
    ));
    const releaseUpdateSettings = buildReleaseUpdateSettings({
        environment: deps.environment || process.env,
        productConfig,
        allowEnvironmentConfiguration:
            deps.allowReleaseEnvironmentConfiguration ??
            (deps.environment || process.env).DEBUG === 'true',
        log
    });
    const releaseManifestService = new ReleaseManifestService({
        axios,
        productDataDir: productDataDir || microbotDir,
        settings: releaseUpdateSettings,
        log
    });
    const verifiedClientReleaseStore = new VerifiedClientReleaseStore({
        fs,
        productDataDir: productDataDir || microbotDir,
        log
    });
    function selectedClientVersion() {
        try {
            const properties = JSON.parse(
                fs.readFileSync(path.join(microbotDir, 'resource_versions.json'), 'utf8')
            );
            return properties.version_pref && properties.version_pref !== '0.0.0'
                ? properties.version_pref
                : properties.client || null;
        } catch (_) {
            return null;
        }
    }

    function clientReleaseStatus() {
        return {
            enabled: releaseUpdateSettings.enabled,
            channel: releaseUpdateSettings.channel || null,
            selectedVersion: selectedClientVersion(),
            ...verifiedClientReleaseStore.status()
        };
    }

    function publishClientReleaseStatus() {
        const activeWindow = typeof getMainWindow === 'function'
            ? getMainWindow()
            : mainWindow;
        if (!activeWindow || activeWindow.isDestroyed()) return;
        activeWindow.webContents.send('client-release:changed', clientReleaseStatus());
    }
    const { ClientReleaseHealth } = require(path.join(
        projectDir,
        'libs',
        'client-release-health.js'
    ));
    const clientReleaseHealth = new ClientReleaseHealth({
        fs,
        microbotDir,
        releaseStore: verifiedClientReleaseStore,
        log,
        timeoutMs: deps.clientHealthTimeoutMs,
        onChanged: publishClientReleaseStatus
    });
    if (releaseUpdateSettings.enabled) {
        log.info(
            `Signed product updates enabled on ${releaseUpdateSettings.channel} channel.`
        );
    }
    const { DataDirectoryImporter } = require(path.join(
        projectDir,
        'libs',
        'data-directory-importer.js'
    ));
    const dataDirectoryImporter =
        productDataDir && legacyDataDir
            ? new DataDirectoryImporter({
                  fs,
                  path,
                  productDataDir,
                  legacyDataDir,
                  productId: productConfig.productId,
                  log
              })
            : null;

    ipcMain.handle('data-directory-status', async () =>
        dataDirectoryImporter
            ? dataDirectoryImporter.status()
            : { error: 'Data directory importer is unavailable' }
    );
    ipcMain.handle('import-legacy-data', async () => {
        if (!dataDirectoryImporter) {
            return { error: 'Data directory importer is unavailable' };
        }
        try {
            return dataDirectoryImporter.importLegacyData();
        } catch (error) {
            log.error(`Legacy data import failed: ${error.message}`);
            return { error: error.message };
        }
    });

    const oauthJagex = require(path.join(
        projectDir,
        'libs',
        'oauth-jagex.js'
    ));
    const { startAuthFlow, cancelAuthFlow } = oauthJagex;
    const {
        listClientJars,
        markClientDownloaded,
        isSafeClientVersion
    } = require(path.join(projectDir, 'libs', 'client-jars.js'));
    const { AccountRepository } = require(path.join(
        projectDir,
        'libs',
        'account-repository.js'
    ));
    const { ElectronSafeStorageSecretStore } = require(path.join(
        projectDir,
        'libs',
        'account-secret-store.js'
    ));
    const secretStore = safeStorage
        ? new ElectronSafeStorageSecretStore(safeStorage)
        : null;
    const { ProductSessionService } = require(path.join(
        projectDir,
        'libs',
        'product-session.js'
    ));
    const { InstallationIdentity } = require(path.join(
        projectDir,
        'libs',
        'installation-identity.js'
    ));
    const installationIdentity = new InstallationIdentity({
        fs,
        path,
        productDataDir: productDataDir || microbotDir
    });
    const productSessionService = new ProductSessionService({
        axios,
        fs,
        path,
        productDataDir: productDataDir || microbotDir,
        productConfig,
        packageJson,
        secretStore,
        installationIdentity,
        log,
        onSessionInvalidated: (status) => {
            const activeWindow = typeof getMainWindow === 'function'
                ? getMainWindow()
                : mainWindow;
            if (!activeWindow || activeWindow.isDestroyed()) return;
            activeWindow.webContents.send('product-session:changed', status);
        }
    });
    ipcMain.handle('product-session:activate', async (_event, code) =>
        productSessionService.activate(code)
    );
    ipcMain.handle('product-session:status', async () =>
        productSessionService.status()
    );
    ipcMain.handle('product-session:signout', async () =>
        productSessionService.signout()
    );
    ipcMain.handle('product-session:open-account', async () => {
        const accountUrl = new URL(productSessionService.apiBaseUrl);
        accountUrl.pathname = '/';
        accountUrl.search = '';
        accountUrl.hash = '';
        await shell.openExternal(accountUrl.toString());
        return { success: true };
    });
    async function authorizeConfiguredReleaseChannel() {
        if (!releaseUpdateSettings.enabled) return;
		if (typeof deps.authorizeReleaseChannel === 'function') {
			await deps.authorizeReleaseChannel(releaseUpdateSettings.channel);
			return;
		}
        await productSessionService.authorizeReleaseChannel(releaseUpdateSettings.channel);
    }
    ipcMain.handle('client-release:status', async () => clientReleaseStatus());
    ipcMain.handle('client-release:rollback', async () => {
        try {
            if (!releaseUpdateSettings.enabled) {
                return { error: 'Signed product updates are not enabled' };
            }
            await authorizeConfiguredReleaseChannel();
            const state = verifiedClientReleaseStore.read();
            const version = state.lastKnownGoodVersion;
            const entry = version ? state.releases[version] : null;
            if (!entry || entry.health !== 'healthy') {
                return { error: 'No healthy client release is available for rollback' };
            }
            assertRegisteredReleaseIsSigned(entry);
            const filePath = path.join(microbotDir, `microbot-${version}.jar`);
            await verifiedClientReleaseStore.verifyFile(entry, filePath);
            clientReleaseHealth.selectRollback(version);
            log.info(`Manually selected last-known-good client ${version}.`);
            publishClientReleaseStatus();
            return { success: true, version, status: clientReleaseStatus() };
        } catch (error) {
            log.error(`Manual client rollback failed: ${error.message}`);
            return { error: error.message };
        }
    });
    const accountRepository =
        deps.accountRepository ||
        new AccountRepository({ fs, path, microbotDir, log, secretStore });
    if (secretStore && typeof accountRepository.migrateLegacy === 'function') {
        const migration = accountRepository.migrateLegacy();
        if (migration.migrated) {
            log.info(
                `Migrated ${migration.accounts} Jagex account(s) into ${migration.sessions} protected session(s).`
            );
        }
    }
    if (typeof oauthJagex.configureAccountRepository === 'function') {
        oauthJagex.configureAccountRepository(accountRepository);
    }
    const accountDeps = {
        ...deps,
        accountRepository,
        productConfig,
        productSessionService,
        brokerSecretStore: secretStore
    };

    function invalidVersionResult(version) {
        const message = `Invalid client version: ${JSON.stringify(String(version))}`;
        log.error(message);
        return { error: message };
    }

    function signedClientEntry(release, filePath) {
        return {
            version: release.client.version,
            fileName: path.basename(filePath),
            channel: release.channel,
            sequence: release.sequence,
            size: release.client.size,
            sha256: release.client.sha256,
            artifactPath: release.client.artifactPath,
            signedEnvelope: releaseManifestService.getLocallyAcceptedEnvelope()
        };
    }

    function assertRegisteredReleaseIsSigned(entry) {
        if (!entry?.signedEnvelope) {
            throw new Error(`client ${entry?.version || 'release'} has no signed local metadata`);
        }
        const release = releaseManifestService.verifyEnvelope(entry.signedEnvelope);
        const client = release.client;
        if (
            release.channel !== entry.channel ||
            release.sequence !== entry.sequence ||
            client.version !== entry.version ||
            client.size !== entry.size ||
            client.sha256 !== entry.sha256 ||
            client.artifactPath !== entry.artifactPath
        ) {
            throw new Error(`client ${entry.version} registry metadata does not match its signed manifest`);
        }
    }

    async function verifyClientBeforeLaunch(version) {
        if (!releaseUpdateSettings.enabled) return { legacy: true };
        const filePath = path.join(microbotDir, `microbot-${version}.jar`);
        const registered = verifiedClientReleaseStore.get(version);
        if (registered) {
            assertRegisteredReleaseIsSigned(registered);
            await verifiedClientReleaseStore.verifyFile(registered, filePath);
            log.info(`Verified local client release ${version} before launch.`);
            return { verified: true, release: registered };
        }

        let release = releaseManifestService.getLocallyAccepted();
        if (!release || release.client.version !== version) {
            try {
                release = await releaseManifestService.fetchCurrent();
            } catch (error) {
                log.warn?.(`Unable to identify ${version} as a signed release: ${error.message}`);
                release = null;
            }
        }
        if (release?.client?.version === version) {
            const entry = signedClientEntry(release, filePath);
            await verifiedClientReleaseStore.verifyFile(entry, filePath);
            verifiedClientReleaseStore.record(entry);
            log.info(`Enrolled and verified local client release ${version} before launch.`);
            return { verified: true, release: entry };
        }

        log.warn?.(`Launching unregistered legacy/custom client ${version}.`);
        return { legacy: true };
    }

    ipcMain.handle('start-auth-flow', async (event) => {
        const bringLauncherToFront = () => {
            const win = require('electron').BrowserWindow.fromWebContents(event.sender);
            if (!win || win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        };
        try {
            const result = await startAuthFlow();
            bringLauncherToFront();
            return result;
        } catch (error) {
            if (error.code === 'CANCELLED') {
                return { cancelled: true };
            }
            log.error(`Error during authentication flow: ${error.message}`);
            bringLauncherToFront();
            return { error: error.message };
        }
    });

    ipcMain.handle('cancel-auth-flow', () => cancelAuthFlow());

    const propertiesHandler = require(path.join(
        projectDir,
        'libs',
        'properties.js'
    ));
    await propertiesHandler(deps);
    const accountLoaderHandler = require(path.join(
        projectDir,
        'libs',
        'accounts-loader.js'
    ));
    await accountLoaderHandler(accountDeps);
    const jarExecutorHandler = require(path.join(
        projectDir,
        'libs',
        'jar-executor.js'
    ));
    const versionCheckedChannels = new Set(['open-client', 'play-no-jagex-account']);
    const versionCheckedIpcMain = new Proxy(ipcMain, {
        get(target, prop) {
            if (prop === 'handle') {
                return (channel, handler) =>
                    target.handle(
                        channel,
                        versionCheckedChannels.has(channel)
                            ? async (event, version, ...rest) => {
                                  if (!isSafeClientVersion(version)) {
                                      return invalidVersionResult(version);
                                  }
                                  try {
                                      await authorizeConfiguredReleaseChannel();
                                      await verifyClientBeforeLaunch(version);
                                  } catch (error) {
                                      log.error(`Client launch integrity check failed: ${error.message}`);
                                      return { error: error.message };
                                  }
                                  return handler(event, version, ...rest);
                              }
                            : handler
                    );
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    await jarExecutorHandler({
        ...accountDeps,
        ipcMain: versionCheckedIpcMain,
        clientReleaseHealth
    });
    const packageVersion = packageJson.version;

    ipcMain.handle('refresh-accounts', async () => {
        try {
            const { writeAccountsToFile } = require(path.join(
                projectDir,
                'libs',
                'oauth-jagex.js'
            ));

            if (!accountRepository.exists()) {
                return { error: 'accounts.json does not exist' };
            }

            let sessionIds = [];
            try {
                sessionIds = accountRepository.listSessionIds();
            } catch (err) {
                log.error('Failed to read accounts.json for refresh:', err.message);
                return { error: 'Failed to read accounts.json' };
            }

            if (sessionIds.length === 0) {
                return { error: 'No Jagex sessions found in accounts.json' };
            }

            let failedSessions = 0;
            for (const sessionId of sessionIds) {
                const status = await writeAccountsToFile(sessionId);
                if (!status || !status.ok) {
                    failedSessions++;
                }
            }
            const warning =
                failedSessions > 0
                    ? `${failedSessions} of ${sessionIds.length} Jagex session(s) could not be refreshed (expired?). Please log in again with those accounts.`
                    : undefined;
            if (failedSessions === sessionIds.length) {
                return { error: warning, failedSessions };
            }

            try {
                const updatedAccounts = accountRepository.listPublicAccounts();
                return { success: true, accounts: updatedAccounts, failedSessions, warning };
            } catch (err) {
                log.error('Failed to read updated accounts.json after refresh:', err.message);
                return { success: true, failedSessions, warning };
            }
        } catch (error) {
            log.error('Error refreshing accounts:', error.message);
            return { error: error.message };
        }
    });

    ipcMain.handle('download-client', async (event, version) => {
        if (!isSafeClientVersion(version)) {
            return invalidVersionResult(version);
        }
        try {
            const filePath = path.join(microbotDir, `microbot-${version}.jar`);
            if (releaseUpdateSettings.enabled) {
                await authorizeConfiguredReleaseChannel();
                const release = await releaseManifestService.fetchCurrent();
                if (release.client.version !== version) {
                    return {
                        error: `Client version ${version} is not the current signed ${releaseUpdateSettings.channel} release`
                    };
                }
                event.sender.send('progress', {
                    percent: 10,
                    status: `Downloading verified client ${version}...`
                });
                let lastReportedDownloadPercent = -1;
                const result = await downloadVerifiedArtifact({
                    httpClient: axios,
                    url: releaseManifestService.resolveArtifactUrl(
                        release.client.artifactPath
                    ),
                    destination: filePath,
                    expectedSize: release.client.size,
                    expectedSha256: release.client.sha256,
                    onProgress: ({ bytes, total }) => {
                        const transferPercent = (bytes * 100) / total;
                        const wholePercent = Math.min(100, Math.floor(transferPercent));
                        if (wholePercent === lastReportedDownloadPercent) return;
                        lastReportedDownloadPercent = wholePercent;
                        event.sender.send('progress', {
                            percent: (10 + transferPercent * 0.8).toFixed(2),
                            status: `Downloading verified client ${version}... (${transferPercent.toFixed(2)}%)`
                        });
                    }
                });
                if (!result.reused) {
                    try {
                        markClientDownloaded(fs, microbotDir, version);
                    } catch (markError) {
                        log.error(
                            `Failed to record downloaded client ${version}: ${markError.message}`
                        );
                    }
                }
                verifiedClientReleaseStore.record(
                    signedClientEntry(release, filePath)
                );
                event.sender.send('progress', {
                    percent: 100,
                    status: 'Verified download completed!'
                });
                return { success: true, path: filePath, verified: true };
            }
            if (
                fs.existsSync(filePath)
            ) {
                return {
                    success: true,
                    path: filePath
                };
            }
            if (!filestorage) {
                return {
                    error:
                        'Client downloads are disabled until a product update endpoint is configured'
                };
            }
            event.sender.send('progress', {
                percent: 90,
                status: 'Downloading Microbot-' + version + ''
            });
            const downloadUrl = `${filestorage}/releases/microbot/stable/microbot-${version}.jar`;
            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'arraybuffer',
                onDownloadProgress: (progressEvent) => {
                    if (progressEvent.total) {
                        const progress = (
                            (progressEvent.loaded * 100) /
                            progressEvent.total
                        ).toFixed(2);
                        // Scale from 10% to 90% for download progress
                        let currentPercent = (10 + progress * 0.8).toFixed(2);
                        event.sender.send('progress', {
                            percent: currentPercent,
                            status: `Downloading client ${version}... (${progress}%)`
                        });
                    } else {
                        // Fallback
                        const downloadedMB = (
                            progressEvent.loaded /
                            (1024 * 1024)
                        ).toFixed(1);
                        event.sender.send('progress', {
                            percent: 50,
                            status: `Downloading client ${version}... (${downloadedMB}MB)`
                        });
                    }
                }
            });
            fs.writeFileSync(filePath, response.data);
            try {
                markClientDownloaded(fs, microbotDir, version);
            } catch (markError) {
                log.error(`Failed to record downloaded client ${version}: ${markError.message}`);
            }
            event.sender.send('progress', {
                percent: 100,
                status: 'Completed!'
            });
            return { success: true, path: filePath };
        } catch (error) {
            log.error(
                `Error downloading client ${version}:`,
                error
            );
            return { error: error.message };
        }
    });

    ipcMain.handle('fetch-launcher-version', async () => {
        if (releaseUpdateSettings.enabled) {
            try {
                await authorizeConfiguredReleaseChannel();
                const launcher = (await releaseManifestService.fetchCurrent()).launcher;
                return launcher ? launcher.version : packageJson.version;
            } catch (error) {
                log.error(`Error fetching signed launcher version: ${error.message}`);
                return { error: error.message };
            }
        }
        if (!url) {
            return packageJson.version;
        }
        try {
            const response = await axios.get(url + '/api/version/launcher');
            return response.data;
        } catch (error) {
            log.error(`Error fetching launcher version: ${error}`);
            return { error: error.message };
        }
    });

    ipcMain.handle('fetch-client-version', async () => {
        if (releaseUpdateSettings.enabled) {
            try {
                await authorizeConfiguredReleaseChannel();
                return (await releaseManifestService.fetchCurrent()).client.version;
            } catch (error) {
                log.error(`Error fetching signed client version: ${error.message}`);
                return { error: error.message };
            }
        }
        if (!url) {
            return productConfig.clientVersion;
        }
        try {
            const response = await axios.get(url + '/api/version/client');
            return response.data;
        } catch (error) {
            log.error(`Error fetching client version: ${error}`);
            return { error: error.message };
        }
    });

    ipcMain.handle('client-exists', async (event, version) => {
        if (!isSafeClientVersion(version)) {
            invalidVersionResult(version);
            return false;
        }
        try {
            const filePath = path.join(microbotDir, `microbot-${version}.jar`);
            log.info(filePath);
            if (!fs.existsSync(filePath)) return false;
            if (!releaseUpdateSettings.enabled) return true;
			await authorizeConfiguredReleaseChannel();

            const registered = verifiedClientReleaseStore.get(version);
            if (registered) {
                assertRegisteredReleaseIsSigned(registered);
                await verifiedClientReleaseStore.verifyFile(registered, filePath);
                return true;
            }
            const release =
                releaseManifestService.getLocallyAccepted() ||
                (await releaseManifestService.fetchCurrent());
            if (release.client.version !== version) return true;
            const entry = signedClientEntry(release, filePath);
            await verifiedClientReleaseStore.verifyFile(entry, filePath);
            verifiedClientReleaseStore.record(entry);
            return true;
        } catch (error) {
            log.error(`Error checking if client exists: ${error}`);
            return false;
        }
    });

    ipcMain.handle('list-jars', async () => {
        try {
            return listClientJars(fs, microbotDir).map((entry) => entry.file);
        } catch (error) {
            log.error(`Unable to scan directory: ${error}`);
            return [];
        }
    });

    ipcMain.handle('list-client-jars', async (event, latestVersion) => {
        try {
            return listClientJars(fs, microbotDir, latestVersion);
        } catch (error) {
            log.error(`Unable to scan directory: ${error}`);
            return [];
        }
    });

    /*
     * Read the profiles from the %USERPROFILE%/.runelite/profiles.json
     * and filter out profiles with negative ID, returning the name strings
     * so that the frontend can populate the profile select element
     */
    ipcMain.handle('list-profiles', async () => {
        const user = process.env.USERPROFILE || process.env.HOME;
        const profilesPath = path.join(
            user,
            '.runelite',
            'microbot-profiles',
            'profiles.json'
        );
        if (fs.existsSync(profilesPath)) {
            try {
                const data = fs.readFileSync(profilesPath, 'utf8');
                const object = JSON.parse(data);
                return object.profiles
                    .filter(
                        (profile) =>
                            profile.id > 0 && profile.name !== 'default'
                    )
                    .map((profile) => profile.name);
            } catch (error) {
                log.error(`Error reading profiles file: ${error}`);
                return { error: error.message };
            }
        } else {
            log.error('Profiles file does not exist');
            return { error: 'Profiles file does not exist' };
        }
    });

    ipcMain.handle('read-non-jagex-profile', async () => {
        const profileFilePath = path.join(
            microbotDir,
            'non-jagex-preferred-profile.json'
        );
        if (fs.existsSync(profileFilePath)) {
            try {
                const data = fs.readFileSync(profileFilePath, 'utf8');
                const profile = JSON.parse(data);
                return profile?.profile;
            } catch (error) {
                log.error(`Error reading non-Jagex profile file: ${error}`);
                return { error: error.message };
            }
        } else {
            log.error('Non-Jagex profile file does not exist');
            return { error: 'Non-Jagex profile file does not exist' };
        }
    });

    ipcMain.handle('launcher-version', async () => {
        return packageVersion;
    });

    ipcMain.handle('log-error', async (event, message) => {
        log.error(message);
    });

    ipcMain.handle('error-alert', async (event, message) => {
        try {
            const result = await dialog.showMessageBox({
                type: 'error',
                title: 'Error',
                message: message
            });
            return result;
        } catch (error) {
            log.error(`Error showing error alert: ${error}`);
            return { error: error.message };
        }
    });

    /**
     * Show a confirmation dialog with the given message and options
     * @param {string} message - The message to display in the dialog
     * @param {string} [defaultTitle="Confirm"] - The title of the dialog
     * @param {string} [yesButton="Yes"] - The text for the "Yes" button
     * @param {string} [noButton="No"] - The text for the "No" button
     */
    ipcMain.handle(
        'show-confirmation-dialog',
        async (
            event,
            message,
            detail,
            defaultTitle = 'Confirm',
            yesButton = 'Yes',
            noButton = 'No',
            options = {}
        ) => {
            try {
                const dialogOptions = {
                    type: options?.type || 'warning',
                    title: defaultTitle,
                    message: message,
                    detail: detail,
                    buttons: [yesButton, noButton],
                    defaultId:
                        typeof options?.defaultId === 'number'
                            ? options.defaultId
                            : 1,
                    cancelId:
                        typeof options?.cancelId === 'number'
                            ? options.cancelId
                            : 1,
                    noLink: false
                };

                const confirmIndex =
                    typeof options?.confirmIndex === 'number'
                        ? options.confirmIndex
                        : 0;

                const result = await dialog.showMessageBox(dialogOptions);
                return result.response === confirmIndex; // Return true if confirm button is clicked
            } catch (error) {
                log.error(`Error showing confirmation dialog: ${error}`);
                return { error: error.message };
            }
        }
    );

    /**
     * Cleans up unused client jar files in the microbotDir that haven't been used
     * in the past 3 days, except for the latest version which is always kept.
     * Uses a JSON file to track the last used timestamps for each version.
     * @param {string} latestVersion - The latest version string to exclude from deletion.
     * @returns {Object} Result object with success status or error message.
     */
    ipcMain.handle(
        'cleanup-unused-clients-jar',
        async (event, latestVersion) => {
            const { cleanupUnusedClientsJar } = require(path.join(
                projectDir,
                'libs',
                'dir-module.js'
            ));
            return await cleanupUnusedClientsJar(latestVersion);
        }
    );

    /**
     * Updates the last used timestamp for a specific client version.
     * @param {string} version - The client version to update.
     * @returns {Object} Result object indicating success or failure.
     */
    ipcMain.handle('update-client-jar-ttl', async (event, version) => {
        const { updateClientJarTTL } = require(path.join(
            projectDir,
            'libs',
            'dir-module.js'
        ));
        return await updateClientJarTTL(version);
    });
};
