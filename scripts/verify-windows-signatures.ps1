param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedPublisher
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
$installerFiles = @(Get-ChildItem -LiteralPath $resolvedOutput -File -Filter '*.exe')
$applicationFiles = @(Get-ChildItem -LiteralPath $resolvedOutput -Recurse -File -Filter 'Microbot Cut Launcher.exe')
$targets = @($installerFiles + $applicationFiles | Sort-Object -Property FullName -Unique)

if ($installerFiles.Count -eq 0) {
    throw "No Windows installer was produced in $resolvedOutput"
}

if ($applicationFiles.Count -eq 0) {
    throw "No packaged Microbot Cut Launcher executable was produced in $resolvedOutput"
}

foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
    if ($signature.Status -ne 'Valid') {
        throw "Invalid Authenticode signature for $($target.FullName): $($signature.Status) $($signature.StatusMessage)"
    }

    $subject = $signature.SignerCertificate.Subject
    if ([string]::IsNullOrWhiteSpace($subject) -or $subject -notlike "*$ExpectedPublisher*") {
        throw "Unexpected Authenticode publisher for $($target.FullName): $subject"
    }

    Write-Host "Verified Authenticode signature: $($target.Name) [$subject]"
}
