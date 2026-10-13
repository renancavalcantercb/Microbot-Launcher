// The two switches that stop the telemetry inherited from the upstream Microbot and RuneLite
// clients (A3-1, categories T1 to T8). Both are needed: the system property covers the
// microbot.cloud calls, the program option covers api.runelite.net telemetry, session and crash
// reporting.
const TELEMETRY_VM_ARG = '-Dmicrobot.disableTelemetry=true';
const TELEMETRY_PROGRAM_ARG = '--disable-telemetry';

// Adds the system property once, replacing any other value of the same property.
function withTelemetryVmArg(vmArgs) {
    const kept = vmArgs.filter(
        (arg) => !String(arg).startsWith('-Dmicrobot.disableTelemetry=')
    );
    return [...kept, TELEMETRY_VM_ARG];
}

module.exports = { TELEMETRY_VM_ARG, TELEMETRY_PROGRAM_ARG, withTelemetryVmArg };
