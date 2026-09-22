# Run interactively in PowerShell 7 on the developer's own Windows account.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RedmineUrl,
    [string]$Project = '',
    [string]$TimeZone = 'Asia/Almaty'
)
$ErrorActionPreference = 'Stop'
$integrationRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $integrationRoot '.env'
if (Test-Path -LiteralPath $configFile) {
    throw '.env already exists. Edit your existing configuration; it has not been overwritten.'
}
$parsedUrl = $null
if (-not [Uri]::TryCreate($RedmineUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or
    $parsedUrl.Scheme -ne 'https' -or $parsedUrl.UserInfo -or $parsedUrl.Query -or $parsedUrl.Fragment -or
    $RedmineUrl -match '[\s#"''`]' ) {
    throw 'Provide the final HTTPS Redmine URL without credentials, query, fragment or whitespace.'
}
if ($Project -and $Project -notmatch '^[a-zA-Z0-9_-]+$') {
    throw 'Project must be an identifier or numeric ID.'
}
if ($TimeZone -notmatch '^[a-zA-Z0-9_/+:-]+$') {
    throw 'Provide an IANA time zone such as Asia/Almaty.'
}
$secureKey = Read-Host 'Personal Redmine API key (hidden input; do not paste into chat)' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $personalKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
    if ($personalKey -notmatch '^[a-fA-F0-9]{40}$') {
        throw 'Expected a 40-character hexadecimal Redmine API key. No file was created.'
    }
    # Create an empty file first and restrict permissions before writing credentials.
    $stream = [System.IO.File]::Open($configFile, [System.IO.FileMode]::CreateNew)
    $stream.Dispose()
    $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $configFile
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($currentIdentity, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $configFile -AclObject $acl
    $localToken = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $lines = @(
        "REDMINE_URL=$RedmineUrl",
        "REDMINE_API_KEY=$personalKey",
        "REDMINE_PROJECT=$Project",
        "REDMINE_TIME_ZONE=$TimeZone",
        "REDMINE_ACCESS_TOKEN=$localToken"
    )
    [System.IO.File]::WriteAllLines($configFile, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Configuration saved with access restricted to your Windows account.'
    Write-Host 'Check connection from the integration directory: node --env-file=.env src/cli.js me'
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
    $personalKey = $null
    $lines = $null
    $localToken = $null
    $secureKey.Dispose()
}
