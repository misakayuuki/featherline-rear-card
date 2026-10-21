# Featherline 背屏适配 v0.2.0（测试版）

基于 Featherline 1.4.2 的第三方适配版，将雌二醇模型估算、下次计划用药倒计时和今日记录进度推送到 rear-card-bridge API 2。

## 新增

- 卡片桥内的模块设置页：五种主题、自定义强调色与背景色、趋势显示开关、隐私模式、镜头避让、恢复默认及外观预览。
- 无数据时显示安装及同步指引，提供适配版 GitHub 地址；设置页提供可点击的下载链接。
- 主题配置在后续同步和覆盖更新时保留；App 每次推送都包含完整设置页。
- 自定义浅色或接近的颜色会自动调整文字对比度。设置页预览使用示例数据。
- 修正仓库的源码忽略规则，完整纳入 Android 的 `src/` 目录；此前下载的源码 ZIP 已包含这些文件。

## 从 0.1.0 更新

直接覆盖安装新版 APK，打开 **Featherline → 设置 → 外观 → Featherline 背屏 → 立即同步**。然后在 **卡片桥 → 本模块 → 设置页面** 中调整外观。无需卸载旧测试版。APK 和模块的 versionCode 均升级为 2，调试签名保持一致。

## 下载与安装

- `Featherline-RearCard-0.2.0-arm64-debug.apk`：手机安装包，与官方版并存，桌面名称为 Featherline 背屏测试版。
- `Featherline-RearCard-0.2.0-source.zip`：完整修改源码、模块源码及测试，遵循 GPL v3。
- `featherline-rear-card-0.2.0.zip`：可选的空数据初始模块；正常使用无需单独安装，App 会发送完整卡片。

先安装支持 API 2 的卡片桥和测试版 App。从官方版导出加密备份并恢复到测试版，然后在 **设置 → 外观 → Featherline 背屏 → 开启同步并绑定**，按提示重新应用系统背屏载体。两版数据独立，之后需在测试版中继续记录。

## 同步与隐私

记录或计划变化后触发同步，平时后台约 15 分钟择机更新；间隔目前固定，卡片桥内没有调整选项。背屏运行期间每分钟重绘浓度估算和倒计时。省电和休眠可能延迟更新。

同步默认关闭。开启后卡片桥会保存一份摘要，应用锁无法保护该副本。关闭会发送空数据，但载体需下次读取才会清空；要删除桥内模块数据，请在卡片桥卸载模块。模型估算不是血检实测值，倒计时不自动记录用药。

## 验证状态

APK 构建及签名核验通过，源码与编译资源共74项测试通过。设置页已检查手机尺寸布局、主题切换、自定义颜色、隐私及保存后重开。原数据计算与日程算法未改动。完整 Android lint 未完成，尚未真机验证，故作为预发布测试版本提供。

完整安装说明和限制见 [README](https://github.com/misakayuuki/featherline-rear-card/blob/main/README.md) 与 [验证记录](https://github.com/misakayuuki/featherline-rear-card/blob/main/VERIFICATION.md)。

上游：[Featherline](https://github.com/mkx173/Featherline) · [rear-card-bridge](https://github.com/finall1008/rear-card-bridge)。本版本不是上游官方发布。
