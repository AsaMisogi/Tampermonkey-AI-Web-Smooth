/* 启动阶段的行为验证：用真实 Chromium、真实键盘事件和观察器验证，
 * 只对空闲额度/隐藏状态做可控故障注入，避免依赖机器速度做脆弱的毫秒断言。
 */
'use strict';
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { fixture, install, diagnostics, settled, menu } = require('./browser.test.cjs');

async function instrumentation(page) {
    await page.evaluate(() => {
        window.probe = { observations: 0, writes: 0, callbacks: [], frames: [], zeroIdle: false, forcedTimeout: false };
        const idle = window.requestIdleCallback.bind(window);
        window.requestIdleCallback = (callback, options) => idle((deadline) => {
            const before = { observations: probe.observations, writes: probe.writes };
            const timedOut = probe.forcedTimeout || (!probe.zeroIdle && deadline.didTimeout);
            callback(probe.zeroIdle || probe.forcedTimeout ? { timeRemaining: () => 0, didTimeout: timedOut } : deadline);
            probe.callbacks.push({ observations: probe.observations - before.observations, writes: probe.writes - before.writes, timedOut });
        }, options);
        const frame = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => frame((time) => {
            const before = { observations: probe.observations, writes: probe.writes };
            callback(time);
            probe.frames.push({ observations: probe.observations - before.observations, writes: probe.writes - before.writes });
        });
        for (const Observer of [ResizeObserver, IntersectionObserver]) {
            const observe = Observer.prototype.observe;
            Observer.prototype.observe = function (...args) { probe.observations++; return observe.apply(this, args); };
        }
        const setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (name === 'data-ai-web-smooth-cold') probe.writes++;
            return setAttribute.call(this, name, value);
        };
    });
}

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const report = [];
    try {
        for (const studio of [false, true]) {
            const page = await browser.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(studio, 600) }));
            await page.goto(studio ? 'https://aistudio.google.com/prompts/startup' : 'https://chatgpt.com/c/startup');
            await instrumentation(page);
            await install(page);
            assert.ok(await page.evaluate(() => probe.bootstrapObservations) <= 256, '注入预热最多登记 128 对观察器，不能一次性登记完整会话');
            await page.locator('#composer').focus();
            // 普通连续输入中仍有小步进度，不能一直等待用户停笔才减轻历史渲染。
            await page.keyboard.type('startup typing without background registration', { delay: 30 });
            assert.ok(await page.evaluate(() => probe.observations) > 0, '普通连续输入不会让优化饿死');
            await page.locator('#composer').dispatchEvent('compositionstart');
            await page.evaluate(() => {
                // 即使快速机器已经完成启动，也给暂停/恢复场景提供真实待处理工作。
                const pre = document.createElement('pre');
                pre.textContent = '在组合输入期间更新的历史正文\n'.repeat(60);
                document.querySelector('#message-50 pre').replaceWith(pre);
            });
            const pausedObservations = await page.evaluate(() => probe.observations);
            await page.waitForTimeout(900);
            assert.equal(await page.evaluate(() => probe.observations), pausedObservations, '选词中停止新增观察目标');
            await page.evaluate(() => { probe.zeroIdle = true; });
            await page.locator('#composer').dispatchEvent('compositionend');
            await page.waitForTimeout(900);
            assert.equal(await page.evaluate(() => probe.observations), pausedObservations, '未超时且没有空闲额度时不强行执行');
            await page.evaluate(() => { probe.zeroIdle = false; probe.forcedTimeout = true; });
            await page.waitForTimeout(900);
            assert.ok(await page.evaluate(() => probe.observations) > pausedObservations, '持续繁忙时超时批次仍有受限进度');
            assert.equal(await page.evaluate(() => probe.callbacks.filter((c) => c.timedOut).every((c) => c.observations <= 128 && c.writes <= 64)), true);
            await page.evaluate(() => { probe.forcedTimeout = false; });
            await settled(page);
            const state = await diagnostics(page);
            assert.ok(state.cold > 1000, '释放输入与空闲限制后最终完成历史优化');
            assert.equal(state.documentScans, 1, '正常初始化仅发现一次消息结构');
            assert.equal(await page.evaluate(() => probe.callbacks.every((c) => c.observations <= 128 && c.writes <= 64)), true,
                '预热空闲批次至多 64 个目标，常态预算更小');
            assert.equal(await page.evaluate(() => probe.frames.every((c) => c.observations <= 32 && c.writes <= 32)), true,
                '每帧提交最多 32 个块，不在帧回调中批量注册新块');
            assert.equal(await page.locator('#composer').inputValue(), 'startup typing without background registration');

            await page.evaluate(() => {
                // 保留同一个 Text 节点，只修改 nodeValue；必须通过 characterData 发现。
                document.querySelector('#message-50 p span').firstChild.nodeValue = '编辑后的不同长度正文。'.repeat(230);
            });
            await settled(page);
            const editedHeight = await page.locator('main').evaluate((e) => e.scrollHeight);
            await menu(page, '暂停 / 恢复');
            assert.ok(Math.abs(await page.locator('main').evaluate((e) => e.scrollHeight) - editedHeight) <= 2,
                '历史文字原位编辑后，优化占位与自然高度一致');
            await menu(page, '暂停 / 恢复');
            await settled(page);
            await page.locator('#message-50 pre').evaluate((e) => e.setAttribute('contenteditable', 'true'));
            await settled(page);
            assert.equal(await page.locator('#message-50 pre').getAttribute('data-ai-web-smooth-cold'), null,
                '正文进入编辑态后撤回优化');

            // 输入法组合过程中直接移除编辑器，SPA 的后续会话也必须能够恢复优化。
            await page.locator('#composer').dispatchEvent('compositionstart');
            await page.evaluate((isStudio) => {
                document.querySelector('#composer').remove();
                const main = document.querySelector('main');
                main.innerHTML = Array.from({ length: 6 }, (_, i) => isStudio
                    ? `<ms-chat-turn><pre>${'replacement\n'.repeat(50)}</pre></ms-chat-turn>`
                    : `<section data-testid="conversation-turn-${i}"><pre>${'replacement\n'.repeat(50)}</pre></section>`).join('');
            }, studio);
            await settled(page);
            assert.equal((await diagnostics(page)).observed, 4);
            assert.deepEqual(errors, []);
            report.push({ platform: studio ? 'AI Studio' : 'ChatGPT', initialTyping: 'PASS', composition: 'PASS', idleBudget: 'PASS', registrationPacing: 'PASS', maxSliceMs: +state.maxSliceMs.toFixed(2) });
            await page.close();
        }

        const page = await browser.newPage();
        await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false, 1000) }));
        await page.goto('https://chatgpt.com/c/bounds');
        await page.evaluate(() => {
            // 极长单块应被有界检查跳过，绝不能因“每批一条消息”而一次遍历完。
            document.querySelector('#message-0 pre').innerHTML = '<span>巨型代码</span>'.repeat(10000);
        });
        await instrumentation(page);
        await install(page);
        await settled(page);
        assert.equal(await page.locator('#message-0 pre').getAttribute('data-ai-web-smooth-cold'), null);
        assert.equal((await diagnostics(page)).observed, 1800, '观察目标不随会话无限增长');
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
            // 变更记录超过微任务上限：后台保守重建，而不是静默丢失新消息。
            const main = document.querySelector('main');
            for (let i = 0; i < 200; i++) {
                const section = document.createElement('section');
                section.dataset.testid = `conversation-turn-${1000 + i}`;
                section.innerHTML = '<pre>new\nnew\nnew\nnew</pre>';
                main.append(section);
            }
        });
        const slices = (await diagnostics(page)).slices;
        await page.waitForTimeout(900);
        assert.equal((await diagnostics(page)).slices, slices, '隐藏页面不消耗后台批次');
        await page.evaluate(() => {
            delete document.hidden;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await settled(page);
        assert.ok((await diagnostics(page)).overflowRecoveries > 0);
        await menu(page, '暂停 / 恢复');
        assert.equal(await page.locator('[data-ai-web-smooth-cold]').count(), 0);
        report.push({ giantBlock: 'PASS', observerCap: 'PASS', hiddenTab: 'PASS', mutationOverflow: 'PASS', rollback: 'PASS' });
        await page.close();
        const fallback = await browser.newPage();
        await fallback.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false, 12) }));
        await fallback.goto('https://chatgpt.com/c/timer-fallback');
        await fallback.evaluate(() => { window.requestIdleCallback = undefined; });
        await install(fallback);
        await settled(fallback);
        assert.equal((await diagnostics(fallback)).observed, 20, '没有空闲回调 API 时仍可完成');
        await menu(fallback, '暂停 / 恢复');
        assert.equal(await fallback.locator('[data-ai-web-smooth-cold]').count(), 0);
        report.push({ timerFallback: 'PASS' });
        console.log(JSON.stringify(report, null, 2));
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
