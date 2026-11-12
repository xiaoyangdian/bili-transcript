# 下载 B 站视频 / 合集：实践笔记

配套脚本：`scripts/download_bili_collection.py`。

## 为什么不能直接用项目主流程

项目的 `fetcher.download_audio()` 用 yt-dlp 的 `bestaudio/best` 只取音频，目的是转写字幕，不会保存可播放的视频。要保存完整 mp4，得单独用 yt-dlp 下 `bestvideo + bestaudio` 再合并。

## 合集有两种，yt-dlp 默认只给一个

B 站的「合集」通常是 **UGC 合集（跨多个 BV 号）**，不是多 P。把单个 BV 的 URL 交给 yt-dlp，即使页面侧栏显示「合集·共 14 集」，`extract_info()` 也只返回 1 个视频，不会自动展开。

可靠的做法是先调 B 站公开接口，自己展开列表：

```
GET https://api.bilibili.com/x/web-interface/view?bvid=<BV号>
  → data.ugc_season.title                    合集名
  → data.ugc_season.sections[].episodes[]    每集的 bvid / title / page.duration
  → data.pages[]                            分 P（本例只有 1 P）
```

接口需要带 `User-Agent` 和 `Referer: https://www.bilibili.com/`，公开视频无需登录。脚本里 `collect_episodes()` 对「没有 ugc_season 的普通视频」退化为单集，所以同一个脚本也能下单个视频。

## 画质与 cookie

未登录时能拿到的格式（实测 `BV1pV411J7qj`）：

| 格式 ID | 内容 | 码率 |
|---|---|---|
| 30064 | 600x536 AVC 视频 | 1792k |
| 30066 | 600x536 HEVC 视频 | 1081k |
| 30032 / 30016 | 480P / 360P AVC | 804k / 365k |
| 30280 / 30232 / 30216 | m4a 音频 | 127k / 127k / 67k |

老视频源分辨率本身就低，600x536 已是不登录的上限。想上 1080P/4K/大会员画质需要 cookies。注意 **Chrome 运行时 cookie 数据库被锁**，`--cookies-from-browser chrome` 会报 `Could not copy Chrome cookie database`；Edge 则可能报 `Failed to decrypt with DPAPI`。要解决得关掉浏览器，或手动导出 Netscape 格式 cookie 文件再传 `--cookies <file>`。

## DASH 分离流必须合并

B 站视频和音频是分开的流，只下 `best` 会得到无声音或无声视频。脚本的设置：

- `format`: `bestvideo[vcodec^=avc1]+bestaudio/best` —— 限定 AVC 避开 HEVC 的播放器兼容问题，失败再回退；
- `merge_output_format`: `mp4`；
- `ffmpeg_location`: `imageio_ffmpeg.get_ffmpeg_exe()` —— **系统没装 ffmpeg**，torchaudio 也提示过 `ffmpeg is not installed`，所以必须显式把项目自带的 ffmpeg 路径交给 yt-dlp，否则合并会失败。

合并结果可用 `av` 校验：`h264 600x536 + aac`，时长与接口返回一致。

## Windows / 本机环境的坑

- `uv` 不在 PATH，全路径为 `D:\tools\uv-pkg\bin\uv.exe`；项目依赖在 `.venv`，脚本直接用 `.venv\Scripts\python.exe` 跑。
- cmd 下必须设 `PYTHONIOENCODING=utf-8`（`PYTHONUTF8=1` 更稳）：rich 输出的 `✓` 在 GBK 控制台会抛 `UnicodeEncodeError`；含 emoji / 中文的文件名直接通过命令行传参也容易出错，所以统一用 Python 脚本驱动。
- 模型与缓存都放 D 盘：`MODELSCOPE_CACHE`、`HF_HOME`、`UV_CACHE_DIR`，别写进 C 盘。
- 输出目录默认 `temp/<合集名>`。`temp/` 已被 `.gitignore` 忽略，GB 级视频不会误入库；`output/` 是**要入库**的，两者别混。
- 脚本对已存在且大于 1 MB 的 mp4 自动跳过，配 `continuedl=True` 可断点续传；单集失败不中断后续集数。可以分几次跑，下次直接重跑同一条命令即可。

## 常用命令

```bash
# 只看合集清单，不下载
.venv\Scripts\python.exe scripts/download_bili_collection.py BV1pV411J7qj --list

# 下载全部 14 集
.venv\Scripts\python.exe scripts/download_bili_collection.py BV1pV411J7qj

# 只补第 8、9 集；或指定别的输出目录
.venv\Scripts\python.exe scripts/download_bili_collection.py BV1pV411J7qj 8 9
.venv\Scripts\python.exe scripts/download_bili_collection.py BV1pV411J7qj -o "D:\video\QQ堂集锦"
```

## 本次实测

- 链接 `https://www.bilibili.com/video/BV1pV411J7qj/` 属于 UGC 合集「**QQ堂集锦**」，共 **14 集**，合计约 **197 分钟**；该 BV 是第 8 集，分 P 数为 1。
- 第 8 集下载成功：`08 - 2021年QQ堂新年精彩集锦（v的祖先来也——技猫篇）.mp4`，**147.7 MB**，10.73 分钟，h264 600x536 + aac。
- 按此码率估算全量约 **2.7 GB**，D 盘剩余 59.3 GB，空间充足。
- **进度：只下了第 8 集，其余 13 集留待下次**。重跑不带参数的命令会自动跳过已完成的第 8 集，继续补完。
