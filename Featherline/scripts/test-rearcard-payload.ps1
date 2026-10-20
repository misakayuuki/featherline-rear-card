# Run the 11 payload tests using the project's resolved Android/JUnit classpath.
# Relative project paths avoid JDK argument-file encoding problems with a Chinese
# checkout path on Windows. Dependencies and compiled classes remain unchanged.
$ErrorActionPreference = 'Stop'
$rearProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $rearProjectRoot
try {
    & .\gradlew.bat :app:exportRearCardTestRuntime --init-script scripts/rearcard-test-runtime.init.gradle --console=plain
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle could not prepare the test runtime (exit $LASTEXITCODE)."
    }

    $rearRuntime = Get-Content -LiteralPath build/rearcard-test-runtime.json -Raw -Encoding UTF8 | ConvertFrom-Json
    $rearPrefix = $rearProjectRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $rearClasspath = ($rearRuntime.classpath | ForEach-Object {
        $rearEntry = [string]$_
        if ($rearEntry.StartsWith($rearPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            $rearEntry = './' + $rearEntry.Substring($rearPrefix.Length)
        }
        $rearEntry.Replace('\', '/')
    }) -join [IO.Path]::PathSeparator
    $rearArguments = @(
        '-cp',
        ('"' + $rearClasspath + '"'),
        'org.junit.runner.JUnitCore',
        'com.mkx.hrttracker.rearcard.RearCardPayloadTest'
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText(
        (Join-Path $rearProjectRoot 'build/rearcard-junit.args'),
        $rearArguments,
        (New-Object Text.UTF8Encoding($false))
    )
    & $rearRuntime.javaExecutable '@build/rearcard-junit.args' |
        Tee-Object -FilePath build/rearcard-junit-result.txt
    if ($LASTEXITCODE -ne 0) {
        throw "Rear-card JUnit tests failed (exit $LASTEXITCODE)."
    }
} finally {
    Pop-Location
}
