// ==UserScript==
// @name         AI Web Smooth · 长会话渲染优化
// @namespace    local.ai-web-smooth
// @version      1.2.0
// @description  ChatGPT / Google AI Studio 正文分块渲染优化；ChatGPT 常驻会话导航，输入期间延后后台扫描。
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
     * v1.2：正文叶子块优化 + 常驻导航 + 编辑器变更隔离。
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
        batchSize: 40,          // 每次后台任务最多处理 40 个消息，初始化分批让出主线程。
        minBlockSize: 48,       // 很小的块收益有限，不写入优化属性。
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
                uiVersion: 2,
            };
        } catch { return { enabled: true, panelVisible: false, uiVersion: 2 }; }
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
    let structureDirty = true;
    let timer = null;
    let workHandle = null;
    let fault = false;
    let suspended = false;
    let destroyed = false;
    let menuIds = [];
    const stats = { documentScans: 0, messageScans: 0 };

    /**
     * 自有导航不依赖站点导航的挂载条件；只索引当前 DOM，不读取私有接口。
     * 使用原生 details/select，键盘可操作；收起时不创建数百个目录项。
     * 不缓存正文或跨会话 ID，避免分支切换后的陈旧目录与隐私存储。
     */
    const navHost = document.createElement('aside');
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
        navHost.hidden = adapter !== chat || !active();
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
        // 不读输入值、不改事件或选区；清空与输入法输入同样获得短暂主线程优先期。
        if (event.target instanceof Element && event.target.closest(EDITOR)) inputUntil = performance.now() + 180;
    }

    function active() { return supported && settings.enabled && !fault && !suspended && !destroyed; }
    function coldCount() {
        let count = 0;
        for (const state of blocks.values()) if (state.cold) count++;
        return count;
    }
    function renderStatus() {
        host.style.display = settings.panelVisible ? 'block' : 'none';
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
        element.removeAttribute(COLD);
        if (state.originalSize) element.style.setProperty(SIZE, state.originalSize, state.originalPriority);
        else element.style.removeProperty(SIZE);
        // 读取序列化属性再判断，兼容浏览器对 CSSOM 自定义属性删除的延迟同步。
        if (!state.hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
        state.cold = false;
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
    }) : null;

    // 不处理工具栏、编辑器、表格/列表布局、媒体、弹窗、带 sticky 外壳的代码工具区。
    // 单独的 pre 可以优化，它的外部复制按钮和 sticky 标题不会建立新的包含关系。
    const UNSAFE = 'button,input,textarea,select,iframe,video,audio,canvas,img,svg,dialog,[popover],'
        + '[role="button"],[role="dialog"],[role="menu"],[contenteditable]:not([contenteditable="false"])';
    function scanMessage(element, state) {
        stats.messageScans++;
        const next = new Set();
        for (const block of element.querySelectorAll('p, pre')) {
            if (block.closest(adapter.selector) !== element
                || block.parentElement?.closest('p, pre')
                || block.closest('nav,aside,header,footer,button,[role="toolbar"],[role="navigation"],'
                    + '[contenteditable]:not([contenteditable="false"])')
                || block.matches(UNSAFE) || block.querySelector(UNSAFE)) continue;
            next.add(block);
            if (!blocks.has(block)) {
                blocks.set(block, {
                    near: true, size: 0, inline: 0, cold: false, remeasure: false,
                    originalSize: block.style.getPropertyValue(SIZE),
                    originalPriority: block.style.getPropertyPriority(SIZE),
                    hadStyle: block.hasAttribute('style'),
                });
                intersection.observe(block);
                resize.observe(block);
            }
        }
        for (const block of state.blocks) if (!next.has(block)) forget(block);
        state.blocks = next;
    }

    /** 只有消息列表的结构变动才枚举外壳；普通输出只访问所属的旧消息。 */
    function reconcileStructure() {
        structureDirty = false;
        stats.documentScans++;
        const ordered = Array.from(document.querySelectorAll(adapter.selector))
            .filter((element) => adapter.accepts(element) && !element.parentElement?.closest(adapter.selector));
        const next = new Set(ordered);
        for (const [element, state] of turns) {
            if (next.has(element)) continue;
            for (const block of state.blocks) forget(block);
            dirty.delete(element);
            turns.delete(element);
        }
        const cutoff = Math.max(0, ordered.length - CONFIG.keepRecent);
        ordered.forEach((element, index) => {
            let state = turns.get(element);
            const recent = index >= cutoff;
            if (!state) {
                state = { recent, blocks: new Set() };
                turns.set(element, state);
                if (!recent) dirty.add(element);
            } else if (state.recent !== recent) {
                state.recent = recent;
                if (recent) {
                    for (const block of state.blocks) forget(block);
                    state.blocks.clear();
                    dirty.delete(element);
                } else dirty.add(element);
            }
        });
        refreshNavigation();
    }

    function scheduleWork() {
        if (!active() || workHandle !== null || (!dirty.size && !pendingWrites.size)) return;
        // requestIdleCallback 带超时避免长期饿死；回调自身仍严格限制批量和时间片。
        workHandle = performance.now() < inputUntil
            ? { idle: false, id: setTimeout(work, Math.ceil(inputUntil - performance.now())) }
            : typeof requestIdleCallback === 'function'
            ? { idle: true, id: requestIdleCallback(work, { timeout: 700 }) }
            : { idle: false, id: setTimeout(work, 32) };
    }
    function work() {
        workHandle = null;
        if (!active()) return;
        if (performance.now() < inputUntil) { scheduleWork(); return; }
        try {
            const until = performance.now() + 6;
            let count = 0;
            for (const element of dirty) {
                dirty.delete(element);
                const state = turns.get(element);
                if (element.isConnected && state && !state.recent) scanMessage(element, state);
                if (++count >= CONFIG.batchSize || performance.now() >= until) break;
            }
            count = 0;
            for (const element of pendingWrites) {
                pendingWrites.delete(element);
                const state = blocks.get(element);
                if (state?.remeasure && element.isConnected) {
                    thaw(element, state);
                    state.remeasure = false;
                    resize.unobserve(element);
                    resize.observe(element);
                } else if (state && element.isConnected && !state.near && !state.cold
                    && Number.isFinite(state.size) && state.size >= CONFIG.minBlockSize) {
                    element.style.setProperty(SIZE, `${state.size}px`);
                    element.setAttribute(COLD, '');
                    state.cold = true;
                }
                if (++count >= CONFIG.batchSize * 4 || performance.now() >= until) break;
            }
            renderStatus();
            scheduleWork();
        } catch (error) { fail(error); }
    }
    function scheduleReconcile() {
        if (!active() || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            try {
                if (performance.now() < inputUntil) { scheduleReconcile(); return; }
                for (const node of pendingRoots) {
                    if (!structureDirty && containsTurn(node)) structureDirty = true;
                }
                pendingRoots.clear();
                if (structureDirty) reconcileStructure();
                scheduleWork();
                renderStatus();
            } catch (error) { fail(error); }
        }, CONFIG.reconcileDelay);
    }
    function containsTurn(node) {
        return node instanceof Element && (node.matches(adapter.selector) || node.querySelector(adapter.selector));
    }
    const mutation = new MutationObserver((records) => {
        if (!active()) return;
        try {
            // 少数页面会替换整个 body/head；只恢复脚本 UI，不触碰宿主内容。
            ensureUI();
            for (const record of records) {
                // 清空 contenteditable 往往替换段落/占位节点，必须在任何子树查询前排除。
                // 属性变更仍参与识别，以兼容消息由编辑态切回展示态。
                if (record.type === 'childList' && record.target instanceof Element
                    && record.target.closest(EDITOR)) continue;
                if (record.type === 'attributes') {
                    if (turns.has(record.target) || record.target.matches(adapter.selector)) structureDirty = true;
                    continue;
                }
                const owner = record.target instanceof Element ? record.target.closest(adapter.selector) : null;
                const state = turns.get(owner);
                if (state) {
                    // 最新消息完全不扫描；旧消息的框架重新挂载/代码块替换只标记所属消息。
                    if (!state.recent) dirty.add(owner);
                    continue;
                }
                for (const node of [...record.addedNodes, ...record.removedNodes]) {
                    if (!(node instanceof Element) || node === host || node === navHost || node === style
                        || node.matches(EDITOR)) continue;
                    // 设置硬上限，避免突发重挂载长期保留大量脱离文档的子树。
                    if (pendingRoots.size >= 128) { structureDirty = true; pendingRoots.clear(); break; }
                    if (!structureDirty) pendingRoots.add(node);
                }
            }
            if (structureDirty || dirty.size || pendingRoots.size) scheduleReconcile();
        } catch (error) { fail(error); }
    });

    function ensureUI() {
        if (!host.isConnected && document.body) document.body.append(host);
        if (adapter === chat && !navHost.isConnected && document.body) document.body.append(navHost);
        if (!style.isConnected) (document.head || document.documentElement).append(style);
    }

    function start() {
        if (!active()) { renderStatus(); return; }
        try {
            ensureUI();
            mutation.observe(document.documentElement, {
                subtree: true, childList: true,
                ...(adapter === chat ? { attributes: true, attributeFilter: ['data-testid'] } : {}),
            });
            // 从暂停恢复及 bfcache 返回都重新识别；不依赖 URL 路由补丁。
            reconcileStructure();
            scheduleWork();
            renderStatus();
        } catch (error) { fail(error); }
    }
    function stop() {
        mutation.disconnect();
        intersection?.disconnect();
        resize?.disconnect();
        if (timer !== null) clearTimeout(timer);
        if (workHandle) {
            if (workHandle.idle) cancelIdleCallback(workHandle.id);
            else clearTimeout(workHandle.id);
        }
        timer = workHandle = null;
        for (const [element, state] of blocks) thaw(element, state);
        blocks.clear(); turns.clear(); dirty.clear(); pendingWrites.clear();
        pendingRoots.clear(); navTargets = []; navSelect.replaceChildren(); navHost.hidden = true;
    }
    function toggle() {
        if (destroyed || !supported) return;
        if (fault) { fault = false; settings.enabled = true; }
        else settings.enabled = !settings.enabled;
        saveSettings(); stop(); start();
    }
    function togglePanel() { settings.panelVisible = !settings.panelVisible; saveSettings(); renderStatus(); }

    /**
     * 仅在用户点菜单时诊断。只统计属性，不读取正文/会话 ID，不上传任何数据。
     * 名称匹配只是线索：无法识别图标无标签按钮或第三方导航，不以零结果判定按钮不存在。
     */
    function diagnose() {
        const navigation = Array.from(document.querySelectorAll('button,[role="button"]')).filter((element) =>
            /scroll.*bottom|jump.*(bottom|latest|message)|conversation.*(nav|jump)|回到.*(底部|最新)|滚动.*底部|跳转|会话导航/i
                .test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`));
        const lines = [
            `AI Web Smooth 1.2.0 · ${adapter.name} · 脚本已成功注入`,
            `优化：${active() ? '开启' : '暂停/不支持'}；消息：${turns.size}；候选正文块：${blocks.size}；配置离屏：${coldCount()}`,
            `本次页面生命周期累计：外壳查询 ${stats.documentScans} 次；消息内部查询 ${stats.messageScans} 次。`,
            `按 aria-label/title 匹配到跳转/导航按钮：${navigation.length} 个（仅为线索，不含未标注按钮）。`,
            'v1.2：编辑器内部变更不扫描；输入后 180ms 内延后后台协调与优化写入。',
            adapter === chat ? '自有导航只列出已加载消息；展开后可跳转或到顶部触发更早历史加载。'
                : '消息为 0 时请进入含回复的对话页；菜单存在说明脚本已注入，不属于扩展禁止注入。',
        ];
        window.alert(lines.join('\n\n'));
    }
    function registerMenus() {
        try {
            if (typeof GM_registerMenuCommand !== 'function') throw new Error('menu unavailable');
            menuIds.push(GM_registerMenuCommand('AI Smooth：暂停 / 恢复优化', toggle));
            menuIds.push(GM_registerMenuCommand('AI Smooth：显示 / 隐藏状态按钮', togglePanel));
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
        document.removeEventListener('beforeinput', onInput, true);
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
    document.addEventListener('beforeinput', onInput, { capture: true, passive: true });
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    registerMenus();
    saveSettings();
    start();
})();
