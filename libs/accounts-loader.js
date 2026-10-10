module.exports = async function (deps) {
    const { fs, path, microbotDir, ipcMain, log, accountRepository } = deps;

    const filePath = path.resolve(microbotDir, 'accounts.json');

    ipcMain.handle('read-accounts', async () => {
        try {
            if (!accountRepository.exists()) {
                log.info('Accounts file does not exist, returning empty array');
                return [];
            }
            return accountRepository.listPublicAccounts();
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });

    ipcMain.handle('remove-accounts', async () => {
        try {
            accountRepository.removeAll();
            return { success: true };
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });

    ipcMain.handle('delete-account', async (event, accountId) => {
        try {
            if (!accountId) {
                return { error: 'Invalid account id' };
            }

            if (!accountRepository.exists()) {
                return { error: 'Accounts file does not exist' };
            }
            if (!accountRepository.deleteAccount(accountId)) {
                return { error: 'Account not found' };
            }
            return { success: true };
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });

    let lastModifiedTime = null;
    let fileExistedLastCheck = fs.existsSync(filePath);

    ipcMain.handle('check-file-change', async () => {
        try {
            let val = false;
            const fileExistsNow = fs.existsSync(filePath);

            // File was deleted
            if (fileExistedLastCheck && !fileExistsNow) {
                log.info('Accounts file was deleted!');
                lastModifiedTime = null;
                fileExistedLastCheck = false;
                return true; // Signal a change occurred
            }

            // File was created
            if (!fileExistedLastCheck && fileExistsNow) {
                log.info('Accounts file was created!');
                const stats = fs.statSync(filePath);
                lastModifiedTime = stats.mtime;
                fileExistedLastCheck = true;
                return true; // Signal a change occurred
            }

            // Check for modifications if file exists
            if (fileExistsNow) {
                const stats = fs.statSync(filePath);
                const modifiedTime = stats.mtime;

                // Check if the modification time has changed
                if (!lastModifiedTime || modifiedTime > lastModifiedTime) {
                    log.info('Accounts file has been modified!');
                    lastModifiedTime = modifiedTime; // Update the last modification time
                    val = true;
                }

                fileExistedLastCheck = true;
            }

            return val;
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });

    /*
     * Handler to write the preferred profile for a non Jagex account
     * A check will be made to see if the file exists, if not, create it
     * We write the selected profile to the file so it can be read later
     * when launching the client
     */
    ipcMain.handle('set-profile-no-jagex', async (event, profile) => {
        try {
            const profileFilePath = path.join(
                microbotDir,
                'non-jagex-preferred-profile.json'
            );
            if (!fs.existsSync(profileFilePath)) {
                fs.writeFileSync(
                    profileFilePath,
                    JSON.stringify({ profile: profile }, null, 2)
                );
                return { success: true, path: profileFilePath };
            }
            fs.writeFileSync(
                profileFilePath,
                JSON.stringify({ profile: profile }, null, 2)
            );
            return { success: true, path: profileFilePath };
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });

    /*
     * Different from set-profile-no-jagex, this one is for Jagex accounts
     * We find the account object in accounts.json that has the same name as the
     * accountID parameter, and set the profile property to that account object
     */
    ipcMain.handle('set-profile-jagex', async (event, accountID, profile) => {
        log.info(
            `Setting profile for Jagex account: ${accountID} to ${profile}`
        );
        try {
            if (!accountRepository.exists()) {
                return { error: 'Accounts file does not exist' };
            }
            if (!accountRepository.setProfile(accountID, profile)) {
                return { error: 'Account not found' };
            }
            return { success: true };
        } catch (error) {
            log.error(error.message);
            return { error: error.message };
        }
    });
};
