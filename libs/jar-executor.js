module.exports = async function (deps) {
    const {
        spawn,
        path,
        dialog,
        shell,
        log,
        fs,
        microbotDir,
        ipcMain,
        clipboard,
        packageJson,
        accountRepository,
        productConfig,
        productSessionService,
        clientLifecycle,
        clientReleaseHealth
    } = deps;
    const os = require('os');
    const javaRuntime = require(path.join(__dirname, 'java-runtime.js'));
    const { ClientTicketBroker } = require(
        path.join(__dirname, 'client-ticket-broker.js')
    );
    const { buildPluginRepositoryVmArgs } = require(
        path.join(__dirname, 'plugin-repository-settings.js')
    );
    const { ProfilePrivacyPolicy } = require(
        path.join(__dirname, 'profile-privacy-policy.js')
    );
    const embeddedRuntimeLib = require(path.join(__dirname, 'embedded-runtime.js'));
    const { TELEMETRY_PROGRAM_ARG, withTelemetryVmArg } = require(
        path.join(__dirname, 'telemetry-flags.js')
    );
    const STARTUP_WINDOW_MS = deps.startupWindowMs || 20000;
    const MAX_CAPTURED_STDERR = 64 * 1024;
    const pluginDevelopmentEnvironmentVariable =
        productConfig?.pluginDevelopmentEnvironmentVariable ||
        'MICROBOT_CUT_PLUGIN_DEV';
    const { isLocked, launchEnvironmentFor } = require(
        path.join(__dirname, 'distribution-profile.js')
    );
    const distributionLocked = isLocked(productConfig);
    // Plugin development mode loads a local jar; a distributed launcher never enables it.
    const pluginDevelopmentMode =
        !distributionLocked &&
        process.env[pluginDevelopmentEnvironmentVariable] === 'true';
    const pluginRepositoryEnabledVariable =
        productConfig?.pluginRepositoryEnvironmentVariables?.enabled ||
        'MICROBOT_CUT_PLUGIN_REPOSITORY_ENABLED';
    const pluginRepository = pluginDevelopmentMode
        ? { enabled: false, args: [] }
        : buildPluginRepositoryVmArgs({ productConfig, log });
    const configuredProductVmArgs = pluginDevelopmentMode
        ? ['-Dmicrobot.plugins.developmentMode=true']
        : [];
    if (pluginDevelopmentMode) {
        const developmentArtifact =
            process.env.MICROBOT_CUT_PLUGIN_DEV_ARTIFACT;
        const developmentArtifactName =
            process.env.MICROBOT_CUT_PLUGIN_DEV_ARTIFACT_NAME;
        if (developmentArtifact && developmentArtifactName) {
            configuredProductVmArgs.push(
                `-Dmicrobot.plugins.developmentArtifact=${developmentArtifact}`,
                `-Dmicrobot.plugins.developmentArtifactName=${developmentArtifactName}`
            );
        }
    }
    configuredProductVmArgs.push(...pluginRepository.args);
    // The client hard-codes ~/.runelite under user.home. A staging launcher runs it with its own
    // home so staging config, caches and plugins never mix with production's.
    const { clientHomeDirectory } = require(path.join(__dirname, 'distribution-profile.js'));
    const clientHome = clientHomeDirectory(
        productConfig,
        deps.productDataDir || microbotDir,
        path
    );
    if (clientHome) {
        fs.mkdirSync(path.join(clientHome, '.runelite'), { recursive: true });
        configuredProductVmArgs.push(`-Duser.home=${clientHome}`);
    }
    // Privacy defaults for the Cut client profiles (B-3.8). Runs before every client start; if it was
    // needed and failed, the client is not started (an older client would use unsafe defaults).
    const runeliteDirectory = path.join(clientHome || os.homedir(), '.runelite');
    const profilePrivacyPolicy =
        deps.profilePrivacyPolicy ||
        new ProfilePrivacyPolicy({
            fs,
            path,
            runeliteDir: runeliteDirectory,
            productDataDir: deps.productDataDir || microbotDir,
            log
        });
    async function enforcePrivacyPolicy(commandArgs) {
        const profileArg = commandArgs.find((arg) => arg.startsWith('-profile='));
        await profilePrivacyPolicy.apply({
            profileName: profileArg ? profileArg.slice('-profile='.length) : null
        });
    }
    async function productVmArgsForLaunch() {
        let selected = [...configuredProductVmArgs];
        if (typeof deps.productVmArgsForLaunch === 'function') {
            const override = await deps.productVmArgsForLaunch({
                configuredArgs: [...configuredProductVmArgs]
            });
            if (Array.isArray(override)) selected = override;
        }
        // Applied after any override so no channel selection can drop it (A3-1, decision 9).
        return withTelemetryVmArg(selected);
    }
    const clientTicketBroker = deps.clientTicketBroker || new ClientTicketBroker({
        productSessionService,
        log,
        fsModule: fs,
        pathModule: path,
        productDataDir: deps.productDataDir || microbotDir,
        secretStore: deps.brokerSecretStore,
        onClientHealthy: ({ releaseVersion }) =>
            clientReleaseHealth?.healthy?.(releaseVersion)
    });
    await clientTicketBroker.ensureStarted?.();

    if (pluginDevelopmentMode) {
        log.warn(
            `Plugin development mode enabled by ${pluginDevelopmentEnvironmentVariable}.`
        );
        if (process.env[pluginRepositoryEnabledVariable] === 'true') {
            log.warn(
                `Plugin repository ignored while ${pluginDevelopmentEnvironmentVariable} is enabled.`
            );
        }
    }

    const cliRamValue = extractRamValue(process.argv);
    const cliMemory = buildMemoryArgsFromRam(cliRamValue, log, '--ram');
    const defaultMemoryConfig =
        cliMemory ?? {
            args: [`-Xms${DEFAULT_XMS_VALUE}`, `-Xmx${DEFAULT_XMX_VALUE}`],
            normalized: DEFAULT_CLIENT_RAM
        };
    const defaultMemorySource = cliMemory
        ? `CLI --ram (${cliMemory.normalized})`
        : `launcher default (${DEFAULT_CLIENT_RAM})`;

    log.info(
        `Configured default client memory (${defaultMemorySource}): ${defaultMemoryConfig.args.join(' ')}`
    );

    function selectMemoryArgs(requestedRam) {
        const rawValue =
            typeof requestedRam === 'string'
                ? requestedRam.trim().toLowerCase()
                : '';
        const override = buildMemoryArgsFromRam(
            rawValue,
            log,
            'client RAM preference'
        );

        if (override) {
            return {
                args: override.args,
                source: `client preference (${override.normalized})`
            };
        }

        return {
            args: [...defaultMemoryConfig.args],
            source: defaultMemorySource
        };
    }

    ipcMain.handle(
        'open-client',
        async (event, version, proxy, accountId, ramPreference) => {
            try {
                const jarPath = path.join(microbotDir, `microbot-${version}.jar`);
                const memoryConfig = selectMemoryArgs(ramPreference);
                const productVmArgs = await productVmArgsForLaunch();
                log.info(
                    `Launching client with ${memoryConfig.source} memory settings: ${memoryConfig.args.join(' ')}`
                );
                const commandArgs = [
                    ...memoryConfig.args,
                    ...GC_FLAGS,
                    ...productVmArgs,
                    '-jar',
                    jarPath,
                    TELEMETRY_PROGRAM_ARG
                ];

                // apply proxy args (done differently depending on client version)
                const err = addProxyArgs(commandArgs, proxy);
                if (err) {
                    log.error(err.message);
                    return { error: err.message };
                }

                let account = null;
                if (accountId) {
                    if (!accountRepository) {
                        return { error: 'Account storage is unavailable' };
                    }
                    account = accountRepository.getAccountForLaunch(accountId);
                    if (!account) {
                        return { error: 'Selected account was not found' };
                    }
                }

                if (account?.profile) {
                    commandArgs.push(`-profile=${account.profile}`);
                }

                if (process.platform === 'darwin') {
                    commandArgs.unshift(
                        '--add-opens=java.desktop/com.apple.eawt=ALL-UNNAMED'
                    );
                    commandArgs.unshift(
                        '--add-opens=java.desktop/sun.awt=ALL-UNNAMED'
                    );
                }

                await enforcePrivacyPolicy(commandArgs);
                const clientAuthorization = await createClientAuthorization(version);
                clientReleaseHealth?.begin?.(version);

                checkJavaAndRunJar(
                    commandArgs,
                    [
                        ...accountSecrets(account),
                        clientAuthorization.ticket,
                        ...clientAuthorization.secrets
                    ],
                    {
                        ...accountLaunchEnvironment(account),
                        ...clientAuthorization.environment
                    },
                    clientAuthorization.release,
                    version
                );
                return { success: true };
            } catch (error) {
                log.error(error.message);
                return { error: error.message };
            }
        }
    );

    ipcMain.handle(
        'play-no-jagex-account',
        async (event, version, proxy, ramPreference) => {
            const productVmArgs = await productVmArgsForLaunch();
            const jarPath = path.join(microbotDir, `microbot-${version}.jar`);
            const memoryConfig = selectMemoryArgs(ramPreference);
            log.info(
                `Launching non-Jagex client with ${memoryConfig.source} memory settings: ${memoryConfig.args.join(' ')}`
            );
            const commandArgs = [
                ...memoryConfig.args,
                ...GC_FLAGS,
                ...productVmArgs,
                '-jar',
                jarPath,
                TELEMETRY_PROGRAM_ARG,
                '-clean-jagex-launcher'
            ];

            // apply proxy args (done differently depending on client version)
            const err = addProxyArgs(commandArgs, proxy);
            if (err) {
                log.error(err.message);
                return { error: err.message };
            }

            if (
                fs.existsSync(
                    path.join(microbotDir, 'non-jagex-preferred-profile.json')
                )
            ) {
                try {
                    const profileData = JSON.parse(
                        fs.readFileSync(
                            path.join(
                                microbotDir,
                                'non-jagex-preferred-profile.json'
                            ),
                            'utf8'
                        )
                    );
                    if (profileData?.profile && profileData.profile !== 'default') {
                        commandArgs.push(`-profile=${profileData.profile}`);
                    }
                } catch (error) {
                    log.error(
                        'Invalid non-jagex-preferred-profile.json:',
                        error.message
                    );
                }
            }
            if (process.platform === 'darwin') {
                commandArgs.unshift(
                    '--add-opens=java.desktop/com.apple.eawt=ALL-UNNAMED'
                );
                commandArgs.unshift(
                    '--add-opens=java.desktop/sun.awt=ALL-UNNAMED'
                );
            }

            try {
                await enforcePrivacyPolicy(commandArgs);
            } catch (error) {
                log.error(`Client not started: ${error.message}`);
                return { error: error.message };
            }

            try {
                const clientAuthorization = await createClientAuthorization(version);
                clientReleaseHealth?.begin?.(version);
                checkJavaAndRunJar(
                    commandArgs,
                    [clientAuthorization.ticket, ...clientAuthorization.secrets],
                    clientAuthorization.environment,
                    clientAuthorization.release,
                    version
                );
            } catch (error) {
                log.error(`Client authorization failed: ${error.message}`);
                return { error: 'The client could not be authorized. Reconnect your Microbot Cut account.' };
            }
            return { success: true };
        }
    );

    async function createClientAuthorization(version) {
        if (!productSessionService) {
            throw new Error('Product session service is unavailable');
        }
        const authorization = await productSessionService.createClientTicket();
        const brokerGrant = await clientTicketBroker.createGrant({ releaseVersion: version });
        return {
            ticket: authorization.ticket,
            secrets: brokerGrant.secrets,
            release: brokerGrant.release,
            environment: {
                MICROBOT_CUT_CLIENT_TICKET: authorization.ticket,
                MICROBOT_CUT_PRODUCT_API_BASE_URL: authorization.apiBaseUrl,
                MICROBOT_CUT_CLIENT_TICKET_KEY_ID: authorization.keyId,
                MICROBOT_CUT_CLIENT_TICKET_AUDIENCE: authorization.audience,
                ...brokerGrant.environment
            }
        };
    }

    // Java runtime resolution (B-3.2). A distributed launcher runs only the runtime embedded in
    // its installer, verified against the pin in its profile; if that fails the client is not
    // started and the system Java is never used. A development checkout uses the Java on PATH.
    function resolveEmbeddedRuntime() {
        if (!distributionLocked) return null;
        const pin = productConfig?.distribution?.embeddedRuntime;
        if (!pin) {
            throw new embeddedRuntimeLib.RuntimeIntegrityError(
                'this launcher build has no embedded Java runtime configured'
            );
        }
        const runtimeDir =
            deps.embeddedRuntimeDirectory || path.join(process.resourcesPath || '', pin.directory);
        const verified = embeddedRuntimeLib.verifyEmbeddedRuntime({
            fs,
            path,
            runtimeDir,
            expected: { javaVersion: pin.javaVersion, imageSha256: pin.imageSha256 }
        });
        const bin = path.join(runtimeDir, 'bin');
        return {
            runtimeDir,
            verified,
            probeExecutable: path.join(bin, process.platform === 'win32' ? 'java.exe' : 'java'),
            launchExecutable: path.join(bin, process.platform === 'win32' ? 'javaw.exe' : 'java')
        };
    }

    // The Java child never inherits options that load agents or change the JVM from the
    // environment. Only the child's environment is built without them.
    function javaChildEnvironment(environment) {
        const { environment: clean, removed } = embeddedRuntimeLib.sanitizeJavaEnvironment(environment);
        if (removed.length > 0) {
            log.warn(`Java environment options were not passed to the client: ${removed.join(', ')}`);
        }
        return clean;
    }

    function runtimeProblem(error) {
        return {
            kind: 'runtime-integrity',
            title: 'Java Runtime Damaged',
            message: error.message,
            recovery: 'Reinstall Microbot Cut Launcher. The client was not started and no other Java is used.',
            offerDownload: false
        };
    }

    function probeJava(callback, embedded = null) {
        let called = false;
        let timeoutHandle = null;
        const finish = (result) => {
            if (called) return;
            called = true;
            clearTimeout(timeoutHandle);
            callback(result);
        };

        try {
            const javaProcess = embedded
                ? spawn(embedded.probeExecutable, javaRuntime.PROBE_ARGS, {
                      env: javaChildEnvironment({ ...launchEnvironmentFor(productConfig, process.env) }),
                      windowsHide: true
                  })
                : spawn('java', javaRuntime.PROBE_ARGS, {
                      env: javaChildEnvironment({ ...process.env }),
                      windowsHide: true
                  });
            let output = '';
            const TIMEOUT_MS = 5000;

            timeoutHandle = setTimeout(() => {
                log.info(
                    `Java version check timed out after ${TIMEOUT_MS}ms – killing process`
                );
                try {
                    javaProcess.kill();
                } catch (_) {
                    /* ignore */
                }
                finish({ problem: javaRuntime.classifyProbeFailure({ timedOut: true }) });
            }, TIMEOUT_MS);

            const collect = (data) => {
                if (output.length < MAX_CAPTURED_STDERR) output += data.toString();
            };
            for (const stream of [javaProcess.stdout, javaProcess.stderr]) {
                if (!stream) continue;
                if (stream.setEncoding) stream.setEncoding('utf8');
                stream.on('data', collect);
            }

            javaProcess.on('error', (err) => {
                finish({ problem: javaRuntime.classifyProbeFailure({ error: err }) });
            });

            javaProcess.on('close', (code) => {
                if (code === 0) {
                    finish({ runtime: javaRuntime.parseJavaSettings(output) });
                } else {
                    finish({
                        problem: javaRuntime.classifyProbeFailure({ code, stderr: output })
                    });
                }
            });
        } catch (error) {
            finish({ problem: javaRuntime.classifyProbeFailure({ error }) });
        }
    }

    /**
     * Adds proxy arguments to the commandArgs array.
     * Since version >= 1.9.9.2 we only support SOCKS proxies in the following form: scheme://[user:pass@]host:port
     * Accepted legacy input formats (proxy.proxyIp):
     *   ip:port
     *   ip:port:user:pass (password may contain colons; extra segments are joined back for password)
     *   scheme://user:pass@host:port (already formatted; passed through unchanged)
     * We do not push -proxy-type for new versions.
     *
     * @param {string[]} commandArgs - The command arguments array.
     * @param {Object} proxy - The proxy configuration object.
     * @returns {Error|null} - Returns an error if the proxy configuration is invalid, otherwise null.
     */
    function addProxyArgs(commandArgs, proxy) {
        if (!proxy || !proxy.proxyIp) return null;
        if (typeof proxy.proxyIp !== 'string') return null;
        if (proxy.proxyIp.trim() === '') return null;

        try {
            let raw = proxy.proxyIp.trim();
            // if user already supplied in URI format, just use it.
            if (raw.includes('://')) {
                commandArgs.push(`-proxy=${raw}`);
                return null;
            }

            const DEFAULT_SCHEME = 'socks5';
            const parts = raw.split(':');

            if (parts.length === 2) {
                const [host, port] = parts;
                commandArgs.push(`-proxy=${DEFAULT_SCHEME}://${host}:${port}`);
            } else if (parts.length >= 4) {
                const host = parts[0];
                const port = parts[1];
                const user = parts[2];
                const pass = parts.slice(3).join(':'); // allow colons in password
                // encode user and pass (without encoding things may break)
                const encUser = encodeURIComponent(user);
                const encPass = encodeURIComponent(pass);
                commandArgs.push(
                    `-proxy=${DEFAULT_SCHEME}://${encUser}:${encPass}@${host}:${port}`
                );
            } else {
                // fallback: just attach whatever (may be just host)
                commandArgs.push(`-proxy=${DEFAULT_SCHEME}://${raw}`);
            }
        } catch (err) {
            return new Error(
                'Failed to construct new proxy URI: ' + err.message
            );
        }
        return null;
    }

    /**
     * Redacts sensitive information from command line arguments.
     * @param {string[]} args - The command line arguments.
     * @returns {string[]} - The redacted command line arguments.
     */
    function redactCommandArgs(args) {
        return args.map((a) => {
            if (a.startsWith('-Dmicrobot.plugins.publicKey=')) {
                return '-Dmicrobot.plugins.publicKey=<configured>';
            }
            if (!a.startsWith('-proxy=')) return a;
            const value = a.slice('-proxy='.length);
            try {
                const u = new URL(value);
                if (u.username || u.password) {
                    if (u.username) u.username = '***';
                    if (u.password) u.password = '***';
                    return `-proxy=${u.toString()}`;
                }
            } catch (_) {
                // fallback: strip credentials if present
                return `-proxy=${value.replace(/\/\/[^@]*@/, '//***@')}`;
            }
            return a;
        });
    }

    function homeDirectories() {
        const homes = [os.homedir()];
        try {
            homes.push(os.userInfo().homedir);
        } catch (_) {}
        return homes;
    }

    function accountSecrets(account) {
        if (!account) return [];
        return [
            account.displayName,
            account.accountId,
            account.profile,
            account.sessionId
        ].filter(
            (value) => typeof value === 'string' && value !== 'Not set' && value !== 'default'
        );
    }

    function accountLaunchEnvironment(account) {
        if (!account) return {};

        const values = {
            JX_CHARACTER_ID: account.accountId,
            JX_SESSION_ID: account.sessionId,
            JX_REFRESH_TOKEN: '',
            JX_DISPLAY_NAME: account.displayName || '',
            JX_ACCESS_TOKEN: ''
        };

        for (const [name, value] of Object.entries(values)) {
            if (typeof value !== 'string' || value.includes('\0')) {
                throw new Error(`Invalid Jagex launch value for ${name}`);
            }
        }
        if (!values.JX_CHARACTER_ID || !values.JX_SESSION_ID) {
            throw new Error('The selected account has incomplete Jagex credentials');
        }

        return values;
    }

    function showLaunchProblem(problem, { runtime, executable, stderr, secrets } = {}) {
        const details = javaRuntime.formatProblemDetails({
            problem,
            runtime,
            executable,
            stderr,
            launcherVersion: packageJson && packageJson.version,
            platform: process.platform,
            arch: process.arch,
            homeDir: homeDirectories(),
            secrets
        });
        log.error(`[launch problem]\n${details}`);
        if (!dialog) return;

        const buttons = [];
        if (problem.offerDownload) buttons.push('Yes, Download JDK');
        if (clipboard) buttons.push('Copy details');
        buttons.push('Cancel');

        dialog
            .showMessageBox({
                type: 'error',
                title: problem.title,
                message: problem.message,
                detail: details,
                buttons,
                defaultId: 0,
                cancelId: buttons.length - 1
            })
            .then((result) => {
                const choice = buttons[result.response];
                if (choice === 'Yes, Download JDK') {
                    shell.openExternal(
                        javaRuntime.javaDownloadUrl(process.platform, process.arch)
                    );
                } else if (choice === 'Copy details') {
                    clipboard.writeText(details);
                } else {
                    log.info('User dismissed the launch problem dialog.');
                }
            })
            .catch((err) => log.error(`Failed to show launch problem: ${err.message}`));
    }

    function executeJar(
        executable,
        commandArgs,
        runtime,
        secrets,
        launchEnvironment,
        releaseAuthorization = () => {},
        launchId = null,
        releaseVersion = null
    ) {
        log.info(`${executable} ${redactCommandArgs(commandArgs).join(' ')}`);

        /**
         * Additional arguments for spawn library.
         * With those arguments, we detach clients from the launcher,
         * guaranteeing that they will continue to run when the launcher is closed.
         * If not in debug mode, we use windowsHide to attempt suppressing the console window,
         * ignore stdout, and only read stderr during startup to explain launch failures.
         */
        let extraArgs = {};
        if (!process.env.DEBUG)
            extraArgs = { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true };

        const startedAt = Date.now();
        let stderrData = '';
        let reported = false;
        let jarProcess = null;

        const report = (problem) => {
            if (reported) return;
            reported = true;
            showLaunchProblem(problem, { runtime, executable, stderr: stderrData, secrets });
        };

        try {
            jarProcess = spawn(executable, commandArgs, {
                detached: true,
                env: javaChildEnvironment({
                    ...launchEnvironmentFor(productConfig, process.env),
                    ...launchEnvironment
                }),
                ...extraArgs
            });
            clientLifecycle?.markStarted?.(launchId, jarProcess.pid);

            /**
             * We only pipe stdout when debugging, to avoid flooding the
             * launcher log with client output as the client manages its own
             * logging.
             */
            if (process.env.DEBUG && jarProcess.stdout) {
                jarProcess.stdout.on('data', (data) => {
                    log.info(`[stdout] ${javaRuntime.redactText(data.toString(), { secrets })}`);
                });
            }
            if (jarProcess.stderr) {
                if (jarProcess.stderr.setEncoding) jarProcess.stderr.setEncoding('utf8');
                jarProcess.stderr.on('data', (data) => {
                    if (process.env.DEBUG) {
                        log.info(`[stderr] ${javaRuntime.redactText(data.toString(), { secrets })}`);
                    }
                    stderrData += data.toString();
                    if (stderrData.length > MAX_CAPTURED_STDERR) {
                        stderrData = stderrData.slice(-MAX_CAPTURED_STDERR);
                    }
                });
                jarProcess.stderr.on('error', () => {});
            }

            const startupTimer = setTimeout(() => {
                if (!process.env.DEBUG && jarProcess.stderr) {
                    jarProcess.stderr.destroy();
                }
            }, STARTUP_WINDOW_MS);
            if (startupTimer.unref) startupTimer.unref();

            /**
             * Allow the parent (launcher) to exit independently of the spawned client.
             * Found in the Node.js documentation: https://nodejs.org/api/child_process.html#optionsdetached
             */
            try {
                jarProcess.unref();
            } catch (_) {
                /* ignore */
            }

            jarProcess.on('error', (err) => {
                clientLifecycle?.markFailed?.(launchId);
                clientReleaseHealth?.fail?.(releaseVersion, `client process error: ${err.message}`);
                releaseAuthorization();
                log.error(`[error] ${err.message}`);
                clearTimeout(startupTimer);
                report(javaRuntime.classifyLaunchFailure({ error: err }));
            });

            jarProcess.on('close', (code, signal) => {
                clientLifecycle?.markStopped?.(launchId);
                releaseAuthorization();
                clearTimeout(startupTimer);
                const elapsed = Date.now() - startedAt;
                log.info(`JAR exited with code ${code} after ${elapsed}ms`);
                if (elapsed <= STARTUP_WINDOW_MS && code !== 0) {
                    clientReleaseHealth?.fail?.(
                        releaseVersion,
                        `client exited during startup with code ${code}`
                    );
                    report(javaRuntime.classifyLaunchFailure({ code, signal, stderr: stderrData }));
                }
            });
        } catch (error) {
            clientLifecycle?.markFailed?.(launchId);
            clientReleaseHealth?.fail?.(releaseVersion, `client process error: ${error.message}`);
            releaseAuthorization();
            log.error(`[error] ${error.message}`);
            report(javaRuntime.classifyLaunchFailure({ error }));
        }
    }

    function checkJavaAndRunJar(commandArgs, secrets = [], launchEnvironment = {}, releaseAuthorization = () => {}, releaseVersion = null) {
        const launchId = clientLifecycle?.beginLaunch?.() ?? null;
        let embedded = null;
        try {
            embedded = resolveEmbeddedRuntime();
            if (embedded) {
                log.info(
                    `Embedded Java runtime verified: ${embedded.verified.javaVersion}, ${embedded.verified.files} files.`
                );
            }
        } catch (error) {
            if (!(error instanceof embeddedRuntimeLib.RuntimeIntegrityError)) throw error;
            clientLifecycle?.markFailed?.(launchId);
            clientReleaseHealth?.fail?.(releaseVersion, 'embedded Java runtime failed verification');
            releaseAuthorization();
            showLaunchProblem(runtimeProblem(error), { stderr: '', secrets });
            return;
        }
        probeJava(({ runtime, problem }) => {
            if (problem) {
                clientLifecycle?.markFailed?.(launchId);
                clientReleaseHealth?.fail?.(releaseVersion, 'compatible Java runtime was not found');
                releaseAuthorization();
                showLaunchProblem(problem, { stderr: problem.stderr, secrets });
                return;
            }

            log.info(`Selected Java runtime: ${javaRuntime.describeRuntime(runtime)} at ${runtime.home || 'unknown home'}`);
            const evaluation = javaRuntime.evaluateRuntime(runtime, {
                heapMb: javaRuntime.heapMbFromArgs(commandArgs)
            });
            evaluation.warnings.forEach((warning) => log.warn(warning.message));
            if (!evaluation.compatible) {
                clientLifecycle?.markFailed?.(launchId);
                clientReleaseHealth?.fail?.(releaseVersion, 'configured Java runtime is incompatible');
                releaseAuthorization();
                showLaunchProblem(
                    {
                        kind: 'incompatible-java',
                        title: 'Incompatible Java',
                        message: evaluation.problems.map((p) => p.message).join(' '),
                        recovery: evaluation.problems.map((p) => p.recovery).join(' '),
                        offerDownload: true
                    },
                    { runtime, secrets }
                );
                return;
            }

            const launchArgs = javaRuntime.supportedVmArgs(runtime, commandArgs);
            if (!javaRuntime.supportsZgc(runtime)) {
                log.info(`${javaRuntime.describeRuntime(runtime)} cannot use ZGC; launching without ZGC flags.`);
            }
            if (embedded) {
                const reported = String(runtime.home || '');
                const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
                if (!reported || !same(reported, embedded.runtimeDir)) {
                    clientLifecycle?.markFailed?.(launchId);
                    clientReleaseHealth?.fail?.(releaseVersion, 'embedded Java runtime reported an unexpected home');
                    releaseAuthorization();
                    showLaunchProblem(
                        runtimeProblem(new Error('The embedded Java runtime reported an unexpected location.')),
                        { runtime, secrets }
                    );
                    return;
                }
            }
            const executable = embedded
                ? embedded.launchExecutable
                : javaRuntime.launcherExecutable(runtime, process.platform, fs.existsSync);
            log.info('Java runtime is compatible, running the JAR...');
            executeJar(
                executable,
                launchArgs,
                runtime,
                secrets,
                launchEnvironment,
                releaseAuthorization,
                launchId,
                releaseVersion
            );
        }, embedded);
    }

    return { probeJava, checkJavaAndRunJar, showLaunchProblem };
};

