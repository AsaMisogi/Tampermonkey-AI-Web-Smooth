# AI Web Smooth

一个面向 ChatGPT 与 Google AI Studio 长对话页面的 Tampermonkey 用户脚本。它尝试利用浏览器的 `content-visibility` 等能力，减少离屏历史正文参与布局和绘制的开销，并把脚本自身的扫描与更新拆分为有预算的小批任务。

> [!IMPORTANT]
> 这是一个自用脚本，主要根据个人使用场景开发。虽然仓库包含本地夹具测试和合成压力基准，但尚未经过广泛、独立或真实生产环境验证，**无法确认在不同设备、浏览器、账号或对话结构下能带来多大的性能提升**。它也可能没有明显效果，甚至因网站更新而失效。请自行评估后使用。

## 功能

- 支持 `chatgpt.com`、旧版 `chat.openai.com` 和 `aistudio.google.com`。
- 仅尝试优化远离视口、尺寸较大的历史 `p` / `pre` 正文块。
- 保留最近两条消息的原生渲染，并在内容接近视口时提前恢复。
- 使用分级预热、空闲任务和逐帧提交，限制单批处理时间与目标数量。
- 普通输入期间降低后台处理预算，输入法组合输入期间暂停新增处理。
- 不删除消息，不修改站点框架状态，不读取或上传对话正文。
- 提供暂停、状态显示、诊断和可选会话导航菜单；自有导航默认关闭。

## 安装

1. 安装支持用户脚本的浏览器扩展，例如 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 [`AI-Web-Smooth.user.js`](https://github.com/AsaMisogi/Tampermonkey-AI-Web-Smooth/raw/main/AI-Web-Smooth.user.js) 安装脚本。
3. 只启用一份脚本，然后完整刷新已打开的 ChatGPT 或 Google AI Studio 页面。

脚本不需要构建、API Key 或额外运行时依赖。

如果直接安装链接没有唤起用户脚本管理器，可在仓库中打开 `AI-Web-Smooth.user.js`，点击 **Raw**，或新建用户脚本后粘贴文件全文并保存。

## 使用

安装后脚本会自动运行，页面默认不会增加悬浮按钮或导航入口。可从 Tampermonkey 菜单使用以下操作：

- 暂停 / 恢复优化
- 显示 / 隐藏状态按钮
- 诊断（不包含对话内容）
- 在 ChatGPT 中开启 / 关闭自有导航（默认关闭）

暂停时会撤回脚本已应用的优化；恢复后会逐步重新建立。禁用或删除脚本并刷新页面即可完全撤回。

## 工作方式与边界

脚本不会虚拟化整个消息列表，也不会移除历史消息。它只在通过安全检查的历史正文块上应用 `content-visibility: auto`，并利用 `ResizeObserver` 记录浏览器计算出的内容尺寸、利用 `IntersectionObserver` 在内容接近视口时恢复显示。

为尽量降低自身干扰，候选检查和状态协调会分批执行；观察目标、单块遍历和单条消息候选数都有上限。超过预算或包含交互控件、媒体、导航、编辑区域、`fixed` / `sticky` 后代的内容会保留网站原样。

这个方案不能消除站点首次加载、React / Angular 计算、Markdown 解析、网络、内存或 GPU 开销。刚打开超长对话时，优化也需要时间逐步建立。网站 DOM 或 CSS 更新后，脚本可能需要重新适配。

## AI Studio 无法注入

脚本已经匹配 `https://aistudio.google.com/*`，但浏览器或扩展权限仍可能阻止注入：

1. 在普通浏览器标签页中打开 AI Studio，而不是第三方应用内嵌页面。
2. 在扩展设置中允许 Tampermonkey 访问 `aistudio.google.com`。
3. Chrome / Edge 用户按 Tampermonkey 的提示启用“允许用户脚本”或所需的开发者模式。
4. 刷新页面后，从 Tampermonkey 菜单运行“诊断”，确认脚本是否成功注入。

相关说明可参考 Tampermonkey 官方 FAQ：[允许执行用户脚本](https://www.tampermonkey.net/faq.php?q=Q209)与[网站访问权限](https://www.tampermonkey.net/faq.php?locale=en&q=Q306)。

## 测试

仓库中的测试使用本地 HTML 夹具，不访问真实账号或对话。开发测试需要 Node.js、Playwright 以及 Chrome 或 Edge：

```powershell
node tests/run.cjs
node tests/input-benchmark.cjs
```

覆盖范围包括两种站点结构、长消息列表、滚动与宽度变化、流式更新、SPA 导航、暂停恢复、输入法组合事件、资源上限以及若干回归场景。详细结果见 [`tests/TEST-REPORT.md`](tests/TEST-REPORT.md)。

性能数据来自人为触发全历史重排的合成压力模型，样本数量有限。它不是站点真实实现、不是 INP，也不能用来推导实际提速倍数。真实登录态、不同硬件与浏览器版本、操作系统输入法，以及网站后续改版仍未充分验证。

## 隐私

脚本不发起网络请求，不上传诊断信息，也不保存聊天正文。它只保存启用状态、状态按钮和可选导航偏好，不修改站点自身的存储。

## 兼容性

- 当前版本：`1.3.0`
- 已进行本地夹具测试：Edge `152.0.4191.66`
- 未充分验证：真实登录态 ChatGPT / Google AI Studio、Firefox、Safari、系统输入法候选窗与未来网站版本

## 许可证

[MIT](LICENSE)。软件按“原样”提供，不附带任何明示或默示保证。
