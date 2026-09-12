// ==UserScript==
// @name         AI Web Smooth · 长会话渲染优化
// @namespace    local.ai-web-smooth
// @version      1.3.0
// @description  ChatGPT / Google AI Studio 长会话分块渲染；分级预热与按帧提交，输入保护，自有导航默认关闭。
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://aistudio.google.com/*
// @run-at       document-idle
// @noframes
// @sandbox      DOM
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
    'use strict';

    /**
     * v1.3：有界启动预热、复杂块增量检查、空闲准备与按帧提交分离。
     *
     * content-visibility:auto 隐含布局/绘制包含。应用于消息外壳时，可能改变
     * fixed/sticky 后代的定位、裁剪、观察器所见几何关系。这里绝不优化消息外壳、
     * 工具栏、滚动容器，也不修改平台自己的 IntersectionObserver 或框架状态。
     *
     * 仅让远离视口的历史 p/pre 暂缓渲染：
     * - ResizeObserver 提供真实内容盒尺寸，避免统一估高导致滚动位置漂移。
     * - IntersectionObserver 提前恢复临近视口的块，屏幕内保持站点原始布局。
     * - 保留最近两条消息，不在流式 token/输入路径做整页查询。
     * - DOM 始终保留；无 content-visibility:hidden、移除消息或网络请求。
     *
     * 本脚本降低渲染开销，不消除宿主框架计算和内存增长，无法保证无限会话零卡顿。
     */
    const CONFIG = Object.freeze({
        keepRecent: 2,           // 最近两个消息容器不处理，覆盖用户输入和模型回复。
        viewportMargin: 800,    // 提前恢复上下 800px 内的内容；实际范围还受嵌套滚动裁剪影响。
        reconcileDelay: 240,    // 结构变更合并，正文变化只重新检查所属消息。
        minBlockSize: 48,       // 很小的块收益有限，不写入优化属性。
        sliceMs: 3,             // 脚本主动工作预算；不包含浏览器稍后的布局 / GC。
        sliceSteps: 1200,       // 时钟精度较低时仍有步骤上限；时间预算通常先触发。
        sliceEffects: 48,       // 每批最多处理 48 个观察 / 写入目标，时间预算仍优先。
        sliceInterval: 32,      // 无空闲回调 API 时的定时器批次间隔。
        inputQuietMs: 600,      // 普通输入后的低预算窗口；不停工，避免长会话迟迟不能减负。
        typingSliceMs: 1.5,     // 普通输入中仅进行少量历史优化，尽早降低下一次输入的布局成本。
        warmupMs: 4000,         // 初入会话预热窗口；仅队列未完成时运行，完成即停止。
        warmupSliceMs: 6,       // 预热仍有单批上限，不把全会话一次处理完。
        bootstrapMs: 12,        // 每次启动的预热批次预算；比把全部工作推迟到打字后更早减负。
        idleTimeout: 250,       // 页面持续繁忙时执行有界进度，不因网站重排而无限饿死。
        maxBlocks: 1800,        // 每页观察目标上限，超过预算的内容保留网站原样。
        maxBlockNodes: 4000,    // 超复杂正文块保守跳过，避免检查一个 pre 遍历无限高亮节点。
        maxMessageCandidates: 16000, // 单条消息候选检查上限；不限制网站展示的内容。
    });
    const HOST_ID = 'ai-web-smooth-control-v1';
    const STYLE_ID = 'ai-web-smooth-style-v1';
    const COLD = 'data-ai-web-smooth-cold';
    const SIZE = '--ai-web-smooth-block-size';
    const STORAGE_KEY = `ai-web-smooth:v1:${location.hostname}`;
    const chat = {
        name: 'ChatGPT',
        selector: ':is(article,section,div)[data-testid^="conversation-turn-"]',
        accepts: (element) => /^conversation-turn-\d+$/.test(element.getAttribute('data-testid') || ''),
    };
    const adapter = {
        'chatgpt.com': chat,
        'chat.openai.com': chat,
        'aistudio.google.com': { name: 'Google AI Studio', selector: 'ms-chat-turn', accepts: () => true },
    }[location.hostname];
    if (!adapter || !document.body || document.getElementById(HOST_ID)) return;

    const supported = typeof CSS !== 'undefined'
        && CSS.supports('content-visibility', 'auto')
        && CSS.supports('contain-intrinsic-block-size', 'auto 1px')
        && CSS.supports('selector(:where(*))')
        && typeof IntersectionObserver === 'function' && typeof ResizeObserver === 'function';

    function readSettings() {
        try {
            const value = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, {}) : {};
            return {
                enabled: value?.enabled !== false,
                // 旧版 true 可能只是默认值。升级时统一隐藏；新版用户主动显示后才保留。
                panelVisible: value?.uiVersion === 2 && value?.panelVisible === true,
                navigationEnabled: value?.navigationVersion === 1 && value?.navigationEnabled === true,
                navigationVersion: 1,
                uiVersion: 2,
            };
        } catch { return { enabled: true, panelVisible: false, navigationEnabled: false, navigationVersion: 1, uiVersion: 2 }; }
    }
    const settings = readSettings();
    function saveSettings() {
        try {
            if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, { ...settings });
        } catch { /* 存储受限时，本页依然可用；不读写平台 localStorage。 */ }
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* 零特异性：站点明确设置的虚拟化/隐藏规则优先。只选择脚本标记的正文。 */
        :where([${COLD}]) {
            content-visibility: auto;
            contain-intrinsic-block-size: auto var(${SIZE});
        }
        :where([${COLD}]:focus-within) { content-visibility: visible; }
        @media print {
            :where([${COLD}]) { content-visibility: visible; }
            #${HOST_ID} { display: none !important; }
        }
    `;
    (document.head || document.documentElement).append(style);
    const host = document.createElement('div');
    host.id = HOST_ID;
    // 从插入前就隐藏，避免首帧闪现或透明元素拦截原生导航按钮。
    host.style.cssText = 'display:none;position:fixed;right:12px;top:84px;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'open' });
    const panelStyle = document.createElement('style');
    panelStyle.textContent = `
        button { font:12px/1.4 system-ui,sans-serif;color:#f8fafc;background:#172235;
            border:1px solid #64748b;border-radius:10px;padding:8px 10px;cursor:pointer; }
        button:focus-visible { outline:3px solid #38bdf8;outline-offset:3px; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    shadow.append(panelStyle, button);
    document.body.append(host);

    // turns 只持有当前页面的消息；blocks 只持有历史消息内的候选块。
    const turns = new Map(); // Element -> { recent: boolean, blocks: Set<Element> }
    const blocks = new Map(); // Element -> { near, size, cold, originalSize, originalPriority }
    const dirty = new Set();
    const pendingWrites = new Set();
    const pendingRoots = new Set(); // 非消息区的变动仅记录引用，延后判断是否包含消息。
    const EDITOR = 'textarea,input,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
    let inputUntil = 0;
    let composing = false;
    let compositionTarget = null;
    let structureDirty = true;
    let workHandle = null;
    let frameHandle = null;
    let job = null;
    let rescanAll = false;
    let reconcileAt = 0;
    let nextSliceAt = 0;
    let sliceEffects = 0;
    let configuredCold = 0;
    let warmUntil = 0;
    let fault = false;
    let suspended = false;
    let destroyed = false;
    let menuIds = [];
    const stats = {
        documentScans: 0, messageScans: 0, slices: 0, steps: 0,
        maxSliceMs: 0, workMs: 0, effects: 0, inputYields: 0, overflowRecoveries: 0,
        frameCommits: 0, maxCommitMs: 0,
    };

    /**
     * 自有导航不依赖站点导航的挂载条件；只索引当前 DOM，不读取私有接口。
     * 使用原生 details/select，键盘可操作；收起时不创建数百个目录项。
     * 不缓存正文或跨会话 ID，避免分支切换后的陈旧目录与隐私存储。
     */
    const navHost = document.createElement('aside');
    navHost.hidden = true;
    navHost.id = 'ai-web-smooth-navigation';
    navHost.style.cssText = 'position:fixed;right:12px;top:35%;z-index:2147483645;max-width:calc(100vw - 24px)';
    const navShadow = navHost.attachShadow({ mode: 'open' });
    navShadow.innerHTML = `<style>
        :host{font:13px/1.5 system-ui,sans-serif;color-scheme:light dark}
        details{background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:12px;padding:10px;box-shadow:0 3px 14px #0002}
        summary,button{cursor:pointer} select{display:block;width:100%;margin:8px 0;max-width:250px}
        button{padding:6px;margin:2px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText}
        p{max-width:230px;margin:6px 0;font-size:12px} :focus-visible{outline:2px solid Highlight;outline-offset:2px}
        @media print{:host{display:none!important}}
        </style><details><summary>会话导航</summary><p>仅列出已加载消息；更早历史需由网页加载。</p>
        <select aria-label="已加载消息"></select><button type="button" data-action="jump">跳转</button>
        <button type="button" data-action="earlier">加载更早消息</button><button type="button" data-action="latest">回到最新</button>
        <p role="status" aria-live="polite"></p></details>`;
    const navDetails = navShadow.querySelector('details');
    const navSelect = navShadow.querySelector('select');
    const navStatus = navShadow.querySelector('[role="status"]');
    let navTargets = [];
    function refreshNavigation() {
        navHost.hidden = !settings.navigationEnabled || adapter !== chat || !active();
        if (!navDetails.open || navHost.hidden) { navTargets = []; navSelect.replaceChildren(); return; }
        const previous = navTargets[navSelect.selectedIndex];
        navTargets = Array.from(turns.keys()).filter((element) => element.isConnected)
            .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const options = document.createDocumentFragment();
        navTargets.forEach((element, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            const number = element.getAttribute('data-testid')?.match(/\d+$/)?.[0];
            option.textContent = `消息 ${number ?? index + 1}`;
            options.append(option);
        });
        navSelect.replaceChildren(options);
        navSelect.selectedIndex = previous && navTargets.includes(previous) ? navTargets.indexOf(previous) : navTargets.length - 1;
        navSelect.disabled = !navTargets.length;
        navStatus.textContent = `已加载 ${navTargets.length} 条消息`;
    }
    navDetails.addEventListener('toggle', refreshNavigation);
    navShadow.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        navDetails.open = false;
        navShadow.querySelector('summary').focus();
    });
    navShadow.addEventListener('click', (event) => {
        const action = event.target.closest('button')?.dataset.action;
        if (!action) return;
        const target = action === 'latest' ? navTargets.at(-1)
            : action === 'earlier' ? navTargets[0] : navTargets[navSelect.selectedIndex];
        if (!target?.isConnected) { refreshNavigation(); return; }
        // 点击跳转前恢复目标正文，避免后台恢复任务尚未运行时出现短暂占位。
        for (const block of turns.get(target)?.blocks || []) {
            const state = blocks.get(block);
            if (state?.cold) thaw(block, state);
        }
        target.scrollIntoView({ block: action === 'latest' ? 'end' : 'start', behavior: 'instant' });
        if (action === 'earlier') navStatus.textContent = '已到当前最早消息，等待网页加载；若无变化请继续向上滚动。';
    });
    function onInput(event) {
        // keydown 先于站点键盘处理；beforeinput/input 覆盖粘贴、听写、移动输入。
        // 不读输入值、不 preventDefault、不改焦点 / 选区 / 撤销栈。
        if (!(event.target instanceof Element) || !event.target.closest(EDITOR)) return;
        inputUntil = performance.now() + CONFIG.inputQuietMs;
        if (event.type === 'compositionstart') { composing = true; compositionTarget = event.target; }
        if (event.type === 'compositionend' || event.type === 'focusout') {
            composing = false; compositionTarget = null;
        }
        // 组合输入严格暂停；普通输入只降预算，不反复取消队列导致优化永远无法建立。
        if (composing) { cancelWork(); cancelFrame(); }
        scheduleWork();
        scheduleFrameWrites();
    }

    function active() { return supported && settings.enabled && !fault && !suspended && !destroyed; }
    function coldCount() {
        return configuredCold;
    }
    function renderStatus() {
        const display = settings.panelVisible ? 'block' : 'none';
        if (host.style.display !== display) host.style.display = display;
        // 默认隐藏时连计数遍历/文本更新也省掉；需要诊断时再统计。
        if (!settings.panelVisible) return;
        button.disabled = !supported;
        button.setAttribute('aria-pressed', String(active()));
        button.textContent = !supported ? 'AI Smooth · 浏览器不支持'
            : fault ? 'AI Smooth · 异常已暂停' : !settings.enabled ? 'AI Smooth · 已暂停'
                : !turns.size ? 'AI Smooth · 等待消息' : `AI Smooth · ${coldCount()} 块`;
        button.title = '已配置离屏优化的正文块数量，不是实际跳过渲染数量。点击暂停/恢复；油猴菜单可诊断。';
    }

    /** 优化只修改自己的属性/自定义变量，保留原来的行内样式及其优先级。 */
    function thaw(element, state) {
        // 未写入过的块无需移除属性，避免清理阶段制造无意义 CSSOM 变更。
        if (!state.cold) return;
        element.removeAttribute(COLD);
        if (state.originalSize) element.style.setProperty(SIZE, state.originalSize, state.originalPriority);
        else element.style.removeProperty(SIZE);
        // 读取序列化属性再判断，兼容浏览器对 CSSOM 自定义属性删除的延迟同步。
        if (!state.hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
        state.cold = false;
        configuredCold--;
    }
    function forget(element) {
        const state = blocks.get(element);
        if (!state) return;
        intersection?.unobserve(element);
        resize?.unobserve(element);
        pendingWrites.delete(element);
        thaw(element, state);
        blocks.delete(element);
    }
    function fail(error) {
        fault = true;
        stop();
        renderStatus();
        console.warn('[AI Web Smooth] 已撤回优化，可通过油猴菜单重试。', error);
    }

    const intersection = supported ? new IntersectionObserver((entries) => {
        if (!active()) return;
        try {
            for (const entry of entries) {
                const state = blocks.get(entry.target);
                if (!state) continue;
                state.near = entry.isIntersecting;
                // 进入预渲染范围时立即解锁，不能等后台任务，否则快速跳转会出现空白。
                if (state.near && state.cold) thaw(entry.target, state);
                else if (!state.near) pendingWrites.add(entry.target);
            }
            scheduleWork();
            scheduleFrameWrites();
        } catch (error) { fail(error); }
    }, { rootMargin: `${CONFIG.viewportMargin}px 0px`, threshold: 0 }) : null;

    const resize = supported ? new ResizeObserver((entries) => {
        if (!active()) return;
        for (const entry of entries) {
            const state = blocks.get(entry.target);
            if (!state) continue;
            const box = entry.contentBoxSize?.[0];
            const inline = box?.inlineSize ?? entry.contentRect.width;
            // 侧栏开合/窗口调整也会改变正文宽度。旧占位高度此时不可复用：
            // 后台任务先解锁，再重新订阅以取得真实尺寸，不在 RO 内写布局。
            if (state.cold) {
                if (Math.abs(inline - state.inline) > 0.5) {
                    state.remeasure = true;
                    state.size = 0;
                    pendingWrites.add(entry.target);
                }
                continue;
            }
            state.inline = inline;
            state.size = box?.blockSize ?? entry.contentRect.height;
            if (!state.near) pendingWrites.add(entry.target);
        }
        // RO 回调只读浏览器已计算的尺寸。写入延后，避免 ResizeObserver 循环。
        scheduleWork();
        scheduleFrameWrites();
    }) : null;

    // 不处理工具栏、编辑器、表格/列表布局、媒体、弹窗、带 sticky 外壳的代码工具区。
    // 单独的 pre 可以优化，它的外部复制按钮和 sticky 标题不会建立新的包含关系。
    const UNSAFE = 'button,input,textarea,select,iframe,video,audio,canvas,img,svg,dialog,[popover],'
        + '[role="button"],[role="dialog"],[role="menu"],[contenteditable]:not([contenteditable="false"])';
    const SKIP = 'script,style,template,svg,textarea,input,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
    const BLOCK_CONTEXT = 'nav,aside,header,footer,button,[role="toolbar"],[role="navigation"]';
    const isTurn = (element) => element.matches(adapter.selector) && adapter.accepts(element);

    /**
     * 每次 next() 最多访问一个元素或向上走一级；不先 querySelectorAll 再假装分批。
     * 未知变更子树剪去消息正文；复杂块安全检查逐节点进行；不递归、不缓存全部后代。
     * 遍历期间节点移走时终止游标，由 MutationObserver 安排新一轮局部检查。
     */
    function* walk(root, prune = () => false) {
        let node = root;
        while (node) {
            const descend = !prune(node);
            yield node;
            if (!root.contains(node)) return;
            if (descend && node.firstElementChild) { node = node.firstElementChild; continue; }
            while (node !== root && !node.nextElementSibling) {
                node = node.parentElement;
                if (!node || !root.contains(node)) return;
                yield null; // 深树返回父节点也占预算，避免单步长时间运行。
            }
            node = node === root ? null : node.nextElementSibling;
        }
    }

    /**
     * 常见 p → span / pre → code → spans 快路径，先验证形状，再用原生选择器检查。
     * 只有最多 128 个直接叶子元素才进入；有更深嵌套就返回 null 交给逐步游标。
     * 因而不会为一个任意大的高亮代码块调用不可中断的后代选择器。
     */
    function checkSmallBlock(block) {
        const container = block.childElementCount === 1 && block.firstElementChild.localName === 'code'
            ? block.firstElementChild : block;
        if (container.childElementCount > 128) return null;
        // 任意孙元素都会立即命中；若没有，最多检查 128 个叶子，不沿深层子树搜索。
        if (container.querySelector(':scope > * > *')) return null;
        if (['fixed', 'sticky'].includes(block.style.position) || ['fixed', 'sticky'].includes(container.style.position)) return false;
        for (const node of block.querySelectorAll('[style]')) {
            if (['fixed', 'sticky'].includes(node.style?.position)) return false;
        }
        return !block.matches(UNSAFE) && !block.querySelector(UNSAFE);
    }

    function* scanMessage(element, state) {
        stats.messageScans++;
        const revision = state.revision;
        const next = new Set();
        let visited = 0;
        state.capped = false;
        if (!state.blocks.size && blocks.size >= CONFIG.maxBlocks) { state.capped = true; return; }
        // 历史编辑使旧占位失效；分步恢复并重新测量，不沿用修改前的高度。
        // revision 防止暂停期间的再次编辑被旧检查结果覆盖。
        if (state.invalidated) for (const block of state.blocks) {
            const previous = blocks.get(block);
            if (previous) {
                thaw(block, previous);
                previous.size = 0;
                previous.remeasure = false;
                resize.unobserve(block); resize.observe(block);
                sliceEffects++;
            }
            yield;
            if (state.revision !== revision) return;
        }
        // 候选选择交给原生引擎；不在 JS 中逐个访问代码高亮和无关包装节点。
        // 原生查询本身不可中断；候选验证、复杂块检查和登记则逐项让出主线程。
        for (const block of element.querySelectorAll('p,pre')) {
            yield;
            if (!element.isConnected || turns.get(element) !== state || state.recent || state.revision !== revision) return;
            if (++visited > CONFIG.maxMessageCandidates) break;
            if (block.closest(adapter.selector) !== element || block.parentElement?.closest('p,pre')
                || block.closest(EDITOR + ',' + BLOCK_CONTEXT)) continue;
            if (!blocks.has(block) && blocks.size >= CONFIG.maxBlocks) { state.capped = true; continue; }
            let safe = checkSmallBlock(block);
            let descendants = 0;
            if (safe === null) for (const node of walk(block)) {
                yield;
                if (state.revision !== revision) return;
                if (++descendants > CONFIG.maxBlockNodes || (node &&
                    (node.matches(UNSAFE) || ['fixed', 'sticky'].includes(node.style?.position)))) {
                    safe = false; break;
                }
            }
            if (safe === false || !block.isConnected || !element.contains(block)) continue;
            if (!blocks.has(block)) {
                if (blocks.size >= CONFIG.maxBlocks) { state.capped = true; continue; }
                blocks.set(block, {
                    owner: state,
                    near: true, size: 0, inline: 0, cold: false, remeasure: false,
                    originalSize: block.style.getPropertyValue(SIZE),
                    originalPriority: block.style.getPropertyPriority(SIZE),
                    hadStyle: block.hasAttribute('style'),
                });
                // 立刻归属消息，即使生成器尚未完成，停止 / SPA 也能完整回收。
                state.blocks.add(block);
                intersection.observe(block);
                resize.observe(block);
                sliceEffects++;
            }
            next.add(block);
            yield; // 一个目标登记完成后立即交回调度器，副作用上限不会被下一轮清理跨过。
        }
        for (const block of state.blocks) {
            if (!next.has(block)) { forget(block); state.blocks.delete(block); sliceEffects++; }
            yield;
            if (state.revision !== revision) return;
        }
        state.invalidated = false;
        // 验证期间 RO 写入可能被丢弃；完成后补轻量排队，不重新同步测量。
        for (const block of state.blocks) { pendingWrites.add(block); yield; }
    }

    /** 状态协调逐项让出主线程；首次候选检索使用一次原生查询。 */
    function* reconcileStructure() {
        structureDirty = false;
        const refreshAll = rescanAll;
        rescanAll = false;
        stats.documentScans++;
        const ordered = [];
        const next = new Set();
        let overlaps = false;
        const root = document.body;
        if (!root) return;
        // 原生选择器在本地压力对照中比逐个 JS matches 更快。
        // 放在空闲任务中执行一次；枚举后的状态协调仍逐项让出主线程。
        // 此原生调用本身不可中断，因此不宣称任何规模下都有严格毫秒上限。
        const found = root.querySelectorAll(adapter.selector);
        for (const element of found) {
            if (adapter.accepts(element) && element.isConnected && !element.parentElement?.closest(adapter.selector)) {
                ordered.push(element); next.add(element);
                if (turns.has(element)) overlaps = true;
            }
            yield;
        }
        // 侧栏切换会话通常不刷新页面。新消息集合与旧集合完全不相交时重新预热，
        // 也覆盖“主页先无消息，稍后加载长会话”，不需要改写 history 或读取会话 ID。
        if (ordered.length && !overlaps) warmUntil = performance.now() + CONFIG.warmupMs;
        for (const [element, state] of turns) {
            if (!next.has(element) || !element.isConnected) {
                for (const block of state.blocks) { forget(block); sliceEffects++; yield; }
                dirty.delete(element);
                turns.delete(element);
            }
            yield;
        }
        const cutoff = Math.max(0, ordered.length - CONFIG.keepRecent);
        for (let index = 0; index < ordered.length; index++) {
            const element = ordered[index];
            if (!element.isConnected) continue;
            let state = turns.get(element);
            const recent = index >= cutoff;
            if (!state) {
                state = { recent, blocks: new Set(), capped: false, revision: 0, invalidated: false };
                turns.set(element, state);
                if (!recent) dirty.add(element);
            } else if (state.recent !== recent) {
                state.recent = recent;
                if (recent) {
                    for (const block of state.blocks) { forget(block); sliceEffects++; yield; }
                    state.blocks.clear();
                    dirty.delete(element);
                } else dirty.add(element);
            } else if (!recent && (refreshAll || (state.capped && blocks.size < CONFIG.maxBlocks))) markDirty(element, state);
            yield;
        }
        refreshNavigation();
    }

    function* inspectRoot(root) {
        for (const node of walk(root, (element) => isTurn(element) || element.matches(SKIP))) {
            if (node && isTurn(node)) { structureDirty = true; return; }
            yield;
        }
    }
    function hasWork() { return job || structureDirty || dirty.size || pendingRoots.size || pendingWrites.size; }
    function cancelWork() {
        if (!workHandle) return;
        if (workHandle.idle) cancelIdleCallback(workHandle.id);
        else clearTimeout(workHandle.id);
        workHandle = null;
    }
    function cancelFrame() {
        if (frameHandle !== null) cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }
    /**
     * 尺寸准备与样式提交分离：已验证、已测量的块在下一帧提交，不再等待第二次空闲。
     * 否则原站点持续重排时，会出现“观察器早已拿到尺寸，但优化一直没写入”的饥饿。
     * 此处只用 RO 已交付的数据，不读取几何；批次有时间和数量上限。
     */
    function scheduleFrameWrites() {
        if (!active() || composing || document.hidden || frameHandle !== null || !pendingWrites.size) return;
        frameHandle = requestAnimationFrame(() => {
            frameHandle = null;
            if (!active() || composing || document.hidden) return;
            const begin = performance.now();
            const before = sliceEffects;
            let count = 0;
            try {
                while (pendingWrites.size && count++ < 32 && performance.now() - begin < 2) writeOne();
                stats.effects += sliceEffects - before;
                stats.frameCommits++;
                stats.maxCommitMs = Math.max(stats.maxCommitMs, performance.now() - begin);
                renderStatus();
                scheduleFrameWrites();
            } catch (error) { fail(error); }
        });
    }
    function scheduleWork() {
        if (!active() || workHandle || !hasWork() || document.hidden) return;
        // SPA 卸载编辑器可能没有 compositionend / blur，避免永久停住。
        if (composing && !compositionTarget?.isConnected) { composing = false; compositionTarget = null; }
        if (composing) return; // 选词中不轮询，结束事件唤醒。
        const hasIdle = typeof requestIdleCallback === 'function';
        const due = Math.max(hasIdle ? 0 : nextSliceAt, structureDirty && !job ? reconcileAt : 0);
        const enqueue = () => {
            workHandle = null;
            if (!active() || document.hidden || composing) return;
            workHandle = hasIdle
                ? { idle: true, id: requestIdleCallback(work, { timeout: CONFIG.idleTimeout }) }
                : { idle: false, id: setTimeout(() => work(null), 0) };
        };
        // rIC 自己会让出事件循环；不用额外的帧间定时器，以免输入密集时任务两次排队。
        if (due <= performance.now()) enqueue();
        else workHandle = { idle: false, id: setTimeout(enqueue, due - performance.now()) };
    }
    function writeOne() {
        const element = pendingWrites.values().next().value;
        pendingWrites.delete(element);
        const state = blocks.get(element);
        if (!state) return;
        if (!element.isConnected) { forget(element); sliceEffects++; return; }
        if (state.owner.invalidated) return;
        if (state.remeasure) {
            thaw(element, state);
            state.remeasure = false;
            resize.unobserve(element);
            resize.observe(element);
            sliceEffects++;
        } else if (!state.near && !state.cold && Number.isFinite(state.size) && state.size >= CONFIG.minBlockSize) {
            element.style.setProperty(SIZE, `${state.size}px`);
            element.setAttribute(COLD, '');
            state.cold = true;
            configuredCold++;
            sliceEffects++;
        }
    }
    function work(deadline) {
        workHandle = null;
        if (!active() || document.hidden) return;
        if (composing) { stats.inputYields++; scheduleWork(); return; }
        const begin = performance.now();
        const typing = begin < inputUntil;
        const timedOut = deadline?.didTimeout === true;
        const warming = begin < warmUntil;
        const bootstrapping = deadline?.bootstrap === true;
        const budgetMs = bootstrapping ? CONFIG.bootstrapMs : warming ? CONFIG.warmupSliceMs : typing && !timedOut ? CONFIG.typingSliceMs : CONFIG.sliceMs;
        const stepLimit = bootstrapping ? 4800 : CONFIG.sliceSteps;
        const effectLimit = bootstrapping ? 128 : warming ? 64 : typing && !timedOut ? 24 : CONFIG.sliceEffects;
        sliceEffects = 0;
        let steps = 0;
        try {
            while (steps < stepLimit && sliceEffects < effectLimit
                && performance.now() - begin < budgetMs && (!deadline || timedOut || deadline.timeRemaining() > 1)) {
                steps++;
                // 优先消费尺寸，使已登记块尽早减负，不等全页登记完。
                if (pendingWrites.size) { writeOne(); continue; }
                if (!job) {
                    if (structureDirty) { pendingRoots.clear(); job = reconcileStructure(); }
                    else if (pendingRoots.size) {
                        const root = pendingRoots.values().next().value;
                        pendingRoots.delete(root);
                        job = inspectRoot(root);
                    } else if (dirty.size) {
                        const element = dirty.values().next().value;
                        dirty.delete(element);
                        const state = turns.get(element);
                        if (element.isConnected && state && !state.recent) job = scanMessage(element, state);
                        else continue;
                    } else break;
                }
                if (job.next().done) job = null;
            }
            renderStatus();
        } catch (error) { fail(error); }
        const elapsed = performance.now() - begin;
        stats.slices++; stats.steps += steps; stats.effects += sliceEffects;
        stats.workMs += elapsed; stats.maxSliceMs = Math.max(stats.maxSliceMs, elapsed);
        nextSliceAt = performance.now() + CONFIG.sliceInterval;
        scheduleWork();
        scheduleFrameWrites();
    }
    function scheduleReconcile() {
        if (!reconcileAt || reconcileAt < performance.now()) reconcileAt = performance.now() + CONFIG.reconcileDelay;
        scheduleWork();
    }

    function markDirty(element, state) {
        state.invalidated = true;
        state.revision++;
        dirty.add(element);
    }
    const mutation = new MutationObserver((records) => {
        if (!active()) return;
        try {
            ensureUI();
            let budget = 96;
            // 微任务中不完整遍历任意大的 records；超预算标记一次保守重建。
            // 恢复工作仍由可中断后台任务执行，不在这里扫描子树。
            outer: for (const record of records) {
                if (--budget < 0) { rescanAll = structureDirty = true; stats.overflowRecoveries++; break; }
                const target = record.target instanceof Element ? record.target : record.target.parentElement;
                if (!target) continue;
                if (record.type !== 'attributes' && target.closest(EDITOR)) continue;
                if (record.type === 'attributes') {
                    if (turns.has(target) || isTurn(target)) structureDirty = true;
                    if (record.attributeName === 'data-testid') continue;
                }
                const owner = target.closest(adapter.selector);
                const state = turns.get(owner);
                if (state) {
                    if (!state.recent) markDirty(owner, state);
                    continue;
                }
                if (owner && adapter.accepts(owner)) { structureDirty = true; continue; }
                for (const list of [record.addedNodes, record.removedNodes]) for (const node of list) {
                    if (--budget < 0 || pendingRoots.size >= 128) {
                        rescanAll = structureDirty = true;
                        pendingRoots.clear(); stats.overflowRecoveries++; break outer;
                    }
                    if (!(node instanceof Element) || node === host || node === navHost || node === style || node.matches(SKIP)) continue;
                    if (!structureDirty) pendingRoots.add(node);
                }
            }
            if (hasWork()) scheduleReconcile();
        } catch (error) { fail(error); }
    });

    function ensureUI() {
        if (!host.isConnected && document.body) document.body.append(host);
        if (settings.navigationEnabled && adapter === chat && !navHost.isConnected && document.body) document.body.append(navHost);
        if (!style.isConnected) (document.head || document.documentElement).append(style);
    }

    function start() {
        if (!active()) { renderStatus(); return; }
        try {
            ensureUI();
            mutation.observe(document.documentElement, {
                subtree: true, childList: true, characterData: true, attributes: true,
                // 不观察 class/style，动画和脚本自己的 CSSOM 写入不形成反馈循环。
                attributeFilter: adapter === chat ? ['data-testid', 'contenteditable', 'role'] : ['contenteditable', 'role'],
            });
            // 在 document-idle 的注入机会中做一个有界预热批次，其余通过空闲任务继续。
            // 压力对照显示纯延后会错过第一键之前建立离屏优化的机会。
            structureDirty = true;
            warmUntil = performance.now() + CONFIG.warmupMs;
            nextSliceAt = performance.now();
            work({ bootstrap: true, timeRemaining: () => CONFIG.bootstrapMs });
            refreshNavigation();
            renderStatus();
        } catch (error) { fail(error); }
    }
    function stop() {
        mutation.disconnect();
        intersection?.disconnect();
        resize?.disconnect();
        cancelWork();
        cancelFrame();
        job = null;
        for (const [element, state] of blocks) thaw(element, state);
        blocks.clear(); turns.clear(); dirty.clear(); pendingWrites.clear();
        pendingRoots.clear(); navTargets = []; navSelect.replaceChildren(); navHost.hidden = true;
        configuredCold = 0;
        composing = false; compositionTarget = null;
    }
    function toggle() {
        if (destroyed || !supported) return;
        if (fault) { fault = false; settings.enabled = true; }
        else settings.enabled = !settings.enabled;
        saveSettings(); stop(); start();
    }
    function togglePanel() { settings.panelVisible = !settings.panelVisible; saveSettings(); renderStatus(); }
    function toggleNavigation() {
        settings.navigationEnabled = !settings.navigationEnabled;
        saveSettings();
        if (!settings.navigationEnabled) { navDetails.open = false; navHost.remove(); }
        else ensureUI();
        refreshNavigation();
    }
    function onVisibility() {
        cancelWork();
        cancelFrame();
        if (document.hidden) { composing = false; compositionTarget = null; }
        else { scheduleWork(); scheduleFrameWrites(); }
    }

    /**
     * 仅在用户点菜单时诊断。只统计属性，不读取正文/会话 ID，不上传任何数据。
     * 名称匹配只是线索：无法识别图标无标签按钮或第三方导航，不以零结果判定按钮不存在。
     */
    function diagnose() {
        const navigation = Array.from(document.querySelectorAll('button,[role="button"]')).filter((element) =>
            /scroll.*bottom|jump.*(bottom|latest|message)|conversation.*(nav|jump)|回到.*(底部|最新)|滚动.*底部|跳转|会话导航/i
                .test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`));
        const lines = [
            `AI Web Smooth 1.3.0 · ${adapter.name} · 脚本已成功注入`,
            `优化：${active() ? '开启' : '暂停/不支持'}；消息：${turns.size}；候选正文块：${blocks.size}；配置离屏：${coldCount()}`,
            `本次页面生命周期累计：外壳查询 ${stats.documentScans} 次；消息内部查询 ${stats.messageScans} 次。`,
            `按 aria-label/title 匹配到跳转/导航按钮：${navigation.length} 个（仅为线索，不含未标注按钮）。`,
            'v1.3：逐节点空闲调度；组合输入中暂停新增优化；自有导航默认关闭。',
            `后台状态：${hasWork() ? '仍有待处理工作' : '当前队列已完成'}；最大单批脚本耗时 ${stats.maxSliceMs.toFixed(2)}ms（不含浏览器后续布局 / GC）。`,
            `调度统计（不含内容）：${JSON.stringify({ ...stats, pending: Boolean(hasWork()), observed: blocks.size, cold: configuredCold })}`,
            adapter === chat ? '需要自有导航时可在油猴菜单手动开启；原生导航不受该开关影响。'
                : '消息为 0 时请进入含回复的对话页；菜单存在说明脚本已注入，不属于扩展禁止注入。',
        ];
        window.alert(lines.join('\n\n'));
    }
    function registerMenus() {
        try {
            if (typeof GM_registerMenuCommand !== 'function') throw new Error('menu unavailable');
            menuIds.push(GM_registerMenuCommand('AI Smooth：暂停 / 恢复优化', toggle));
            menuIds.push(GM_registerMenuCommand('AI Smooth：显示 / 隐藏状态按钮', togglePanel));
            if (adapter === chat) menuIds.push(GM_registerMenuCommand('AI Smooth：开启 / 关闭自有导航（默认关闭）', toggleNavigation));
            menuIds.push(GM_registerMenuCommand('AI Smooth：诊断（不含对话内容）', diagnose));
        } catch {
            // 无菜单的管理器才展示备用按钮，保证用户仍可暂停。
            settings.panelVisible = true;
        }
    }
    function onPageHide(event) {
        suspended = true;
        stop();
        if (event.persisted) return;
        destroyed = true;
        button.removeEventListener('click', toggle);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        for (const name of INPUT_EVENTS) document.removeEventListener(name, onInput, true);
        document.removeEventListener('visibilitychange', onVisibility);
        if (typeof GM_unregisterMenuCommand === 'function') {
            for (const id of menuIds) {
                try { GM_unregisterMenuCommand(id); } catch { /* 页面正在卸载。 */ }
            }
        }
        menuIds = [];
        host.remove(); style.remove(); navHost.remove();
    }
    function onPageShow(event) {
        if (!event.persisted || destroyed) return;
        suspended = false;
        start();
    }
    button.addEventListener('click', toggle);
    const INPUT_EVENTS = ['keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend', 'focusin', 'focusout'];
    for (const name of INPUT_EVENTS) document.addEventListener(name, onInput, { capture: true, passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    registerMenus();
    saveSettings();
    start();
})();