const DEFAULT_XMS_VALUE = '512m';
const DEFAULT_XMX_VALUE = '600m';  // reduced from 1g — ZGC makes this safe to lower
const DEFAULT_CLIENT_RAM = DEFAULT_XMX_VALUE;

/**
 * GC flags injected into every client launch.
 *
 * -XX:+UseZGC
 *   Switch from G1GC to ZGC. G1GC holds committed heap pages indefinitely
 *   even when they contain only dead objects. ZGC is designed to return
 *   unused pages to the OS, so Task Manager reflects actual usage rather
 *   than the worst-case watermark.
 *
 * -XX:SoftMaxHeapSize=500m
 *   ZGC targets staying under 500 MB before expanding toward Xmx.
 *   Acts as a soft pressure valve — heap grows to 600m only under real load.
 *
 * -XX:+ZUncommit
 *   Enables ZGC's page uncommit feature. Without this flag ZGC still uses
 *   less memory than G1GC but won't actively shrink the committed footprint.
 *
 * -XX:ZUncommitDelay=30
 *   Pages idle for 30 seconds are returned to the OS. Lower values free
 *   memory faster; higher values reduce the cost of re-faulting pages back
 *   in after a brief spike.
 *
 * -XX:+UseStringDedup
 *   Deduplicates identical String objects across the heap. OSRS item names,
 *   NPC names, and chat messages frequently share the same content; this
 *   removes redundant copies automatically.
 *
 * -Xss512k
 *   Halves the per-thread stack from the default 1 MB. Microbot creates
 *   many script threads; 512 KB is ample for the call depths used.
 *
 * -XX:+IgnoreUnrecognizedVMOptions
 *   Prevents a crash if the bundled JRE is older than Java 15 and doesn't
 *   recognise ZGC flags — the client starts normally, just without the GC
 *   optimisations.
 */
