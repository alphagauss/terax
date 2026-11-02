# 在独立 PowerShell 进程中验证完整命令标记和退出状态，避免修改用户配置。
$ErrorActionPreference = 'Stop'
$env:TERAX_BLOCKS = '1'
function global:PSConsoleHostReadLine { $global:teraxTestCommand }
function global:Set-PSReadLineKeyHandler { param($Chord, $ScriptBlock) }
function global:prompt { 'user@host:project> ' }
. "$PSScriptRoot/profile.ps1"
__terax_install_readline

$global:teraxTestCommand = "Write-Output '你好'`n# " + ('long' * 100) + "`nWrite-Output 'two'"
$originalOut = [Console]::Out
$capture = [System.IO.StringWriter]::new()
try {
    [Console]::SetOut($capture)
    $accepted = PSConsoleHostReadLine
    if ($accepted -cne $global:teraxTestCommand) { throw '输入全文被修改' }
    $encoded = [regex]::Match($capture.ToString(), '\x1b\]133;E;([^\x1b]+)').Groups[1].Value
    if ([Uri]::UnescapeDataString($encoded) -cne $global:teraxTestCommand) { throw '命令标记丢失换行或被截断' }
    if ($capture.ToString() -notmatch '\x1b\]133;C;') { throw '缺少原生执行边界' }

    $global:LASTEXITCODE = 7
    Write-Output 'successful cmdlet' | Out-Null
    $result = prompt
    if ($result -notmatch 'user@host:project> ') { throw '块模式丢失原有提示符' }
    if ($result -notmatch '133;D;0\x1b\\\r\n') { throw '提示符未与上一条输出分行' }
    if ($result -notmatch '133;D;0\x1b') { throw '成功的 cmdlet 继承了旧退出码' }
    if ($global:LASTEXITCODE -ne 7) { throw 'prompt 修改了用户的 LASTEXITCODE' }
    $global:LASTEXITCODE = $null
    Write-Error 'expected failure' -ErrorAction SilentlyContinue
    $result = prompt
    if ($result -notmatch '133;D;1\x1b') { throw 'cmdlet 失败状态丢失' }
    if ($result -notmatch '133;B;terax=powershell') { throw '未报告输入能力' }

    # 宿主解析失败时 $? 可能仍为真，不能只依赖 prompt 的入口状态。
    $global:teraxTestCommand = 'if )'
    $null = PSConsoleHostReadLine
    Write-Output 'host leaves success state' | Out-Null
    $result = prompt
    if ($result -notmatch '133;D;1\x1b') { throw '语法错误被标记为成功' }
    $global:teraxTestCommand = "Write-Output 'valid again'"
    $null = PSConsoleHostReadLine
    Write-Output 'valid again' | Out-Null
    $result = prompt
    if ($result -notmatch '133;D;0\x1b') { throw '语法错误状态污染后续命令' }
} finally {
    [Console]::SetOut($originalOut)
    $capture.Dispose()
}
Write-Output 'PowerShell integration tests passed'
