# terax-shell-integration (PowerShell)
# 保留 UTF-8 BOM，Windows PowerShell 5.1 否则会按系统代码页错误解析中文注释。
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D so the host tracks cwd and prompt
# boundaries. C comes from a PSConsoleHostReadLine wrapper (PowerShell has no
# preexec hook).

if ($global:__TERAX_HOOKS_LOADED) { return }
$global:__TERAX_HOOKS_LOADED = $true

try {
    [Console]::InputEncoding  = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $global:OutputEncoding    = [System.Text.UTF8Encoding]::new($false)
} catch {}

if (Test-Path Function:prompt) {
    Copy-Item Function:prompt Function:__terax_user_prompt -Force -ErrorAction SilentlyContinue
}

function global:__terax_urlencode {
    param([string]$s)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($s)
    $sb = [System.Text.StringBuilder]::new($bytes.Length)
    foreach ($b in $bytes) {
        if (($b -ge 0x30 -and $b -le 0x39) -or
            ($b -ge 0x41 -and $b -le 0x5A) -or
            ($b -ge 0x61 -and $b -le 0x7A) -or
            $b -eq 0x2F -or $b -eq 0x2E -or $b -eq 0x5F -or
            $b -eq 0x7E -or $b -eq 0x2D) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.AppendFormat('%{0:X2}', $b)
        }
    }
    $sb.ToString()
}

# Wrap PSConsoleHostReadLine (defined by PSReadLine) to emit OSC 133 C with
# the accepted command line just before execution. Installed lazily from
# prompt: PSReadLine may finish loading only after this profile has run.
function global:__terax_install_readline {
    if ($global:__terax_readline_done) { return }
    if (-not (Test-Path Function:PSConsoleHostReadLine)) { return }
    $global:__terax_readline_done = $true
    # global: is required -- a plain Function: copy made inside a function
    # lands in its local scope and vanishes when it returns, leaving the
    # wrapper calling a missing command on every read (empty-input loop).
    Copy-Item Function:PSConsoleHostReadLine Function:global:__terax_user_readline -Force
    # Blocks 专用输入协议：ASCII 载荷不会被逐行执行，恢复全文后交给原生解析器。
    if ($env:TERAX_BLOCKS -and (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue)) {
        Set-PSReadLineKeyHandler -Chord Ctrl+F12 -ScriptBlock {
            $text = $null
            $cursor = 0
            [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$text, [ref]$cursor)
            if (-not $text.StartsWith('#terax:')) { return }
            $command = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text.Substring(7)))
            [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine()
            [Microsoft.PowerShell.PSConsoleReadLine]::Insert($command)
            [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        }
        $global:__terax_block_input = $true
    }
    function global:PSConsoleHostReadLine {
        try {
            $line = __terax_user_readline
        } catch {
            # Self-heal: restore the original reader so a broken wrapper can
            # never lock the shell out of input.
            Copy-Item Function:__terax_user_readline Function:global:PSConsoleHostReadLine -Force
            return ''
        }
        try {
            if ($line -is [string] -and $line.Trim().Length -gt 0) {
                $esc = [char]27
                [Console]::Write("$esc]777;terax;tasks;$PID;running;?$esc\")
                # 完整命令另发 E 标记，短 C 标记继续服务原生执行状态与 Agent 检测。
                if ($env:TERAX_BLOCKS) {
                    # 宿主遇到 ParserError 不一定更新 $?，先记录解析结果供 prompt 使用。
                    $parseTokens = $null
                    $parseErrors = $null
                    $null = [System.Management.Automation.Language.Parser]::ParseInput($line, [ref]$parseTokens, [ref]$parseErrors)
                    $global:__terax_parse_failed = $parseErrors.Count -gt 0
                    $encoded = __terax_urlencode $line
                    [Console]::Write("$esc]133;E;$encoded$esc\")
                }
                $cmd = $line -replace '[\x00-\x1F\x7F]', ' '
                if ($cmd.Length -gt 256) { $cmd = $cmd.Substring(0, 256) }
                [Console]::Write("$esc]133;C;$cmd$esc\")
            }
        } catch {}
        $line
    }
}

function global:prompt {
    # 必须在任何辅助调用前捕获状态，成功的 cmdlet 不继承旧的原生退出码。
    $succeeded = $?
    $nativeExit = $LASTEXITCODE
    $lec = if ($global:__terax_parse_failed) { 1 } elseif ($succeeded) { 0 } elseif ($nativeExit) { $nativeExit } else { 1 }
    $global:__terax_parse_failed = $false
    __terax_install_readline
    $esc = [char]27

    [Console]::Write("$esc]777;terax;tasks;$PID;idle;?$esc\")

    $oscD = "$esc]133;D;$lec$esc\"
    # 提示符另起一行，避免无尾换行输出串入下一次输入。
    if ($env:TERAX_BLOCKS) { $oscD += "`r`n" }
    $oscA = "$esc]133;A$esc\"
    $oscB = "$esc]133;B$esc\"
    if ($global:__terax_block_input) { $oscB = "$esc]133;B;terax=powershell$esc\" }

    $loc = Get-Location
    $osc7 = ''
    if ($loc.Provider.Name -eq 'FileSystem') {
        $cwd = $loc.ProviderPath -replace '\\','/'
        if ($cwd -match '^[A-Za-z]:') { $cwd = "/$cwd" }
        $cwdEnc = __terax_urlencode $cwd
        $hostName = [System.Environment]::MachineName
        $osc7 = "$esc]7;file://$hostName$cwdEnc$esc\"
    }

    # 块模式保留原生提示符，独立输入栏不替代终端内的提示符和命令回显。
    $original = if (Test-Path Function:__terax_user_prompt) {
        try { & __terax_user_prompt } catch { "PS $((Get-Location).Path)> " }
    } else {
        "PS $((Get-Location).Path)> "
    }

    $global:LASTEXITCODE = $nativeExit
    "$oscD$oscA$osc7${original}${oscB}"
}
