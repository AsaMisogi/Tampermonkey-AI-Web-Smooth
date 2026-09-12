/*
 * 完全离线的浏览器回归：模拟站点结构，不接触账号或会话。
 * NODE_PATH 指向 Playwright；CHROME_PATH 可覆盖本机 Chrome 可执行文件路径。
 * 测试几何、导航及浏览器实际渲染状态，而不只测试脚本属性。
 */
'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../AI-Web-Smooth.user.js'), 'utf8');
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];

function fixture(studio, count = 600) {
    const contents = Array.from({ length: 70 }, (_, n) => `<span>const 中文变量${n} = ${n};</span>`).join('\n');
    const messages = Array.from({ length: count }, (_, i) => {
        const body = `${i === 10 ? '<aside id="embedded-nav" style="position:fixed;right:12px;top:130px"><button>内部浮动导航</button></aside>' : ''}<div class="markdown"><p><span>${'测试中文正文内容。'.repeat(100)}</span></p>
            <div class="code-wrapper"><header><button class="copy">复制</button></header><pre><code>${contents}</code></pre></div></div>
            <div role="toolbar"><button class="edit">编辑</button><input value="原文"></div>`;
        return studio ? `<ms-chat-turn id="message-${i}">${body}</ms-chat-turn>`
            : `<section id="message-${i}" data-testid="conversation-turn-${i}">${body}</section>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;font:14px/20px sans-serif}main{width:900px;height:650px;overflow:auto;overflow-anchor:none}
        section,ms-chat-turn{display:block;padding:12px;border-bottom:1px solid #ccc}
        p{margin:10px 0}pre{margin:10px 0;white-space:pre-wrap}header{position:sticky;top:0;background:white}
        #side-nav{position:fixed;right:12px;top:84px;z-index:30}textarea{height:60px}
        </style></head><body><main>${messages}</main>
        <aside id="side-nav" aria-label="会话导航"><button id="jump" aria-label="跳转到第 301 条消息">跳转</button></aside>
        <textarea id="composer"></textarea><script>
        document.querySelector('#jump').onclick=()=>document.querySelector('#message-300').scrollIntoView();
        document.querySelectorAll('.copy').forEach(b=>b.onclick=()=>{b.dataset.clicked='yes'});
        </script></body></html>`;
}

async function install(page, settings = {}) {
    await page.evaluate((saved) => {
        window.savedSettings = saved;
        window.menuEntries = new Map();
        let id = 0;
        window.GM_getValue = () => window.savedSettings;
        window.GM_setValue = (_key, value) => { window.savedSettings = value; };
        window.GM_registerMenuCommand = (label, action) => { window.menuEntries.set(++id, { label, action }); return id; };
        window.GM_unregisterMenuCommand = (key) => window.menuEntries.delete(key);
        window.fullScans = 0;
        const original = document.querySelectorAll.bind(document);
        document.querySelectorAll = (selector) => {
            if (selector === 'ms-chat-turn' || selector.includes('data-testid^=')) window.fullScans++;
            return original(selector);
        };
    }, settings);
    await page.addScriptTag({ content: source + '\nif (window.probe) window.probe.bootstrapObservations = window.probe.observations;' });
}
async function menu(page, label) {
    await page.evaluate((text) => [...window.menuEntries.values()].find((item) => item.label.includes(text)).action(), label);
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelectorAll('[data-ai-web-smooth-cold]').length > 100, null, { timeout: 20000 });
    await settled(page);
}
async function diagnostics(page) {
    return page.evaluate(() => {
        const original = window.alert;
        let message = '';
        window.alert = (value) => { message = value; };
        try { [...window.menuEntries.values()].find((item) => item.label.includes('诊断')).action(); }
        finally { window.alert = original; }
        return JSON.parse(message.match(/调度统计（不含内容）：(\{[^\n]+\})/)[1]);
    });
}
async function settled(page) {
    // 等待实际队列完成；不能用更长的固定 sleep 掩盖初始化是否成功。
    const end = Date.now() + 45000;
    let stable = 0;
    while (Date.now() < end) {
        await page.waitForTimeout(150);
        stable = (await diagnostics(page)).pending ? 0 : stable + 1;
        if (stable >= 2) return;
    }
    throw new Error('后台优化队列未在 45 秒内完成');
}

if (require.main === module) (async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const studio of [false, true]) {
            const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(studio) }));
            await page.goto(studio ? 'https://aistudio.google.com/prompts/test' : 'https://chatgpt.com/c/test');
            const before = await page.evaluate(() => ({
                height: document.querySelector('main').scrollHeight,
                nav: document.querySelector('#side-nav').getBoundingClientRect().toJSON(),
                embedded: document.querySelector('#embedded-nav').getBoundingClientRect().toJSON(),
            }));
            // 模拟 v1.0 已保存默认可见：升级后也应隐藏。
            await install(page, { enabled: true, panelVisible: true });
            await ready(page);
            assert.equal(await page.locator('#ai-web-smooth-control-v1').isVisible(), false);
            assert.equal(await page.evaluate(() => window.menuEntries.size), studio ? 3 : 4);
            assert.equal(await page.locator('#ai-web-smooth-navigation').count(), 0, '默认不挂载自有导航');
            const geometry = await page.evaluate(() => ({
                height: document.querySelector('main').scrollHeight,
                nav: document.querySelector('#side-nav').getBoundingClientRect().toJSON(),
                embedded: document.querySelector('#embedded-nav').getBoundingClientRect().toJSON(),
                shell: getComputedStyle(document.querySelector('#message-300')).contentVisibility,
                code: getComputedStyle(document.querySelector('#message-300 pre')).contentVisibility,
                skipped: !document.querySelector('#message-300 code').checkVisibility({ contentVisibilityAuto: true }),
            }));
            assert.equal(geometry.shell, 'visible', '消息外壳不建立渲染包含');
            assert.equal(geometry.code, 'auto');
            assert.equal(geometry.skipped, true);
            assert.ok(Math.abs(geometry.height - before.height) <= 2, `占位保留实际高度：${before.height} -> ${geometry.height}`);
            assert.deepEqual(geometry.nav, before.nav, '侧边导航几何不变');
            assert.deepEqual(geometry.embedded, before.embedded, '消息内 fixed 导航不受外壳包含影响');
            await page.locator('#embedded-nav button').click();
            assert.equal(await page.locator('#message-598 [data-ai-web-smooth-cold], #message-599 [data-ai-web-smooth-cold]').count(), 0);

            const scans = await page.evaluate(() => window.fullScans);
            await page.evaluate(async () => {
                for (let i = 0; i < 40; i++) {
                    document.querySelector('#message-599 pre').append(document.createElement('span'));
                    document.querySelector('#message-599 pre').append('流式');
                    await new Promise(requestAnimationFrame);
                }
            });
            assert.equal(await page.evaluate(() => window.fullScans), scans, '流式输出不整页查询');
            await page.locator('#composer').fill('中文输入\n多行粘贴内容');
            assert.equal(await page.locator('#composer').inputValue(), '中文输入\n多行粘贴内容');

            // 真实点击侧栏导航，验证定位到目标，目标块及时解除包含且工具栏仍可点击。
            await page.locator('#jump').click();
            await page.waitForFunction(() => !document.querySelector('#message-300 p').hasAttribute('data-ai-web-smooth-cold'));
            assert.ok(await page.locator('#message-300').evaluate((e) => Math.abs(e.getBoundingClientRect().top) < 2));
            await page.locator('#message-300 .copy').click();
            assert.equal(await page.locator('#message-300 .copy').getAttribute('data-clicked'), 'yes');

            // 改变聊天区宽度，模拟侧栏开合。与暂停后的自然布局比较，不能继续使用旧高度。
            await page.evaluate(() => document.querySelector('main').style.width = '700px');
            await settled(page);
            const resizedHeight = await page.locator('main').evaluate((e) => e.scrollHeight);
            await menu(page, '暂停 / 恢复');
            const naturalHeight = await page.locator('main').evaluate((e) => e.scrollHeight);
            assert.ok(Math.abs(resizedHeight - naturalHeight) <= 2, `宽度改变重新测量：${resizedHeight} / ${naturalHeight}`);
            assert.equal(await page.locator('[data-ai-web-smooth-cold]').count(), 0);
            assert.equal(await page.locator('[style*="--ai-web-smooth-block-size"]').count(), 0);
            assert.equal(await page.locator('#message-10 pre').getAttribute('style'), null, '撤回后不残留空 style 属性');
            await menu(page, '暂停 / 恢复');
            await ready(page);

            await page.emulateMedia({ media: 'print' });
            assert.equal(await page.locator('#message-10 pre').evaluate((e) => getComputedStyle(e).contentVisibility), 'visible');
            await page.emulateMedia({ media: 'screen' });

            // 历史正文被框架重新挂载：只扫描该消息，不能遗漏新的大段内容。
            const oldScans = await page.evaluate(() => window.fullScans);
            await page.locator('#message-50 pre').evaluate((e) => { const clone = e.cloneNode(true); clone.removeAttribute('data-ai-web-smooth-cold'); clone.removeAttribute('style'); e.replaceWith(clone); });
            await page.waitForFunction(() => document.querySelector('#message-50 pre').hasAttribute('data-ai-web-smooth-cold'));
            assert.equal(await page.evaluate(() => window.fullScans), oldScans);

            // SPA 整体替换：旧块不保留属性和引用；最新容器保护随 DOM 顺序更新。
            await page.evaluate((isStudio) => {
                window.detached = document.querySelector('main');
                const main = document.createElement('main');
                for (let i = 0; i < 10; i++) {
                    const shell = document.createElement(isStudio ? 'ms-chat-turn' : 'section');
                    if (!isStudio) shell.dataset.testid = `conversation-turn-${i}`;
                    shell.id = `new-${i}`;
                    const pre = document.createElement('pre');
                    pre.textContent = '新会话\n'.repeat(50);
                    shell.append(pre); main.append(shell);
                }
                window.detached.replaceWith(main);
            }, studio);
            await page.waitForFunction(() => document.querySelector('#new-7 pre').hasAttribute('data-ai-web-smooth-cold'));
            assert.equal(await page.evaluate(() => window.detached.querySelectorAll('[data-ai-web-smooth-cold]').length), 0);
            assert.equal(await page.locator('#new-8 pre').getAttribute('data-ai-web-smooth-cold'), null);
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
            assert.equal(await page.locator('[data-ai-web-smooth-cold]').count(), 0);
            await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
            await page.waitForFunction(() => document.querySelector('#new-7 pre').hasAttribute('data-ai-web-smooth-cold'));
            await menu(page, '显示 / 隐藏');
            assert.equal(await page.locator('#ai-web-smooth-control-v1').isVisible(), true);
            assert.equal(await page.evaluate(() => window.savedSettings.uiVersion), 2);
            await page.addScriptTag({ content: source });
            assert.equal(await page.evaluate(() => window.menuEntries.size), studio ? 3 : 4);
            assert.deepEqual(errors, []);
            results.push({ platform: studio ? 'AI Studio' : 'ChatGPT', messages: 600, navigation: 'PASS', geometry: 'PASS', streaming: 'PASS', lifecycle: 'PASS' });
            await context.close();
        }

        for (const scenario of ['unsupported', 'saved-pause', 'unknown-dom', 'interactive-block', 'native-style']) {
            const context = await browser.newContext();
            const page = await context.newPage();
            await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false, 12) }));
            await page.goto('https://chatgpt.com/c/fallback');
            await page.evaluate((mode) => {
                if (mode === 'unsupported') CSS.supports = () => false;
                if (mode === 'unknown-dom') document.querySelectorAll('section').forEach((e) => e.removeAttribute('data-testid'));
                if (mode === 'interactive-block') document.querySelectorAll('pre').forEach((e) => e.append(document.createElement('button')));
                if (mode === 'native-style') {
                    const style = document.createElement('style');
                    style.textContent = 'pre {content-visibility:hidden;contain-intrinsic-block-size:250px}';
                    document.head.append(style);
                }
            }, scenario);
            await install(page, { enabled: scenario !== 'saved-pause' });
            await page.waitForTimeout(1000);
            if (['unsupported', 'saved-pause', 'unknown-dom'].includes(scenario)) assert.equal(await page.locator('[data-ai-web-smooth-cold]').count(), 0);
            if (scenario === 'interactive-block') assert.equal(await page.locator('pre[data-ai-web-smooth-cold]').count(), 0);
            if (scenario === 'native-style') assert.equal(await page.locator('pre').first().evaluate((e) => getComputedStyle(e).contentVisibility), 'hidden');
            assert.equal(await page.locator('#ai-web-smooth-control-v1').isVisible(), false);
            results.push({ scenario, status: 'PASS' });
            await context.close();
        }
        console.log(JSON.stringify(results, null, 2));
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { fixture, install, menu, ready, diagnostics, settled };
