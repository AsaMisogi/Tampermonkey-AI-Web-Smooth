/* v1.2 专项回归：原生导航缺席、延迟加载、最后一个字符删除、编辑器子树替换。
 * 全部请求使用本地夹具；不借用账号，不把模拟结果宣称为真实站点性能数据。
 */
'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { fixture, install, menu } = require('./browser.test.cjs');

(async () => {
    const browser = await chromium.launch({
        executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false, 40) }));
        await page.goto('https://chatgpt.com/c/regressions');
        await page.evaluate(() => {
            document.querySelector('#side-nav').remove();
            document.querySelector('#message-39').scrollIntoView();
        });
        await install(page);
        const nav = page.locator('#ai-web-smooth-navigation');
        assert.equal(await nav.count(), 0, '升级后默认不挂载自有导航');
        await menu(page, '开启 / 关闭自有导航');
        assert.equal(await page.evaluate(() => window.savedSettings.navigationEnabled), true);
        assert.equal(await nav.isVisible(), true, '主动开启后，自有入口仍可用');
        await nav.locator('summary').click();
        await page.waitForFunction(() => document.querySelector('#ai-web-smooth-navigation').shadowRoot.querySelectorAll('option').length === 40);
        await nav.locator('select').selectOption('12');
        await nav.getByRole('button', { name: '跳转', exact: true }).click();
        assert.ok(await page.locator('#message-12').evaluate((e) => Math.abs(e.getBoundingClientRect().top) < 2));
        await nav.getByRole('button', { name: '回到最新' }).click();
        assert.ok(await page.locator('#message-39').evaluate((e) => e.getBoundingClientRect().bottom <= 651));

        // 站点在到达顶部时异步前插消息，目录必须按 DOM 顺序更新，而非 Map 插入顺序。
        await page.evaluate(() => {
            const main = document.querySelector('main');
            main.addEventListener('scroll', function load() {
                if (main.scrollTop > 2) return;
                main.removeEventListener('scroll', load);
                setTimeout(() => {
                    const turn = document.createElement('section');
                    turn.dataset.testid = 'conversation-turn-999';
                    turn.id = 'earlier';
                    turn.innerHTML = '<p>延迟加载的更早消息</p>';
                    main.prepend(turn);
                }, 50);
            });
        });
        await nav.getByRole('button', { name: '加载更早消息' }).click();
        await page.waitForFunction(() => document.querySelector('#ai-web-smooth-navigation').shadowRoot.querySelectorAll('option').length === 41);
        assert.equal(await nav.locator('option').first().textContent(), '消息 999');

        await page.evaluate(() => {
            const editor = document.createElement('div');
            editor.id = 'rich-editor';
            editor.contentEditable = 'true';
            editor.style.cssText = 'position:fixed;left:20px;bottom:10px;width:300px;min-height:30px;background:white';
            document.body.append(editor);
            window.editorQueries = 0;
            const marked = new WeakSet();
            const query = Element.prototype.querySelector;
            Element.prototype.querySelector = function (selector) {
                if (marked.has(this)) window.editorQueries++;
                return query.call(this, selector);
            };
            // 模拟编辑框清空时旧段落移除、新占位段落添加。
            editor.addEventListener('input', () => {
                if (!editor.textContent) {
                    const p = document.createElement('p');
                    marked.add(p);
                    p.append(document.createElement('br'));
                    editor.replaceChildren(p);
                }
            });
        });
        await page.waitForTimeout(500);
        const scans = await page.evaluate(() => window.fullScans);
        for (let i = 0; i < 20; i++) {
            await page.locator('#rich-editor').fill('字');
            await page.locator('#rich-editor').press('Backspace');
        }
        await page.waitForTimeout(600);
        assert.equal(await page.locator('#rich-editor').textContent(), '');
        assert.equal(await page.evaluate(() => window.editorQueries), 0, '清空编辑器时不查询占位子树');
        assert.equal(await page.evaluate(() => window.fullScans), scans, '反复删掉最后一字不触发整页消息扫描');

        await page.evaluate(() => {
            document.querySelector('main').innerHTML = '<section data-testid="conversation-turn-0"><p>新会话</p></section>';
        });
        await page.waitForFunction(() => document.querySelector('#ai-web-smooth-navigation').shadowRoot.querySelectorAll('option').length === 1);
        await menu(page, '暂停 / 恢复');
        assert.equal(await nav.isVisible(), false);
        await menu(page, '暂停 / 恢复');
        assert.equal(await nav.isVisible(), true);
        await page.setViewportSize({ width: 360, height: 740 });
        const rect = await nav.boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= 360, '窄屏目录不超出视口');
        await page.emulateMedia({ media: 'print' });
        assert.equal(await nav.isVisible(), false);
        await page.emulateMedia({ media: 'screen' });
        await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
        assert.equal(await nav.count(), 0, '卸载移除导航');
        assert.deepEqual(errors, []);
        console.log('PASS: 常驻导航、跳转、历史前插、20 次末字删除、SPA、暂停恢复、窄屏、打印、卸载');
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
