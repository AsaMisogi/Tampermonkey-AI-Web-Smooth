/* 合成渲染基准；结果仅对本机夹具成立，不代表真实站点输入延迟。 */
'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, install, menu, ready } = require('./browser.test.cjs');

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
        await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false) }));
        await page.goto('https://chatgpt.com/c/benchmark');
        await install(page);
        await ready(page);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');
        const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
        async function sample(mode) {
            const before = await metrics();
            // 每帧改变继承字距，模拟需要重新排版的页面状态变更。
            // 根尺寸读取故意强制结算布局，测量的是布局/样式工作，而非网络或模型生成。
            await page.evaluate(async () => {
                for (let i = 0; i < 24; i++) {
                    document.querySelector('main').style.letterSpacing = `${i % 2 ? 0.01 : 0}px`;
                    void document.querySelector('main').offsetHeight;
                    await new Promise(requestAnimationFrame);
                }
            });
            const after = await metrics();
            return { mode, layoutMs: +(1000 * (after.LayoutDuration - before.LayoutDuration)).toFixed(2), styleMs: +(1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration)).toFixed(2) };
        }
        const samples = [];
        // 交错次序，减少首次运行/缓存带来的单向偏差。
        for (let run = 0; run < 3; run++) {
            samples.push(await sample('enabled'));
            await menu(page, '暂停 / 恢复');
            await page.waitForTimeout(250);
            samples.push(await sample('paused'));
            await menu(page, '暂停 / 恢复');
            await ready(page);
        }
        const report = { browser: await browser.version(), messages: 600, framesPerSample: 24, description: '离线合成正文重新排版，不代表 ChatGPT/AI Studio 实际输入延迟或相对 v1.0 提速。', samples };
        fs.writeFileSync(path.join(__dirname, 'benchmark-results.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
