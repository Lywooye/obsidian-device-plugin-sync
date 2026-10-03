# 0.3.4 mobile Sync compatibility

Validation date: 2026-10-03 (UTC).

- Fixed mobile 1.13.7 being compared with desktop-only method fingerprints. Desktop and mobile now select separate complete profiles; there is no per-method mixing or fallback. The version, all 12 method hashes, detached filter checks, readiness checks, and explicit local mobile opt-in still apply.
- Source evidence: the official Android 1.13.7 bundle matches all 12 fingerprints observed in the supplied iPhone diagnostics. The four differences from desktop are minified free-variable renames; the relevant helper dependencies were reviewed. This is not a complete iOS binary review or a real-device test. See [compatibility review](compatibility-review.md).
- With the reviewed mobile source supplied through `OBSIDIAN_MOBILE_APP_JS`, `npm run package` passed: type checking, **192 tests, zero failures, zero skips**, build, and ZIP packaging.
- `npm run test:native`: desktop 12 method fingerprints and 36 detached filtering assertions passed. `npm run test:mobile-native`: mobile 12 fingerprints and 56 filtering assertions passed.
- The 24 new test cases cover rejecting unreviewed bundles, cross-platform profile rejection, each changed method being rejected despite opt-in, isolated inspection, awaited storage, storage rejection, concurrent changes, native save/load restoration, and KeepAwake release. Storage and platform services are synthetic; actual method text and the relevant helpers come from the locally supplied bundle.
- Without the mobile source, 23 mobile-native cases explicitly skip, and the unreviewed-source rejection case still runs. With neither desktop nor mobile source, public CI is expected to skip 51 native cases. Tests never download native binaries or commit extracted source.
- The three runtime files were installed over the previous local installation after a backup. Obsidian displayed version 0.3.4; after re-enabling only this plugin, the desktop settings showed that compatibility checks passed. The shared policy was unchanged during replacement. No manual Sync application or cleanup was performed.
- This update does not extend the separate installation-observer or cleanup profiles. Mobile installation recognition and cleanup must still pass their own checks; manual registration remains available for unrecognized installations.
- Not tested: live phone/iPad transfers, real mobile IndexedDB durability, cold-start persistence, in-flight transfers, or cross-device deletion behavior. Mobile writes remain experimental and require an explicit choice on each device.
- Release-directory review and GitHub CI for this version are recorded separately once completed.

---

# 0.3.3 settings heading correction

- The 0.3.2 branch preview reported that a settings heading must not repeat the plugin name. The redundant page heading is now removed; the introductory text and all controls remain.
- Removed the now-unused `setHeading` test stub introduced in 0.3.2.
- `npm run package`: type checking, all 168 tests (zero failures, zero skips), build, and ZIP packaging passed.
- No synchronization, cleanup, saved data, or compatibility behavior changed.
- On 2026-10-02 (UTC), the directory branch preview and the full 0.3.3 release review both completed for commit `4c4064fadb86f571e7bf4c23ee8a502bdbdd8eb9`. The report contained warnings and recommendations, with no blocking errors.
- The public listing showed **Review: Satisfactory** and an enabled **Add to Obsidian** link. This confirms directory availability, not phone/iPad or end-to-end Sync correctness.
- GitHub CI also passed for the same source commit. Uploaded runtime asset digests matched the local build; ZIP runtime files matched byte-for-byte.

---

# 0.3.2 community review fixes

- The 0.3.1 directory review reported two blocking errors: the manifest description included the redundant product name, and the settings heading used a raw HTML element.
- The description now retains the paid Sync requirement without that word. The settings heading uses `Setting.setHeading()`; its test double implements the same method.
- `npm run package`: type checking, all 168 existing tests (zero failures, zero skips), build, and ZIP packaging passed.
- The remaining source warnings were reviewed. Method calls preserve their receiver, control-character checks and runtime thenable validation remain intentional, and actual vault paths continue to use `vault.configDir`.
- No Sync behavior, saved policy, installed-plugin state, or compatibility guard was changed. Device/network validation limits remain unchanged.
- This records local validation; acceptance of the new release still requires the directory review.

---

# 0.3.1 public release validation