const GC_FLAGS = [
    '-XX:+UseZGC',
    '-XX:SoftMaxHeapSize=500m',
    '-XX:+ZUncommit',
    '-XX:ZUncommitDelay=30',
    '-XX:+UseStringDedup',
    '-Xss512k',
    '-XX:+IgnoreUnrecognizedVMOptions',
];

function buildMemoryArgsFromRam(ramValue, log, contextLabel) {
    if (!ramValue || typeof ramValue !== 'string') {
        return null;
    }

    const parsed = normalizeRamValue(ramValue);
    if (!parsed) {
        if (contextLabel) {
            log.warn(
                `Invalid ${contextLabel} value "${ramValue}". Falling back to default memory settings.`
            );
        }
        return null;
    }

    return {
        args: [`-Xms${parsed.normalized}`, `-Xmx${parsed.normalized}`],
        normalized: parsed.normalized
    };
}

function extractRamValue(argv) {
    if (!Array.isArray(argv)) return null;

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (typeof arg !== 'string') continue;

        if (arg === '--ram') {
            return argv[i + 1];
        }

        if (arg.startsWith('--ram=')) {
            return arg.slice('--ram='.length);
        }
    }

    return null;
}

function normalizeRamValue(value) {
    if (!value || typeof value !== 'string') return null;

    const trimmed = value.trim().toLowerCase();
    const match = trimmed.match(/^(\d+(?:\.\d+)?)([mg])$/);
    if (!match) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const unit = match[2];
    const mb = unit === 'g' ? amount * 1024 : amount;

    return { normalized: `${amount}${unit}`, mb };
}
