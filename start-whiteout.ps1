#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$GamePath = '',
    [ValidateSet('coordinated-surveillance-v1', 'tower-first-v2')]
    [string]$MissionAlgorithm = 'coordinated-surveillance-v1',
    [string]$FlightPolicyFile = '',
    [switch]$Check
)

# Native Windows bundle. The existing ArcticSim stack owns the simulated fleet.
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$BackendPort = 8000
$DashboardPort = 3003
$GamePort = 3100
if (!$GamePath) {
    $bundledGame = Join-Path $repo 'cant-catch-me'
    $GamePath = if (Test-Path -LiteralPath (Join-Path $bundledGame 'package.json')) {
        $bundledGame
    } else {
        Join-Path (Split-Path $repo -Parent) 'cant-catch-me'
    }
}
$GamePath = [IO.Path]::GetFullPath($GamePath)
$backendUrl = "http://127.0.0.1:$BackendPort"
$dashboardUrl = "http://127.0.0.1:$DashboardPort"
$gameUrl = "http://127.0.0.1:$GamePort"
$policySha = $null
if ($FlightPolicyFile) {
    if (![IO.Path]::IsPathRooted($FlightPolicyFile)) { $FlightPolicyFile = Join-Path $repo $FlightPolicyFile }
    $FlightPolicyFile = [IO.Path]::GetFullPath($FlightPolicyFile)
    if (!(Test-Path -LiteralPath $FlightPolicyFile -PathType Leaf)) { throw "Flight policy file does not exist: $FlightPolicyFile" }
    $artifact = Get-Content -Raw -LiteralPath $FlightPolicyFile | ConvertFrom-Json -AsHashtable
    if ($artifact -isnot [Collections.IDictionary]) { throw 'Flight policy must be a JSON object.' }
    $selected = if ($artifact.ContainsKey('trained')) { $artifact.trained } else { $artifact }
    if ($selected -isnot [Collections.IDictionary]) { throw 'Flight policy trained block must be an object.' }
    $selectedAlgorithm = if ($selected.algorithm) { $selected.algorithm } else { $artifact.algorithm }
    if ($MissionAlgorithm -ne 'coordinated-surveillance-v1' -or $selectedAlgorithm -ne $MissionAlgorithm) {
        throw 'FlightPolicyFile must contain a coordinated-surveillance-v1 policy and match MissionAlgorithm.'
    }
    if ($selected.flightPolicy -isnot [Collections.IDictionary]) { throw 'Flight policy must contain a flightPolicy object.' }
    $bounds = @{
        laneSpacingM = @(200, 1600); routePhase = @(0, 1); quadSearchRadiusM = @(250, 2200)
        lookaheadS = @(0, 40); supportOffsetM = @(100, 1000); reacquireWidthM = @(50, 700)
    }
    foreach ($key in $selected.flightPolicy.Keys) {
        if (!$bounds.ContainsKey($key)) { throw "Unknown flight policy parameter: $key" }
        $number = 0.0
        if ($selected.flightPolicy[$key] -is [bool] -or ![double]::TryParse([string]$selected.flightPolicy[$key], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number) -or ![double]::IsFinite($number) -or $number -lt $bounds[$key][0] -or $number -gt $bounds[$key][1]) {
            throw "Invalid flight policy $key; expected a finite number from $($bounds[$key][0]) through $($bounds[$key][1])."
        }
    }
    $policySha = (Get-FileHash -LiteralPath $FlightPolicyFile -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-Json([string]$Url) {
    try { return Invoke-RestMethod -Uri $Url -TimeoutSec 4 } catch { return $null }
}

function Wait-Ready([string]$Url, [Diagnostics.Process]$Process, [switch]$Backend, [int]$Seconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) { throw "Service exited before $Url was ready. See $logDir." }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                if (!$Backend) { return }
                $ready = $response.Content | ConvertFrom-Json
                if ($ready.adapter -eq 'whiteout' -and $ready.backend -eq 'ok' -and $ready.deployed) { return }
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out waiting for $Url. See $logDir."
}

function Assert-Free([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connected = $client.ConnectAsync('127.0.0.1', $Port).Wait(500)
        if ($connected -and $client.Connected) { throw "Port $Port is occupied by an unrecognized service. Stop it before starting this bundle." }
    } catch [AggregateException] {
        # A refused connection means the port is available.
    } finally { $client.Dispose() }
}

function Controller-Mismatch($State) {
    if (!$State -or $State.mission_algorithm.algorithm -ne $MissionAlgorithm) {
        return "The running backend does not report requested algorithm '$MissionAlgorithm'."
    }
    if ($policySha -and $State.mission_algorithm.policy_sha256 -ne $policySha) {
        return 'The running backend has not loaded the requested flight policy file contents.'
    }
    return $null
}

$site = Read-Json 'http://127.0.0.1:8090/api/site'
if (!$site -or !$site.ok) {
    throw 'Start the existing ArcticSim stack first. Its control service must answer on 127.0.0.1:8090.'
}
if ($site.name -ne 'fort_ross') {
    throw 'This WHITEOUT adapter is configured for Fort Ross. Select fort_ross in ArcticSim before launching.'
}
$health = Read-Json "$backendUrl/health"
if ($health -and $health.adapter -ne 'whiteout') {
    throw "The backend on $BackendPort uses '$($health.adapter)'. Stop that backend before starting WHITEOUT; this script never replaces another controller."
}
if ($health -and ($health.backend -ne 'ok' -or !$health.deployed)) {
    throw "The existing WHITEOUT backend is not ready. Inspect $backendUrl/health before retrying."
}
$runningState = if ($health) { Read-Json "$backendUrl/telemetry/latest" } else { $null }
$controllerMismatch = if ($health) { Controller-Mismatch $runningState } else { $null }
if ($controllerMismatch -and !$Check) {
    throw "$controllerMismatch Stop and relaunch that backend to apply these settings. This launcher has not restarted or replaced any service."
}
$game = Read-Json "$gameUrl/api/learning/dashboard"
$dashboard = $false
try {
    $page = Invoke-WebRequest -Uri $dashboardUrl -UseBasicParsing -TimeoutSec 10
    $dashboard = $page.Content -match '<title>Overwatch\s*\|'
} catch {}
if (!$health) { Assert-Free $BackendPort }
if (!$game -or !$game.layout -or !$game.totals) { $game = $null; Assert-Free $GamePort }
if (!$dashboard) { Assert-Free $DashboardPort }

if (!$Python) { $Python = Join-Path $repo '.venv/Scripts/python.exe' }
$Python = [IO.Path]::GetFullPath($Python)
if (!$health -and !(Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw 'Pass -Python with the Python executable from an environment containing backend/requirements.txt, or create .venv in this checkout.'
}
$dashboardNext = Join-Path $repo 'frontend/node_modules/next/dist/bin/next'
$gameNext = Join-Path $GamePath 'node_modules/next/dist/bin/next'
if (!$dashboard -and !(Test-Path -LiteralPath $dashboardNext)) { throw 'Install dashboard dependencies with npm ci in frontend first.' }
if (!$game -and !(Test-Path -LiteralPath $gameNext)) { throw 'Install game dependencies with npm ci in the Cant Catch Me directory first.' }
if (!$dashboard -or !$game) { $node = (Get-Command node -ErrorAction Stop).Source }

if ($Check) {
    [pscustomobject]@{
        Simulator = $site.name; BackendRunning = [bool]$health; DashboardRunning = [bool]$dashboard; GameRunning = [bool]$game
        RequestedAlgorithm = $MissionAlgorithm; RunningAlgorithm = $runningState.mission_algorithm.algorithm
        FlightPolicyFile = $FlightPolicyFile; FlightPolicySha256 = $policySha; NeedsBackendRelaunch = [bool]$controllerMismatch
    }
    return
}

$logDir = Join-Path $repo '.qa/whiteout'
$null = New-Item -ItemType Directory -Force -Path $logDir
$started = [Collections.Generic.List[Diagnostics.Process]]::new()
$savedEnv = @{}
$settings = @{
    ADAPTER = 'whiteout'; ARCTIC_HOST = '127.0.0.1'; SEARCH_POLICY_FILE = ' '
    MISSION_ALGORITHM = $MissionAlgorithm; SURVEILLANCE_POLICY_FILE = $(if ($FlightPolicyFile) { $FlightPolicyFile } else { ' ' })
    ARCTIC_QUAD = 'udpout:127.0.0.1:14550'; ARCTIC_PLANE = 'udpout:127.0.0.1:14560'
    ARCTIC_TOWER1 = 'udpout:127.0.0.1:14580'; ARCTIC_TOWER2 = 'udpout:127.0.0.1:14590'
    NEXT_PUBLIC_API_URL = $backendUrl; BACKEND_INTERNAL_URL = $backendUrl
    NEXT_PUBLIC_WS_URL = "ws://127.0.0.1:$BackendPort/ws/telemetry"
    NEXT_PUBLIC_SIM_VIEWER_URL = 'http://127.0.0.1:8080'
    SIM_VIEWER_URL = 'http://127.0.0.1:8080'; NEXT_PUBLIC_SIM_CONTROL_URL = 'http://127.0.0.1:8090'
    SIM_VIEWER_INTERNAL_URL = 'http://127.0.0.1:8080'; SIM_CONTROL_URL = 'http://127.0.0.1:8090'
    GAME_SERVICE_URL = $gameUrl; NEXT_PUBLIC_GAME_URL = $gameUrl
    CORS_ORIGINS = "$dashboardUrl,http://localhost:$DashboardPort"
}
# Native launch skips Postgres unless enabled in the invoking environment.
if (!$env:DATABASE_ENABLED -and !$env:DATABASE_URL) { $settings.DATABASE_ENABLED = '0' }
try {
    foreach ($key in $settings.Keys) {
        $savedEnv[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    if (!$health) {
        $arguments = "-B -m uvicorn main:app --host 127.0.0.1 --port $BackendPort --workers 1"
        $envFile = Join-Path $repo '.env'
        if (Test-Path -LiteralPath $envFile) { $arguments += " --env-file `"$envFile`"" }
        $process = Start-Process -FilePath $Python -ArgumentList $arguments -WorkingDirectory (Join-Path $repo 'backend') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logDir/backend.out.log" -RedirectStandardError "$logDir/backend.err.log"
        $started.Add($process)
        Wait-Ready "$backendUrl/health" $process -Backend
        $health = Read-Json "$backendUrl/health"
        if ($health.adapter -ne 'whiteout' -or !$health.deployed) { throw 'Backend failed to enter WHITEOUT mode.' }
        $controllerMismatch = Controller-Mismatch (Read-Json "$backendUrl/telemetry/latest")
        if ($controllerMismatch) { throw $controllerMismatch }
    }
    if (!$game) {
        $process = Start-Process -FilePath $node -ArgumentList "`"$gameNext`" dev -H 127.0.0.1 -p $GamePort" -WorkingDirectory $GamePath -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logDir/game.out.log" -RedirectStandardError "$logDir/game.err.log"
        $started.Add($process)
        Wait-Ready "$gameUrl/api/learning/dashboard" $process
    }
    if (!$dashboard) {
        $process = Start-Process -FilePath $node -ArgumentList "`"$dashboardNext`" dev -H 127.0.0.1 -p $DashboardPort" -WorkingDirectory (Join-Path $repo 'frontend') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logDir/dashboard.out.log" -RedirectStandardError "$logDir/dashboard.err.log"
        $started.Add($process)
        Wait-Ready "$dashboardUrl/api/backend-preview/health" $process
    }
    $displayHealth = Read-Json "$dashboardUrl/api/backend-preview/health"
    if (!$displayHealth -or $displayHealth.adapter -ne 'whiteout' -or $displayHealth.run.run_id -ne $health.run.run_id) {
        throw 'The running dashboard points to another backend. Restart it with this launcher to use the same WHITEOUT run.'
    }
    $displayGame = Read-Json "$dashboardUrl/api/game-learning"
    if (!$displayGame -or !$displayGame.layout) { throw 'The dashboard cannot reach the game. Restart it with this launcher to set GAME_SERVICE_URL.' }
    $state = Read-Json "$backendUrl/telemetry/latest"
    $fleet = @($state.fleet.PSObject.Properties.Value)
    $linked = @($fleet | Where-Object { $_.connected -and $_.mavlink }).Count
    Write-Host "WHITEOUT: $linked / $($fleet.Count) fleet links connected."
    Write-Host "Mission algorithm: $($state.mission_algorithm.algorithm)"
    if ($state.mission_algorithm.policy_file) { Write-Host "Flight policy: $($state.mission_algorithm.policy_file)" }
    if ($linked -lt 4) { Write-Warning 'Some fleet links are unavailable; inspect Fleet before treating this as a live run.' }
    Write-Host "Dashboard: $dashboardUrl"
    Write-Host "Simulator and cameras: $dashboardUrl/backend"
    Write-Host "Game: $gameUrl (also linked from the dashboard Game tab)"
    if ($started.Count) { Write-Host "New service process IDs: $($started.Id -join ', '). Logs: $logDir" }
    else { Write-Host 'Reused the running services; no additional processes started.' }
} catch {
    # Only roll back processes created by this invocation; leave reused services alone.
    $startupFailure = $_
    for ($index = $started.Count - 1; $index -ge 0; $index--) {
        $process = $started[$index]
        try {
            if (!$process.HasExited) { $process.Kill($true); $null = $process.WaitForExit(5000) }
        } catch { Write-Warning "Could not clean up process $($process.Id): $($_.Exception.Message)" }
    }
    throw $startupFailure
} finally {
    foreach ($key in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process') }
}