- Public display name changed to Device Selective Sync; the plugin ID, shared-file paths, and local storage keys remain compatible with 0.3.0.
- `npm run package`: type check, all 168 tests (zero failures, zero skips), browser bundle, and release ZIP passed on the maintainer's desktop.
- No new runtime behavior was added for publication; packaging now recreates its output folder to exclude stale files.
- Public GitHub CI runs type checking, tests, and the build. Without a local Obsidian ASAR, 28 native fixture cases are intentionally skipped; this is not equivalent to the complete maintainer test run.
- Public docs and the explicit source-file list were checked for private vault/device names, local user paths, credentials, and copied native code. Backups and generated binaries are excluded from Git; runtime files are attached to the release.
- MIT license, exact-version release metadata, version compatibility map, English and Chinese guides, and account/paid-service/private-API disclosures are included.
- Real phone/iPad transfers, cold-start persistence, first-download timing, and community-directory acceptance remain unverified.

---

# 0.3.0 验证记录

日期：2026-10-01。

- 新增按安装来源设置默认同步范围：电脑新装只给电脑；手机/iPad 新装给来源设备和所有电脑。已有 ID 的人工选择优先，不重置更新。
- 独立安装记录、首次基线、失败重试、只处理新 ID 的自动排除和手动补登记入口均已实现。自动流程不弹清理窗口、不移走插件、不写共享启用列表。
- `npm run package`：类型检查、168 项测试（0 失败、0 跳过）、构建及 ZIP 打包通过。
  - 69 项 UI 模拟测试：绑定、默认值、队列重启、只读重试、部分应用状态、中英文登记，以及异步关闭、换绑定和保存期间的队列保留。
  - 10 项新增规则测试：来源、已有选择优先、重复记录、路径和旧排除保持。
  - 10 项安装观察器测试：读取实际桌面 1.13.7 函数，在模拟对象执行，不调用真实安装、网络或仓库写入。
  - 原有 Sync、清理、事务及本地记录测试保留。
- `npm run test:native`：原有 12 个方法指纹和 36 项过滤断言通过。安装方法另由上述观察器测试核验。
- 没有在真实设备安装新插件验证来源识别；没有验证手机/iPad、真实网络传输、首次下载时序或重启持久化。

## 0.3.0 本地安装核对

- 运行文件与源码构建及 ZIP 内字节一致；安装前后的共享清单与启用插件集合保持不变。
- 本轮只更新运行文件，未重载插件、未登记真实新插件、未应用排除、未清理文件。因此不将安装文件核对当成真实界面、自动安装识别或跨设备验证。
- 手机和 iPad 需分别加载新版、绑定各自设备并开启实验功能；实际行为仍待验证。

---

# 0.2.0 验证记录

日期：2026-10-01。

- 新增应用成功后可选清理、默认不勾选和再次确认；把完整插件目录移入本机隐藏备份。支持查看备份并放回，禁止覆盖现有插件。
- 清理独立检查当前已应用选择、排除列表、插件停止方法、同步循环及暂停/空闲状态；失败不自动清理或永久删除。
- 全界面支持简体中文和英文，语言偏好只保存本机；旧记录迁移保留中文，新安装跟随 Obsidian。
- 按首次使用者视角重写设置、预览、恢复同步和故障处理文案；这是模拟审查，不是真人用户研究。
- `npm run package`：类型检查、124 项测试（0 失败、0 跳过）、构建和 ZIP 打包全部通过。
  - 原规则/路径、记录、保存事务和 Sync 适配测试保留；更改文字对应的断言，不放宽行为约束。
  - 45 项界面模拟测试，执行实际主模块，覆盖手机/电脑清理提示、双重确认、暂停、取消、备份、找回、冲突、英文流程和语言偏好。
  - 10 项清理文件模型测试，覆盖完整设置备份、边界路径、自身保护、部分失败、目录碰撞和已移动但监听刷新失败的结果核对。
  - 9 项清理内部接口测试，读取实际桌面 1.13.7 方法，在合成对象上核对暂停状态、停止实例、启用名单与过滤行为。
- `npm run test:native`：12 个原有 Sync 方法指纹及 36 项离线过滤断言通过。新增清理方法由上述 9 项测试单独核对。
- ZIP 只含三个运行文件，完整性已检查。
- 未在真实仓库清理任何用户插件；真实手机/iPad、双端传输、清理后的云端内容和重启持久化仍待验收。

## 0.2.0 本地安装核对

- 三个运行文件与 0.2.0 ZIP 内文件一致。安装前后的共享清单与启用插件集合保持不变。
- 本轮未重载插件、未应用同步选择、未暂停 Sync，也未清理或找回用户插件。实际界面和手机/iPad 行为未据此验证。
- 中文、英文以及手机/电脑清理与找回流程由 DOM 模拟测试覆盖。

---

