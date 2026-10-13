const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

// L3-1 (B-3.4). These tests run the PowerShell commands that build/installer.nsh runs, extracted
// from the file itself. They NEVER stop a process: VALIDATE and SELECT only read, and STOP is
// always run with CUT_DRYRUN=1, which prints what it would stop. The decoys are copies of
// ping.exe that exit on their own.

const nshPath = path.join(__dirname, '..', 'build', 'installer.nsh');
const nsh = fs.readFileSync(nshPath, 'utf8');

function command(name) {
    const match = new RegExp(`^!define CUT_PS_${name} \`(.*)\`\\s*$`, 'm').exec(nsh);
    if (!match) throw new Error(`CUT_PS_${name} not found in installer.nsh`);
    return match[1].replace(/\$\$/g, '$');
}

const isWindows = process.platform === 'win32';
const windowsDescribe = isWindows ? describe : describe.skip;

function powershell(commandText, env) {
    const result = childProcess.spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', commandText],
        { encoding: 'utf8', env: { ...process.env, ...env } }
    );
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

describe('installer.nsh structure', () => {
    test('each command fits the 1024 character NSIS string limit, with its wrapper', () => {
        for (const name of ['VALIDATE', 'SELECT', 'STOP']) {
            const body = new RegExp(`^!define CUT_PS_${name} \`(.*)\``, 'm').exec(nsh)[1];
            const wrapped = `nsExec::Exec \`"$PowerShellPath" -NoProfile -NonInteractive -C "${body}"\``;
            expect(wrapped.length).toBeLessThan(1000);
        }
    });

    test('selection compares the exact directory, never a prefix of $INSTDIR', () => {
        const select = command('SELECT');
        expect(select).toContain('GetDirectoryName');
        expect(select).toContain('-contains');
        expect(select).not.toMatch(/StartsWith\(\s*'?\$i/i);
        expect(command('STOP')).toContain('GetDirectoryName');
        expect(nsh).not.toMatch(/\.StartsWith\(\s*'\$INSTDIR/);
    });

    test('selection and stopping are separate steps, and only STOP can stop anything', () => {
        expect(command('SELECT')).not.toMatch(/Stop-Process|taskkill|Terminate/i);
        expect(command('VALIDATE')).not.toMatch(/Stop-Process|taskkill|Terminate/i);
        expect(command('STOP')).toMatch(/Stop-Process/);
        expect(command('STOP')).toContain('CUT_DRYRUN');
        // no other place in the include stops processes
        const outsideStop = nsh.replace(/^!define CUT_PS_STOP .*$/m, '');
        expect(outsideStop).not.toMatch(/Stop-Process|taskkill/i);
    });

    test('the macro never stops anything after a refusal or without PowerShell', () => {
        const macro = nsh.slice(nsh.indexOf('!macro customCheckAppRunning'));
        expect(macro.indexOf('CUT_VALIDATE')).toBeLessThan(macro.indexOf('CUT_STOP'));
        expect(macro).toContain('${elseIf} $R0 != 2');
        const fallback = macro.slice(macro.indexOf('${elseIf} $R0 != 2'));
        expect(fallback).not.toContain('CUT_STOP');
    });
});

windowsDescribe('VALIDATE refuses anything that is not a real install of the app', () => {
    let root;
    let valid;
    const EXE = 'Microbot Cut Launcher.exe';

    beforeAll(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-validate-'));
        valid = path.join(root, 'Programs', 'Microbot Cut Launcher');
        fs.mkdirSync(valid, { recursive: true });
        fs.writeFileSync(path.join(valid, EXE), 'x');
        fs.mkdirSync(path.join(root, 'Programs', 'No Exe Here'), { recursive: true });
    });

    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    const validate = (instdir, appexe = EXE) =>
        powershell(command('VALIDATE'), { CUT_INSTDIR: instdir, CUT_APPEXE: appexe }).status;

    test('accepts a canonical, deep directory that holds the executable', () => {
        expect(validate(valid)).toBe(0);
    });

    test.each([
        ['empty', () => ''],
        ['relative', () => 'Programs\\Microbot Cut Launcher'],
        ['relative with a drive', () => 'C:Programs\\Microbot Cut Launcher'],
        ['non-canonical (..)', () => `${valid}\\..\\Microbot Cut Launcher`],
        ['with a trailing backslash', () => `${valid}\\`],
        ['a drive root', () => 'C:\\'],
        ['too shallow', () => 'C:\\Microbot Cut Launcher'],
        ['the Windows directory', () => process.env.SystemRoot],
        ['inside the Windows directory', () => `${process.env.SystemRoot}\\System32\\Microbot Cut Launcher`],
        ['Program Files itself', () => process.env.ProgramFiles],
        ['the user profile', () => process.env.USERPROFILE],
        ['LocalAppData itself', () => process.env.LOCALAPPDATA],
        ['a directory without the executable', () => path.join(root, 'Programs', 'No Exe Here')],
        ['a directory that does not exist', () => path.join(root, 'Programs', 'Missing Dir')]
    ])('refuses %s', (_label, instdir) => {
        expect(validate(instdir())).toBe(2);
    });

    test('refuses when the executable name is missing', () => {
        expect(validate(valid, '')).toBe(2);
    });
});

windowsDescribe('SELECT and STOP (dry run) pick exactly the processes of one install', () => {
    let root;
    let prod;
    let staging;
    let pids;
    const decoys = [];
    const ping = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'PING.EXE');

    function startDecoy(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(ping, file);
        const child = childProcess.spawn(file, ['-n', '25', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
        child.unref();
        decoys.push(child);
        return child.pid;
    }

    beforeAll(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-select-'));
        prod = path.join(root, 'Programs', 'Microbot Cut Launcher');
        staging = path.join(root, 'Programs', 'Microbot Cut Launcher Staging');
        pids = {
            prodLauncher: startDecoy(path.join(prod, 'Microbot Cut Launcher.exe')),
            prodJava: startDecoy(path.join(prod, 'resources', 'java-runtime', 'bin', 'javaw.exe')),
            prodOther: startDecoy(path.join(prod, 'resources', 'other', 'tool.exe')),
            prodDeeperJava: startDecoy(path.join(prod, 'resources', 'java-runtime', 'bin', 'sub', 'x.exe')),
            staging: startDecoy(path.join(staging, 'Microbot Cut Launcher Staging.exe')),
            stagingJava: startDecoy(path.join(staging, 'resources', 'java-runtime', 'bin', 'javaw.exe'))
        };
        await new Promise((resolve) => setTimeout(resolve, 1200));
    });

    afterAll(() => {
        // The decoys exit by themselves; nothing is stopped here.
        fs.rmSync(path.join(root, 'selection.txt'), { force: true });
    });

    function select(instdir) {
        const selfile = path.join(root, 'selection.txt');
        fs.rmSync(selfile, { force: true });
        const result = powershell(command('SELECT'), { CUT_INSTDIR: instdir, CUT_SELFILE: selfile });
        const lines = fs.existsSync(selfile)
            ? fs.readFileSync(selfile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
            : [];
        return {
            status: result.status,
            selected: lines.map((line) => {
                const [pid, file] = line.split('\t');
                return { pid: Number(pid), file };
            }),
            selfile
        };
    }

    test('production: its launcher and its embedded Java, and nothing else', () => {
        const result = select(prod);
        expect(result.status).toBe(0);
        expect(result.selected.map((entry) => entry.pid).sort()).toEqual(
            [pids.prodLauncher, pids.prodJava].sort()
        );
        for (const entry of result.selected) {
            expect(path.dirname(entry.file).toLowerCase().startsWith(prod.toLowerCase())).toBe(true);
        }
    });

    test('the staging launcher is never selected by the production directory (L3-1)', () => {
        const result = select(prod);
        const selectedPids = result.selected.map((entry) => entry.pid);
        expect(selectedPids).not.toContain(pids.staging);
        expect(selectedPids).not.toContain(pids.stagingJava);
    });

    test('a process in another folder of the install, or deeper than the java bin folder, is not selected', () => {
        const selectedPids = select(prod).selected.map((entry) => entry.pid);
        expect(selectedPids).not.toContain(pids.prodOther);
        expect(selectedPids).not.toContain(pids.prodDeeperJava);
    });

    test('staging selects only staging', () => {
        const result = select(staging);
        expect(result.selected.map((entry) => entry.pid).sort()).toEqual(
            [pids.staging, pids.stagingJava].sort()
        );
    });

    test('the match ignores letter case of the directory', () => {
        const result = select(prod.toUpperCase());
        expect(result.selected.map((entry) => entry.pid)).toContain(pids.prodLauncher);
    });

    test('an install with nothing running selects nothing', () => {
        const empty = path.join(root, 'Programs', 'Idle Install');
        fs.mkdirSync(empty, { recursive: true });
        const result = select(empty);
        expect(result.status).toBe(1);
        expect(result.selected).toEqual([]);
    });

    test.each([
        ['an empty directory', ''],
        ['a drive root', 'C:\\'],
        ['a relative path', 'Programs']
    ])('even if validation were skipped, %s selects nothing', (_label, instdir) => {
        const result = select(instdir);
        expect(result.selected).toEqual([]);
        expect([1, 2]).toContain(result.status);
    });

    test('a directory that is not an install of the app (such as the one holding node.exe) fails VALIDATE, so it is never selected', () => {
        const status = powershell(command('VALIDATE'), {
            CUT_INSTDIR: path.dirname(process.execPath),
            CUT_APPEXE: 'Microbot Cut Launcher.exe'
        }).status;
        expect(status).toBe(2);
    });

    function stopDry(instdir, selectionFile) {
        return powershell(command('STOP'), {
            CUT_INSTDIR: instdir,
            CUT_SELFILE: selectionFile,
            CUT_DRYRUN: '1'
        });
    }

    test('STOP (dry run) reports exactly the selected processes and stops none', () => {
        const result = select(prod);
        const dry = stopDry(prod, result.selfile);
        expect(dry.status).toBe(0);
        const lines = dry.stdout.split(/\r?\n/).filter(Boolean);
        expect(lines).toHaveLength(2);
        for (const entry of result.selected) {
            expect(lines.some((line) => line.startsWith(`would stop ${entry.pid} `))).toBe(true);
        }
        // every decoy is still alive (checked by reading, with Get-Process)
        const alive = powershell(
            `(Get-Process -Id ${Object.values(pids).join(',')} -ErrorAction SilentlyContinue).Count`
        );
        expect(Number(alive.stdout.trim())).toBe(Object.values(pids).length);
    });

    test('STOP re-checks every entry: a forged or stale list stops nothing outside the install', () => {
        const result = select(prod);
        const forged = [
            ...result.selected.map((entry) => `${entry.pid}\t${entry.file}`),
            `${process.pid}\t${process.execPath}`,
            `${pids.staging}\t${path.join(staging, 'Microbot Cut Launcher Staging.exe')}`,
            `${pids.prodLauncher}\t${path.join(prod, 'Other Name.exe')}`,
            `4\tC:\\Windows\\System32\\ntoskrnl.exe`,
            'not-a-pid\tC:\\x.exe',
            'garbage line without a tab'
        ];
        fs.writeFileSync(result.selfile, forged.join('\r\n'));
        const dry = stopDry(prod, result.selfile);
        const lines = dry.stdout.split(/\r?\n/).filter(Boolean);
        expect(lines).toHaveLength(2);
        expect(dry.stdout).not.toContain(String(process.pid));
        expect(dry.stdout).not.toContain('Staging');
        expect(dry.stdout).not.toContain('ntoskrnl');
    });

    test('more than 25 matching processes is a refusal that selects nothing', () => {
        const crowded = path.join(root, 'Programs', 'Crowded Install');
        for (let index = 0; index < 26; index += 1) {
            startDecoy(path.join(crowded, `app${index}.exe`));
        }
        const result = select(crowded);
        expect(result.status).toBe(2);
    }, 30000);
});
