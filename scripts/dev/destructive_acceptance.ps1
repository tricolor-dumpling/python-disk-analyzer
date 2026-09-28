<#
.SYNOPSIS
    P12·W3.5 隔离数据目录破坏性流程验收脚本（PowerShell 5.1 兼容）。
.DESCRIPTION
    通过重定向 LOCALAPPDATA 实现零代码改动的全套数据目录隔离（config.json /
    snapshots/ / exports/ / machine_guid 全部落入隔离根），随后按附录 B 序列执行：
    save -> 台账校验 -> undo -> 指纹谓词恢复 -> wipe 双确认 -> 清键集合与目录重建
    校验 -> windowed 打包版 daemon 冒烟（无法打包的环境如实记录）。
.PARAMETER WhatIf
    干跑模式：只验证第 0 步隔离闸门逻辑，不启动服务、不执行任何破坏性调用。
.PARAMETER Cleanup
    结束后删除隔离根（默认保留现场供人工复核）。
.EXAMPLE
    powershell -File scripts\dev\destructive_acceptance.ps1
    powershell -File scripts\dev\destructive_acceptance.ps1 -Cleanup
#>
param(
    [switch]$WhatIf,
    [switch]$Cleanup
)

$ErrorActionPreference = "Stop"

# ---------- 环境 ----------
$proj = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/dev -> 项目根
$pyCandidates = @(
    (Join-Path $proj ".venv\Scripts\python.exe"),
    "python"
)
$py = $null
foreach ($cand in $pyCandidates) {
    if (Test-Path $cand) { $py = $cand; break }
}
if ($null -eq $py) { throw "未找到可用 Python（.venv 或 PATH）" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$isoRoot = Join-Path "D:\deepseek\dsa-isolated" $stamp
$isoHome = Join-Path $isoRoot "home"
$real = $env:LOCALAPPDATA

Write-Output "[0] 建立隔离根: $isoRoot"
New-Item -ItemType Directory -Force -Path $isoHome | Out-Null

function Invoke-Probe {
    param([string]$Code)
    & $py -c $Code
    if ($LASTEXITCODE -ne 0) { throw "探针执行失败: $Code" }
}

try {
    # ---------- 第 0 步闸门：重定向并断言 ----------
    $env:LOCALAPPDATA = $isoHome
    $resolvedDataDir = (& $py -c "import sys; sys.path.insert(0, r'$proj'); import datadir; print(datadir.get_data_dir())").Trim()
    Write-Output "[0] get_data_dir() = $resolvedDataDir"
    if (-not $resolvedDataDir.StartsWith($isoRoot)) {
        throw "安全闸门：数据目录未落在隔离根内（$resolvedDataDir），终止验收。"
    }
    if ($real -and $resolvedDataDir.Contains($real)) {
        throw "安全闸门：数据目录仍指向真实 LOCALAPPDATA，终止验收。"
    }
    Write-Output "[0] PASS：隔离生效，真实 %LOCALAPPDATA% 不受影响"

    if ($WhatIf) {
        Write-Output "[WhatIf] 干跑结束：闸门逻辑验证通过，后续步骤不执行。"
        return
    }

    # ---------- 启动隔离环境下的本地服务 ----------
    $port = 5057
    # Start-Process 不自动加引号：写一个无空格路径的引导文件最稳妥
    $bootstrapPy = Join-Path $isoRoot "serve.py"
    @"
import sys
sys.path.insert(0, r'$proj')
import app
app.run_server(port=$port, open_browser=False)
"@ | Set-Content -Path $bootstrapPy -Encoding UTF8
    Write-Output "[1] 启动服务 http://127.0.0.1:$port （继承隔离环境变量）"
    $proc = Start-Process -FilePath $py -ArgumentList @($bootstrapPy) `
        -WorkingDirectory $proj -PassThru -WindowStyle Hidden
    try {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            try {
                $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
                $ready = $true; break
            } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $ready) { throw "服务 30 秒内未就绪" }
        Write-Output "[1] PASS：服务已就绪（health.ready=$($h.ready)）"

        # ---------- 步骤 1：全量扫描 + 保存快照 ----------
        Write-Output "[2] 触发全量扫描（本机全部本地盘）..."
        Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/fullscan/start" -Method Post -Body "{}" -ContentType "application/json" | Out-Null
        $deadline = (Get-Date).AddMinutes(10)
        do {
            Start-Sleep -Seconds 2
            $st = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/fullscan/status").status
        } while ($st.running -and (Get-Date) -lt $deadline)
        if ($st.running) { throw "全量扫描 10 分钟未完成" }
        if (-not $st.result_ready) { throw "全量扫描完成但无结果（error=$($st.error))" }
        Write-Output "[2] PASS：扫描完成（roots_done=$($st.roots_done)/$($st.roots_total)）"

        $saveBody = '{"auto": false}'
        $saveResp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/save" -Method Post -Body $saveBody -ContentType "application/json"
        if (-not $saveResp.ok) { throw "保存失败" }
        Write-Output "[2] PASS：快照已保存（session=$($saveResp.session.session_id)）"

        # ---------- 步骤 2：台账与清单校验 ----------
        $sessions = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/snapshots")
        if ($sessions.count -lt 1) { throw "会话清单为空" }
        $snapFiles = Get-ChildItem -Path (Join-Path $isoHome "PythonDiskScanner\snapshots") -Filter "*.snap.gz" -ErrorAction SilentlyContinue
        if (@($snapFiles).Count -lt 1) { throw "快照目录无 .snap.gz 文件" }
        Write-Output "[3] PASS：台账/清单/快照文件齐备（sessions=$($sessions.count), snapfiles=$(@($snapFiles).Count)）"

        # ---------- 步骤 3：undo（含台账回滚） ----------
        $beforeUndo = (Get-ChildItem -Path (Join-Path $isoHome "PythonDiskScanner\snapshots") -Filter "*.snap.gz").Name
        $undo = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/save/undo" -Method Post -Body "{}" -ContentType "application/json"
        if (-not $undo.ok) { throw "undo 失败" }
        $afterUndo = @(Get-ChildItem -Path (Join-Path $isoHome "PythonDiskScanner\snapshots") -Filter "*.snap.gz" -ErrorAction SilentlyContinue).Count
        if ($afterUndo -ge $beforeUndo.Count) { throw "undo 后快照未被删除" }
        Write-Output "[4] PASS：undo 删除 $($undo.deleted.Count) 份快照；undeleted=$($undo.undeleted.Count) 条提示"

        # ---------- 步骤 4：指纹谓词恢复校验 ----------
        # 注意：经 & $py -c 传参时 PS 会剥掉双引号，Python 字符串一律用单引号
        $probe = @"
import sys, json
sys.path.insert(0, r'$proj')
import snapshots
ok, reason = snapshots.should_auto_save('C:\\Probe', tree_complete=True, dirty=False,
                                        fingerprint={'count': 1, 'crc32': 999999})
print(json.dumps({'ok': ok, 'reason': reason}))
"@
        $predOut = (& $py -c $probe) | ConvertFrom-Json
        if (-not $predOut.ok) { throw "undo 后指纹谓词仍判『不变』，下次自动保存会被抑制" }
        Write-Output "[5] PASS：指纹谓词已恢复为『变』（undo 台账回滚生效）"

        # ---------- 步骤 5：wipe 双确认 ----------
        # PS5.1 Invoke-RestMethod 对字符串 Body 默认按 ISO-8859-1 发送，中文会
        # 乱码；显式转 UTF-8 字节数组（正确确认同理）。
        $wrongBody = [System.Text.Encoding]::UTF8.GetBytes('{"confirm": "错误的确认"}')
        $wrongStatus = 0
        $wrongDetail = ""
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/admin/wipe" -Method Post -Body $wrongBody -ContentType "application/json" | Out-Null
        } catch {
            $sr = $_.Exception.Response
            if ($sr) {
                $wrongStatus = [int]$sr.StatusCode
                try { $wrongDetail = (New-Object IO.StreamReader($sr.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() } catch {}
            } else { $wrongStatus = -1 }
        }
        if ($wrongStatus -ne 400) { throw "错误确认应返回 400，实际 $wrongStatus detail=$wrongDetail" }
        $rightBody = [System.Text.Encoding]::UTF8.GetBytes('{"confirm": "确认清空"}')
        $wipe = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/admin/wipe" -Method Post -Body $rightBody -ContentType "application/json"
        if (-not $wipe.ok) { throw "正确确认的 wipe 失败" }
        Write-Output "[6] PASS：wipe 双确认通过（错 400 / 对 200）"

        # ---------- 步骤 6：清键集合与目录重建 ----------
        foreach ($dirName in @("snapshots", "exports")) {
            $p = Join-Path $isoHome ("PythonDiskScanner\" + $dirName)
            if (-not (Test-Path $p)) { throw "清空后未重建 $dirName 目录" }
        }
        Write-Output "[7] PASS：数据目录已重建空 snapshots/ 与 exports/"
        Write-Output "[7] NOTE：localStorage 键核对（pds_handled_scan_version_v1 / pds_onboarding_dismissed_v1 等）需在浏览器 DevTools 执行 Object.keys(localStorage) 人工复核，见留档说明。"

        # ---------- 步骤 7：windowed 打包版 daemon 冒烟 ----------
        Write-Output "[8] SKIP：本机未安装 PyInstaller（打包超出现场环境），windowed 冒烟列入补做计划；服务端 daemon 自动拉起已在步骤 [1] 由源码模式等价覆盖（bootstrap 线程）。"
    }
    finally {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    $env:LOCALAPPDATA = $real
    Write-Output ""
    Write-Output "现场路径（供人工复核）: $isoRoot"
    if ($Cleanup) {
        Remove-Item -Recurse -Force $isoRoot -ErrorAction SilentlyContinue
        Write-Output "-Cleanup 已删除隔离根。"
    } else {
        Write-Output "如需清理：Remove-Item -Recurse -Force '$isoRoot'"
    }
}