# 0.1.2 验证记录

日期：2026-10-01。

- 手机/iPad 可从共享清单编辑本机列；保留电脑全矩阵管理、旧规则和默认值。
- “保存并应用”先打开预览；最终确认才保存本机列并应用。无变化不增加修订号。
- 本机文本、绑定、兼容状态、原生列表、管理记录变化时停止；共享规则保存成功而原生应用失败会明确提示部分完成。
- `npm run package`：类型检查、86 项测试（0 失败、0 跳过）、构建、打包全部通过。其中 UI 模拟 30 项，执行实际主模块，Obsidian UI/API 与 Sync 适配器使用替身。
- 新增 18 项 UI 用例覆盖：手机/iPad 单列编辑、本机缺少插件仍使用共享清单、其他列/清单/身份/插件文件保留、两段确认、批量选择/取消、无变化修订号、只读门禁、预览后状态变化、保存过程中变化与原生保存失败。
- `npm run test:native`：桌面 1.13.7 的 12 个方法指纹和 36 项离线过滤断言通过。
- 这些测试不包含手机/iPad 真机、真实跨设备网络传输、重启持久化或进行中传输取消。
- 多端同时离线编辑仍可能冲突；本机文本比较不是分布式锁。README 已列明串行编辑和失败恢复步骤。

## v0.1.2 本地安装与桌面界面核对

- 三个运行文件的摘要与 0.1.2 ZIP 内文件一致。
- 通过真实 Obsidian 界面仅停用并重新启用本插件，设置页正常加载，桌面 1.13.7 兼容检查通过。
- 共享清单摘要、现有选择与启用插件集合保持不变，没有发布新选择或应用原生排除。社区插件列表仍可能使用旧清单缓存，不把版本标签作为唯一依据。
- 本轮手机与 iPad 流程由模拟测试覆盖，未实际操作移动设备。

---

# 0.1.1 验证记录

日期：2026-10-01。

- 矩阵改为勾选允许同步，电脑默认全选，手机/iPad 默认全不选。
- 各设备列新增全选/全不选；新设备、新发现插件按相同平台默认值处理。
- 旧已配置规则保留含义；旧版 r1 空排除初始模板只在编辑草稿中使用新默认值，发布前不写规则文件。
- `npm run check`、`npm test`：68 项通过、0 失败、0 跳过；其中设置界面模拟测试 12 项。
- 本轮安装和桌面界面核对见下方安装记录；手机/iPad 真机传输仍未验证。

## 2026-10-01 本地安装与真实桌面界面核对

- 运行文件与 0.1.1 ZIP 一致；仅停用并重新启用本插件后，新选择表在实际桌面界面运行。
- 核对电脑默认全选、手机和平板默认全不选；手机列的全选与全不选只改变该列。
- 没有发布选择或应用排除，清单摘要与安装前一致。桌面 1.13.7 兼容检查通过；没有手机/iPad 或真实传输验证。
- 本轮原生检查再次通过 12 个方法指纹及 36 项离线断言。

---

# 0.1.0 验证记录

日期：2026-09-27。环境：macOS 26.5.1（25F80），Node.js 22.22.3，Obsidian 桌面安装包 1.13.7。

- `npm run check`：TypeScript 严格检查通过。
- `npm test`：62 项测试通过，0 失败，0 跳过。
  - 规则和路径规划：16 项。
  - 本机状态校验：12 项。
  - 保存事务与中断恢复：12 项。
  - Sync 适配器：16 项。读取实际安装包方法，在隔离模拟对象上测试；数据库为测试替身。
  - 设置界面流程：6 项。执行实际插件主模块，Obsidian UI/API 和 Sync 适配器为测试替身。
- `npm run package`：检查、测试、构建和 ZIP 打包通过。
- `npm run test:native`：12 个方法指纹、36 项原生过滤器离线断言通过。
- ZIP 已核对，仅含 `device-plugin-sync/` 下的 `main.js`、`manifest.json`、`styles.css`，摘要见 `dist/SHA256SUMS.txt`。

以上检查没有操作真实仓库、既有插件或真实 Sync 数据库。没有执行真实桌面 UI 加载、真实 Sync 网络传输、冷启动持久化、手机或 iPad 真机验收；没有证据证明在途传输会被取消。

移动设备显示 1.13.7 仅提供版本信息，设备上的函数指纹与运行结果仍需在插件设置页检查。实验适配通过不等于端到端同步验证通过。真实设备步骤见 [device-validation.md](device-validation.md)。
