# ============================================================
#  基于Web平台的人脸表情识别系统 —— 本地服务器启动脚本
#  ------------------------------------------------------------
#  说明：本脚本只负责把项目文件夹当成静态网站发布出去。
#        真正的识别计算全部在浏览器里完成，与 Python / Node 无关。
#        之所以需要它，是因为浏览器禁止 file:// 页面读取模型文件。
#
#  优先使用 Python；没有 Python 时自动改用 Node.js。
# ============================================================

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

function Show-Header {
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host '     基于Web平台的人脸表情识别系统' -ForegroundColor Cyan
    Write-Host '  ============================================================' -ForegroundColor Cyan
    Write-Host ''
}

# ---------------- 1. 查找可用的运行时 ----------------
function Find-Python {
    # ① 首选 Python 启动器 py.exe —— 官方安装包都会装它，
    #    而且 -3 会自动选中最新版 3.x，**不受安装目录和 PATH 影响**。
    #    这里问它要真实的解释器路径，后面调用方式就和直接调 python.exe 完全一致。
    try {
        $launcher = Get-Command 'py.exe' -ErrorAction Stop
        $exe = (& $launcher.Source -3 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
        if ($LASTEXITCODE -eq 0 -and $exe) {
            $exe = $exe.Trim()
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
    } catch { }

    # ② 常见固定路径（覆盖装在自定义盘符的情况，例如本机的 D:\Python312）
    $candidates = @(
        'D:\Python313\python.exe',
        'D:\Python312\python.exe',
        'D:\Python311\python.exe',
        'D:\Python310\python.exe'
    )
    foreach ($c in $candidates) {
        try { $cmd = Get-Command $c -ErrorAction Stop } catch { continue }
        # 真正跑一下验证可用（Windows 应用商店的 python.exe 是占位程序，不能用）
        & $cmd.Source -c "import sys" *> $null
        if ($LASTEXITCODE -eq 0) { return $cmd.Source }
    }

    # ③ 扫常见安装目录 —— 覆盖"装了 Python 但没勾 Add Python to PATH"的情况
    #    用通配符 Python3*，所以将来出 3.13 / 3.14 / 3.15 也照样能找到
    $patterns = @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "C:\Python3*\python.exe",
        "C:\Program Files\Python3*\python.exe",
        "D:\Python3*\python.exe"
    )
    $found = @()
    foreach ($p in $patterns) {
        try { $found += Get-ChildItem -Path $p -ErrorAction SilentlyContinue } catch { }
    }
    # 版本号大的优先
    foreach ($f in ($found | Sort-Object FullName -Descending)) {
        & $f.FullName -c "import sys" *> $null
        if ($LASTEXITCODE -eq 0) { return $f.FullName }
    }

    # ④ 最后才靠 PATH
    foreach ($c in @('python3.exe', 'python.exe')) {
        try { $cmd = Get-Command $c -ErrorAction Stop } catch { continue }
        & $cmd.Source -c "import sys" *> $null
        if ($LASTEXITCODE -eq 0) { return $cmd.Source }
    }

    return $null
}

function Find-Node {
    $candidates = @(
        'D:\node.js\node.exe',
        'C:\Program Files\nodejs\node.exe',
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        'node.exe'
    )
    foreach ($c in $candidates) {
        try { $cmd = Get-Command $c -ErrorAction Stop } catch { continue }
        & $cmd.Source --version *> $null
        if ($LASTEXITCODE -eq 0) { return $cmd.Source }
    }
    return $null
}

# ---------------- 2. 找一个空闲端口 ----------------
function Test-PortFree([int]$port) {
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

# ---------------- 主流程 ----------------
Show-Header

# 优先用 Node.js：管理后台与匿名统计需要 server-app.js（同一个端口同时提供静态页和 /api）。
# 没有 Node 时退回 Python 纯静态服务 —— 识别功能照常，只是管理台和匿名统计用不了。
$node   = Find-Node
$python = $null
if (-not $node) { $python = Find-Python }

if (-not $python -and -not $node) {
    Write-Host '  [错误] 没有找到可用的 Python 或 Node.js，无法启动本地服务器。' -ForegroundColor Red
    Write-Host ''
    Write-Host '  解决办法（任选一种）：' -ForegroundColor Yellow
    Write-Host '    1. 安装 Python，安装时务必勾选 "Add python.exe to PATH"'
    Write-Host '    2. 安装 Node.js（https://nodejs.org）'
    Write-Host '    3. 用 VS Code 安装 Live Server 插件，'
    Write-Host '       然后右键 index.html 选择 "Open with Live Server"'
    Write-Host ''
    Read-Host '  按回车键退出'
    exit 1
}

$port = $null
foreach ($p in 8000, 8080, 8081, 8888) {
    if (Test-PortFree $p) { $port = $p; break }
}
if (-not $port) {
    Write-Host '  [错误] 8000 / 8080 / 8081 / 8888 端口都被占用了。' -ForegroundColor Red
    Write-Host '         请关闭占用端口的程序后重试。'
    Write-Host ''
    Read-Host '  按回车键退出'
    exit 1
}

$url = "http://localhost:$port/index.html"

if ($node) {
    Write-Host "  运行时 : Node.js  ($node)"
} else {
    Write-Host "  运行时 : Python   ($python)"
    Write-Host "  注意   : 当前只有纯静态服务，管理后台与匿名统计不可用。" -ForegroundColor Yellow
    Write-Host "           需要管理后台请安装 Node.js（https://nodejs.org）。" -ForegroundColor Yellow
}
Write-Host "  主页   : $url" -ForegroundColor Green
if ($node) { Write-Host "  管理台 : http://localhost:$port/admin.html" -ForegroundColor Green }

# 列出局域网地址：手机连同一个热点/路由器时用这个（不是 localhost）
$lanIps = @()
try {
    $lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.AddressState -ne 'Tentative' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -Unique
} catch {
    # 老系统上没有 Get-NetIPAddress，退回 WMI
    try {
        $lanIps = Get-WmiObject Win32_NetworkAdapterConfiguration -ErrorAction Stop |
            Where-Object { $_.IPEnabled -and $_.IPAddress } |
            ForEach-Object { $_.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } } |
            Where-Object { $_ -ne '127.0.0.1' -and $_ -notlike '169.254.*' } | Select-Object -Unique
    } catch { }
}
if ($lanIps) {
    Write-Host ""
    Write-Host "  手机访问（连同一个热点 / 路由器时用）：" -ForegroundColor Cyan
    foreach ($ip in $lanIps) {
        Write-Host "    http://${ip}:$port/index.html" -ForegroundColor Cyan
    }
    Write-Host "    注意：手机浏览器在普通 HTTP 下不允许用摄像头；" -ForegroundColor DarkGray
    Write-Host "          图片识别、视频文件识别、管理台都正常。" -ForegroundColor DarkGray
    Write-Host "    若手机打不开：检查 Windows 防火墙是否放行了本程序的网络访问。" -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  浏览器会自动打开。' -ForegroundColor Gray
Write-Host '  本窗口请不要关闭 —— 关掉它就等于停止服务。' -ForegroundColor Gray
Write-Host ''
Write-Host '  ------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ''

# 打开浏览器（稍等一下再开，保证服务器已经起来）
Start-Job -ScriptBlock {
    param($u)
    Start-Sleep -Milliseconds 1500
    Start-Process $u
} -ArgumentList $url | Out-Null

# 启动静态服务器（会一直运行，直到窗口关闭或按 Ctrl+C）
if ($node) {
    & $node "$PSScriptRoot\server-app.js" $port
} else {
    & $python -m http.server $port
}
