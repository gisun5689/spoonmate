[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ManifestPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedManifestSha256,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCommit
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:phase = 'identity'
$script:root = $null
$script:owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:checks = [System.Collections.Generic.List[object]]::new()
$script:assetProof = [System.Collections.Generic.List[object]]::new()
$script:started = [DateTime]::UtcNow
$script:sentinel = $null
$script:sentinelHash = $null
$script:code = 1
$script:installationAttempts = 0
$script:failure = 'E2E_NOT_COMPLETED'
$Guid = '9173b77d-41dc-5074-9fb3-f247fea6b34e'
$InstallKey = 'Software\' + $Guid
$UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $Guid
function Require([bool]$Condition, [string]$Code) { if (!$Condition) { throw $Code } }
function Hash([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Under([string]$File, [string]$Directory) {
    [IO.Path]::GetFullPath($File).StartsWith([IO.Path]::GetFullPath($Directory).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Record([string]$Name, [object]$Evidence) { $script:checks.Add([ordered]@{ name=$Name; pass=$true; evidence=$Evidence }) }
function RegRead([string]$Subkey, [string]$Name) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
    try { $key = $base.OpenSubKey($Subkey, $false); if (!$key) { return $null }; try { $key.GetValue($Name, $null) } finally { $key.Dispose() } } finally { $base.Dispose() }
}
function RegAbsent {
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
        foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
            try { foreach ($subkey in @($InstallKey,$UninstallKey)) { $key=$base.OpenSubKey($subkey,$false); if ($key) { $key.Dispose(); throw 'PREEXISTING_SPOONMATE_REGISTRY' } } } finally { $base.Dispose() }
        }
    }
}
function StopOwned {
    if (!$script:root -or !(Test-Path -LiteralPath (Join-Path $script:root 'fixture-owner.json'))) { return }
    # Never kill by application name, installed path, global PID search or process tree.
    foreach ($p in $script:owned) {
        try { if (!$p.HasExited -and (Under $p.MainModule.FileName $script:root)) { $p.Kill(); $p.WaitForExit(10000) | Out-Null } } catch {}
    }
    foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Under $_.ExecutablePath $script:root) -and $_.CreationDate.ToUniversalTime() -ge $script:started })) {
        try { $ownedProcess=Get-Process -Id $p.ProcessId -ErrorAction Stop;$handle=$ownedProcess.SafeHandle;if ((Under $ownedProcess.MainModule.FileName $script:root) -and [Math]::Abs(($ownedProcess.StartTime.ToUniversalTime()-$p.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) { $ownedProcess.Kill();$ownedProcess.WaitForExit(10000) | Out-Null } } catch {}
    }
}
function RunFixture([string]$Exe,[string]$Arguments,[int]$Expected) {
    Require (Under $Exe $script:root) 'PROCESS_OUTSIDE_FIXTURE'
    Require (!$Arguments.Contains('--force-run') -and !$Arguments.Contains('/allusers') -and !$Arguments.Contains('--delete-app-data')) 'UNSAFE_INSTALLER_ARGUMENTS'
    $psi=[Diagnostics.ProcessStartInfo]::new();$psi.FileName=$Exe;$psi.Arguments=$Arguments;$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
    $psi.WorkingDirectory=$script:root;$psi.Environment['TEMP']=Join-Path $script:root 'temp';$psi.Environment['TMP']=$psi.Environment['TEMP']
    if ([IO.Path]::GetFileName($Exe) -match '^v2\.0\.15\.[0-9]+\.exe$') { $script:installationAttempts++ }
    foreach ($tokenName in @('GITHUB_TOKEN','GH_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_ID_TOKEN_REQUEST_TOKEN')) {
        [void]$psi.Environment.Remove($tokenName)
    }
    $p=[Diagnostics.Process]::Start($psi);$script:owned.Add($p)
    Require ($p.WaitForExit(240000)) 'FIXTURE_PROCESS_TIMEOUT'
    Require ($p.ExitCode -eq $Expected) ('UNEXPECTED_EXIT_' + $p.ExitCode + '_EXPECTED_' + $Expected)
    Require (@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Under $_.ExecutablePath $script:root) -and [IO.Path]::GetFileName($_.ExecutablePath) -ieq 'SpoonMate LITE.exe' }).Count -eq 0) 'APPLICATION_WAS_UNEXPECTEDLY_LAUNCHED'
    $p.ExitCode
}
function GetApi([string]$Suffix) {
    Require ($Suffix -match '^/repos/gisun5689/spoonmate/(?:releases/[0-9]+|releases/latest)$') 'API_ROUTE_NOT_ALLOWED'
    $response=$script:api.GetAsync('https://api.github.com'+$Suffix).GetAwaiter().GetResult()
    try { Require ($response.StatusCode -eq 200) 'GITHUB_METADATA_UNAVAILABLE';$text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult();Require ($text.Length -le 2097152) 'METADATA_TOO_LARGE';ConvertFrom-Json -InputObject $text -AsHashtable } finally { $response.Dispose() }
}
function DownloadPinned([hashtable]$Pin,[bool]$Draft) {
    $release=GetApi ('/repos/gisun5689/spoonmate/releases/'+$Pin.release_id)
    Require ($release.id -eq $Pin.release_id -and $release.tag_name -ceq $Pin.tag -and $release.draft -eq $Draft -and !$release.prerelease) 'RELEASE_PIN_MISMATCH'
    $asset=@($release.assets | Where-Object id -EQ $Pin.asset_id)
    Require ($asset.Count -eq 1 -and $asset[0].name -ceq $Pin.name -and $asset[0].size -eq $Pin.size) 'ASSET_METADATA_MISMATCH'
    if ($asset[0].ContainsKey('digest') -and $asset[0].digest) { Require ($asset[0].digest -ceq ('sha256:'+$Pin.sha256)) 'GITHUB_ASSET_DIGEST_MISMATCH' }
    $request=[Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,'https://api.github.com/repos/gisun5689/spoonmate/releases/assets/'+$Pin.asset_id)
    $request.Headers.Accept.ParseAdd('application/octet-stream')
    $response=$script:api.SendAsync($request,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
            $location=$response.Headers.Location
            Require ($location -and $location.IsAbsoluteUri -and $location.Scheme -ceq 'https' -and $location.Host -ceq 'release-assets.githubusercontent.com' -and !$location.UserInfo) 'UNTRUSTED_ASSET_REDIRECT'
            $response.Dispose();$response=$script:assetClient.GetAsync($location,[Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        }
        Require ($response.StatusCode -eq 200) 'ASSET_DOWNLOAD_FAILED'
        $file=Join-Path $script:root ($Pin.tag+'.exe')
        $downloadStream=$response.Content.ReadAsStreamAsync().GetAwaiter().GetResult();$output=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $buffer=[byte[]]::new(131072);[long]$total=0;while (($n=$downloadStream.Read($buffer,0,$buffer.Length)) -gt 0) { $total+=$n;Require ($total -le $Pin.size) 'DOWNLOAD_EXCEEDS_PINNED_SIZE';$output.Write($buffer,0,$n) };Require ($total -eq $Pin.size) 'DOWNLOAD_SIZE_MISMATCH' } finally { $output.Dispose();$downloadStream.Dispose() }
    } finally { $response.Dispose();$request.Dispose() }
    Require ((Hash $file) -ceq $Pin.sha256) 'INSTALLER_SHA256_MISMATCH'
    Require ((Get-AuthenticodeSignature -LiteralPath $file).Status.ToString() -ceq $Pin.authenticode_status) 'AUTHENTICODE_STATUS_MISMATCH'
    $script:assetProof.Add([ordered]@{ tag=$Pin.tag;release_id=$Pin.release_id;asset_id=$Pin.asset_id;sha256=$Pin.sha256;exe_sha256=$Pin.exe_sha256;asar_sha256=$Pin.asar_sha256;size=$Pin.size;draft=$Draft })
    $file
}
function Installed([hashtable]$Pin) {
    $exe=Join-Path $script:install 'SpoonMate LITE.exe';$asar=Join-Path $script:install 'resources\app.asar'
    Require ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $asar)) 'INSTALLED_PAYLOAD_MISSING'
    Require ((Hash $exe) -ceq $Pin.exe_sha256) 'INSTALLED_EXE_MISMATCH'
    Require ((Hash $asar) -ceq $Pin.asar_sha256) 'INSTALLED_ASAR_MISMATCH'
    $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
    Require ($version -match ('^'+[regex]::Escape($Pin.internal_version)+'(?:\.0)?$')) 'INSTALLED_VERSION_MISMATCH'
    Require ((RegRead $UninstallKey 'DisplayVersion') -ceq $Pin.internal_version) 'REGISTRY_VERSION_MISMATCH'
    Require ([IO.Path]::GetFullPath([string](RegRead $InstallKey 'InstallLocation')).TrimEnd('\') -ieq [IO.Path]::GetFullPath($script:install).TrimEnd('\')) 'REGISTRY_INSTALL_ROOT_MISMATCH'
    Require ((Hash $script:sentinel) -ceq $script:sentinelHash) 'USER_DATA_SENTINEL_CHANGED'
}
function FileManifest {
    Require (@(Get-ChildItem -LiteralPath $script:install -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -eq 0) 'PAYLOAD_REPARSE_POINT'
    @((Get-ChildItem -LiteralPath $script:install -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
        Require (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'PAYLOAD_REPARSE_POINT'
        [ordered]@{ file=$_.FullName.Substring($script:install.Length).TrimStart('\');size=$_.Length;sha256=Hash $_.FullName }
    })) | ConvertTo-Json -Compress -Depth 4
}
function OldUninstallerCopy {
    $files=@(Get-ChildItem -LiteralPath $script:install -File -Filter '*uninstall*.exe')
    Require ($files.Count -eq 1) 'UNINSTALLER_NOT_UNIQUE'
    $copy=Join-Path $script:root ('fixture-uninstaller-'+[Guid]::NewGuid().ToString('N')+'.exe')
    Copy-Item -LiteralPath $files[0].FullName -Destination $copy -ErrorAction Stop
    Require ((Hash $copy) -ceq (Hash $files[0].FullName)) 'UNINSTALLER_COPY_CHANGED'
    $copy
}
function UninstallFixture {
    $uninstaller=OldUninstallerCopy
    RunFixture $uninstaller ('/S /KEEP_APP_DATA --updated /currentuser _?='+$script:install) 0 | Out-Null
    Require (!(Test-Path -LiteralPath (Join-Path $script:install 'SpoonMate LITE.exe'))) 'UNINSTALL_LEFT_EXECUTABLE'
    RegAbsent
    Require ((Hash $script:sentinel) -ceq $script:sentinelHash) 'UNINSTALL_CHANGED_USER_DATA'
}
try {
    Require ($env:GITHUB_ACTIONS -ceq 'true' -and $env:CI -ceq 'true' -and $env:RUNNER_OS -ceq 'Windows' -and $env:RUNNER_ARCH -ceq 'X64' -and $env:SPOONMATE_RUNNER_ENVIRONMENT -ceq 'github-hosted') 'GITHUB_HOSTED_WINDOWS_ONLY'
    Require ($env:GITHUB_REPOSITORY -ceq 'gisun5689/spoonmate' -and $env:GITHUB_EVENT_NAME -ceq 'workflow_dispatch' -and $env:GITHUB_SHA -ceq $ExpectedCommit) 'WORKFLOW_IDENTITY_MISMATCH'
    Require ($env:USERNAME -ieq 'runneradmin' -and $env:ImageOS -match '^win' -and $env:ImageVersion -and $env:GITHUB_RUN_ID -match '^[0-9]+$') 'HOSTED_IMAGE_IDENTITY_REQUIRED'
    $manifestFile=(Resolve-Path -LiteralPath $ManifestPath).Path
    Require (Under $manifestFile $env:GITHUB_WORKSPACE) 'MANIFEST_OUTSIDE_CHECKOUT'
    Require ((Hash $manifestFile) -ceq $ExpectedManifestSha256) 'APPROVED_MANIFEST_CHANGED'
    Require (Test-Json -Json (Get-Content -LiteralPath $manifestFile -Raw) -SchemaFile (Join-Path $PSScriptRoot 'artifact-manifest.schema.json')) 'MANIFEST_SCHEMA_INVALID'
    $m=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json -AsHashtable
    Require ($m.reviewed_by_root -and $m.fresh_ci_install_approved -and $m.no_application_launch) 'ROOT_REVIEW_REQUIRED'
    RegAbsent
    foreach ($path in @((Join-Path $env:APPDATA 'spoonmate-sun-assistant'),(Join-Path $env:APPDATA 'SpoonMate LITE'),(Join-Path $env:APPDATA 'SpoonMate_Lite'),(Join-Path $env:LOCALAPPDATA 'Programs\SpoonMate LITE'),(Join-Path $env:USERPROFILE 'Desktop\SpoonMate LITE.lnk'),(Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SpoonMate LITE.lnk'))) { Require (!(Test-Path -LiteralPath $path)) 'PREEXISTING_SPOONMATE_DATA_OR_SHORTCUT' }
    Require (@(Get-CimInstance Win32_Process | Where-Object Name -IEQ 'SpoonMate LITE.exe').Count -eq 0) 'PREEXISTING_SPOONMATE_PROCESS'
    $script:root=Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('spoonmate-nsis-e2e-'+[Guid]::NewGuid().ToString('N'))
    Require (Under $script:root $env:RUNNER_TEMP) 'FIXTURE_ROOT_INVALID'
    New-Item -ItemType Directory -Path $script:root -ErrorAction Stop | Out-Null
    [ordered]@{run_id=$env:GITHUB_RUN_ID;commit=$ExpectedCommit;temporary_fixture=$true} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:root 'fixture-owner.json')
    New-Item -ItemType Directory -Path (Join-Path $script:root 'temp'),(Join-Path $script:root 'proofs') | Out-Null
    $installParent=Join-Path $script:root 'OneDrive\바탕 화면'
    Require (Under $installParent $script:root) 'INSTALL_PARENT_OUTSIDE_FIXTURE'
    New-Item -ItemType Directory -Path $installParent -ErrorAction Stop | Out-Null
    $script:install=Join-Path $installParent 'SpoonMate LITE v2.0.15.32'
    $script:phase='download'
    Require (![string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) 'GITHUB_TOKEN_REQUIRED'
    $handler=[Net.Http.HttpClientHandler]::new();$handler.AllowAutoRedirect=$false
    $script:api=[Net.Http.HttpClient]::new($handler);$script:api.Timeout=[TimeSpan]::FromMinutes(10)
    $script:api.DefaultRequestHeaders.UserAgent.ParseAdd('SpoonMate-NSIS-E2E/1.0');$script:api.DefaultRequestHeaders.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$env:GITHUB_TOKEN)
    $script:api.DefaultRequestHeaders.Add('X-GitHub-Api-Version','2022-11-28')
    $assetHandler=[Net.Http.HttpClientHandler]::new();$assetHandler.AllowAutoRedirect=$false
    $script:assetClient=[Net.Http.HttpClient]::new($assetHandler);$script:assetClient.Timeout=[TimeSpan]::FromMinutes(10)
    $latest=GetApi '/repos/gisun5689/spoonmate/releases/latest'
    Require ($latest.id -eq $m.artifacts.public122.release_id -and $latest.tag_name -ceq 'v2.0.15.127') 'PUBLISHED_BASELINE_CHANGED'
    $v119=DownloadPinned $m.artifacts.legacy119 $true
    $v121=DownloadPinned $m.artifacts.public122 $false
    $v122=DownloadPinned $m.artifacts.candidate123 $true
    $dataRoot=Join-Path $env:APPDATA 'spoonmate-sun-assistant';New-Item -ItemType Directory -Path $dataRoot -ErrorAction Stop | Out-Null
    $script:sentinel=Join-Path $dataRoot ('e2e-sentinel-'+$env:GITHUB_RUN_ID+'.txt');[IO.File]::WriteAllText($script:sentinel,'synthetic-user-data-'+$env:GITHUB_RUN_ID)
    $script:sentinelHash=Hash $script:sentinel
    $script:phase='clean-upgrade'
    RunFixture $v119 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.legacy119
    RunFixture $v122 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.candidate123
    Record 'actual-119-to-128-clean-upgrade' @{exit_code=0;version=$m.artifacts.candidate123.internal_version;data_unchanged=$true}
    UninstallFixture;Record 'clean-uninstall-preserves-synthetic-data' @{exit_code=0}
    $script:phase='locked-old-uninstaller'
    RunFixture $v119 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.legacy119
    $before=FileManifest;$before | Set-Content -LiteralPath (Join-Path $script:root 'proofs\locked-before.json')
    $old=OldUninstallerCopy;$lock=[IO.File]::Open((Join-Path $script:install 'resources\app.asar'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        RunFixture $old ('/S /KEEP_APP_DATA --updated /currentuser _?='+$script:install) 2 | Out-Null
        $after=FileManifest;$after | Set-Content -LiteralPath (Join-Path $script:root 'proofs\locked-after.json')
        Require ($before -ceq $after) 'LOCK_FAILURE_DID_NOT_RESTORE_EXACT_OLD_FILES'
        Installed $m.artifacts.legacy119
    } finally { $lock.Dispose() }
    Record 'actual-old-uninstaller-exit2-preserves-exact-manifest' @{exit_code=2;rollback_exact=$true;lock='exclusive-delete-sharing-denied'}
    $script:phase='retry-upgrade'
    RunFixture $v122 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.candidate123
    Record 'actual-128-retry-after-lock-release' @{exit_code=0;data_unchanged=$true}
    UninstallFixture;Record 'final-uninstall-removes-only-fixture-installation' @{exit_code=0;registry_removed=$true;data_unchanged=$true}
    $script:phase='previous-public-upgrade'
    RunFixture $v121 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.public122
    RunFixture $v122 ('/S /currentuser /D='+$script:install) 0 | Out-Null;Installed $m.artifacts.candidate123
    UninstallFixture
    Record 'actual-127-to-128-clean-upgrade' @{exit_code=0;from_version=$m.artifacts.public122.internal_version;to_version=$m.artifacts.candidate123.internal_version;data_unchanged=$true;registry_removed=$true}
    Require ($script:checks.Count -eq 6) 'REQUIRED_CASE_COUNT_MISMATCH'
    $script:failure='';$script:code=0
} catch {
    $message=$_.Exception.Message
    $script:failure=if ($message -match '^[A-Z][A-Z0-9_]+$') {$message} else {'E2E_RUNTIME_FAILED'}
} finally {
    StopOwned
    if ($script:root -and @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and (Under $_.ExecutablePath $script:root) -and $_.CreationDate.ToUniversalTime() -ge $script:started }).Count -gt 0) { $script:code=1;$script:failure='FIXTURE_PROCESSES_REMAIN' }
    if (Get-Variable api -Scope Script -ErrorAction SilentlyContinue) { $script:api.Dispose() }
    if (Get-Variable assetClient -Scope Script -ErrorAction SilentlyContinue) { $script:assetClient.Dispose() }
    if ($script:root -and (Test-Path -LiteralPath (Join-Path $script:root 'proofs'))) {
        $previousVerified=(@($script:checks | Where-Object name -CEQ 'actual-127-to-128-clean-upgrade').Count -eq 1)
        $proof=[ordered]@{success=($script:code -eq 0);phase=$script:phase;failure_code=$script:failure;required_cases=6;passed=$script:checks.Count;failed=if($script:code -eq 0){0}else{1};skipped=0;checks=$script:checks;assets=$script:assetProof;actual_nsis_installation=($script:installationAttempts -gt 0);actual_previous_upgrade_from='2.0.15.127';actual_previous_upgrade_verified=$previousVerified;install_path_shape='OneDrive\바탕 화면\SpoonMate LITE v2.0.15.32';real_onedrive_sync_exercised=$false;application_launch_exercised=$false;startup_auto_119_to_public122_exercised=$false;public122_download_verified_only=$false;real_user_account_used=$false;local_pc_access=$false;fixture_run_id=$env:GITHUB_RUN_ID;commit=$ExpectedCommit}
        $proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $script:root 'proofs\summary.json')
    }
    Write-Host ('SpoonMate NSIS E2E: '+ $(if($script:code -eq 0){'PASS'}else{'FAILED '+$script:failure}) + '; passed='+$script:checks.Count+'; skipped=0')
}
exit $script:code


