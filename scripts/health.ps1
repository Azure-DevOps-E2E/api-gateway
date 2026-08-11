param(
    [string]$BaseUrl = "http://localhost:8080",

    [string]$ExpectedService = "",

    [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd("/")
$checks = @(
    @{ Name = "API Gateway"; Path = "/health/api-gateway"; Service = "api-gateway" },
    @{ Name = "Frontend"; Path = "/health/frontend"; Service = "frontend" },
    @{ Name = "User Service"; Path = "/health/user-service"; Service = "user-service" },
    @{ Name = "Catalog Service"; Path = "/health/catalog-service"; Service = "catalog-service" },
    @{ Name = "Order Service"; Path = "/health/order-service"; Service = "order-service" }
)

if ([string]::IsNullOrWhiteSpace($ExpectedService) -xor [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    throw "ExpectedService and ExpectedVersion must be provided together"
}

if ($ExpectedService -and $checks.Service -notcontains $ExpectedService) {
    throw "Unknown expected service: $ExpectedService"
}

$results = foreach ($check in $checks) {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $response = Invoke-RestMethod -Uri "$base$($check.Path)" -TimeoutSec 5
        $stopwatch.Stop()
        $reportedVersion = if ($response.version) { [string]$response.version } else { "unknown" }
        $matchesExpectedVersion = (
            -not $ExpectedService -or
            $check.Service -ne $ExpectedService -or
            $reportedVersion -eq $ExpectedVersion
        )
        $hasExpectedIdentity = $response.status -eq "UP" -and $response.service -eq $check.Service
        $isUp = $hasExpectedIdentity -and $matchesExpectedVersion
        $detail = if (-not $hasExpectedIdentity) {
            "Unexpected health response"
        }
        elseif (-not $matchesExpectedVersion) {
            "Expected version $ExpectedVersion, got $reportedVersion"
        }
        else {
            "OK"
        }

        [pscustomobject]@{
            Component = $check.Name
            Status    = if ($isUp) { "UP" } else { "DOWN" }
            Version   = $reportedVersion
            LatencyMs = $stopwatch.ElapsedMilliseconds
            Detail    = $detail
        }
    }
    catch {
        $stopwatch.Stop()
        [pscustomobject]@{
            Component = $check.Name
            Status    = "DOWN"
            Version   = "unknown"
            LatencyMs = $stopwatch.ElapsedMilliseconds
            Detail    = $_.Exception.Message
        }
    }
}

$results | Format-Table -AutoSize

if ($results.Status -contains "DOWN") {
    exit 1
}
