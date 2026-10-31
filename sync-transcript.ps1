<#
一键：提取 B 站视频文字稿（txt/srt/json）到 output/。

转写完成后不会直接归档；请让 agent 加载 skill
polishing-and-syncing-transcripts，由它润色、按主题分类并同步到观后感目录。

用法：
  .\sync-transcript.ps1 BV1U8xi6UESL
  .\sync-transcript.ps1 "https://www.bilibili.com/video/BV1U8xi6UESL/" -Model base
  .\sync-transcript.ps1 BV1U8xi6UESL -ForceWhisper
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Video,

    [string]$Model = "small",

    [switch]$ForceWhisper
)

$ErrorActionPreference = "Stop"
$uv = "C:\Users\DELL\.local\bin\uv.exe"

# 本机必需的降级版本；uv run 会按 lock 文件回滚，所以每次运行前先确保一遍
& $uv pip install --quiet "ctranslate2==4.4.0" "onnxruntime==1.20.1" "setuptools<81" --default-index https://pypi.org/simple

# Chrome 运行时 Cookie 数据库被锁，这里固定传空 Cookie；如已关闭浏览器可自行改回 chrome
$cliArgs = @($Video, "-f", "all", "-m", $Model)
if ($ForceWhisper) { $cliArgs += "--force-whisper" }

& $uv run --no-sync python -c "import sys; sys.argv=['bt']+sys.argv[1:]+['--cookies-from-browser','']; from bili_transcript.cli import main; main()" @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "转写完成，产物在 output/。下一步：让 agent 加载 skill polishing-and-syncing-transcripts"
Write-Host "（润色修正 → 按主题分类 → 同步到 E:\work\网上视频观后感\<分类>\）。"
