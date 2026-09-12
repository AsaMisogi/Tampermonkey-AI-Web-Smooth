/* 同一离线夹具对照：无脚本、归档 v1.2、新版。使用键盘事件触发继承字距改变，
 * 模拟宿主状态变化使历史正文重新排版。此压力模型不是 ChatGPT / AI Studio 的实现。
 * input 到帧后任务只是响应近似值，不称为 INP；记录原始样本，不据一次结果许诺倍数。
 */
'use strict';
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, settled, diagnostics } = require('./browser.test.cjs');
const sources = {
    '1.2.0': fs.readFileSync(path.join(__dirname, 'fixtures/AI-Web-Smooth-1.2.0.user.js'), 'utf8'),
    '1.3.0': fs.readFileSync(path.join(__dirname, '../AI-Web-Smooth.user.js'), 'utf8'),
};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const samples = [];
    try {
        const modes = process.env.BENCH_MODES ? process.env.BENCH_MODES.split(',') : ['none', '1.2.0', '1.3.0', '1.3.0', '1.2.0', 'none'];
        for (const mode of modes) {
            if (!['none', '1.2.0', '1.3.0'].includes(mode)) throw new Error('Unknown benchmark mode');
            const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
            await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: fixture(false, 200) }));
            await page.goto('https://chatgpt.com/c/input-benchmark');
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            await cdp.send('Performance.enable');
            await page.evaluate(() => {
                window.menuEntries = new Map();
                window.GM_getValue = () => ({});
                window.GM_setValue = () => {};
                window.GM_registerMenuCommand = (label, action) => { menuEntries.set(label, { label, action }); return label; };
                window.GM_unregisterMenuCommand = (id) => menuEntries.delete(id);
                window.responseTimes = [];
                window.longTasks = [];
                window.pendingFrames = 0;
                new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration)))
                    .observe({ type: 'longtask' });
                const editor = document.querySelector('#composer');
                editor.addEventListener('input', () => {
                    const start = performance.now();
                    document.querySelector('main').style.letterSpacing = `${editor.value.length % 2 ? 0.01 : 0}px`;
                    pendingFrames++;
                    requestAnimationFrame(() => setTimeout(() => { responseTimes.push(performance.now() - start); pendingFrames--; }, 0));
                });
            });
            if (mode !== 'none') await page.addScriptTag({ content: `window.injectionStart = performance.now();\n${sources[mode]}\nwindow.injectionMs = performance.now() - window.injectionStart;` });
            for (const phase of ['startup', 'settled']) {
                if (phase === 'settled') {
                    if (mode === '1.3.0') await settled(page);
                    else if (mode === '1.2.0') await page.waitForFunction(() => document.querySelectorAll('[data-ai-web-smooth-cold]').length > 350);
                    await page.waitForTimeout(700);
                }
                await page.locator('#composer').focus();
                await page.evaluate(() => { responseTimes = []; longTasks = []; });
                const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
                await page.keyboard.type('abcdef', { delay: 35 });
                for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace');
                await page.waitForFunction(() => pendingFrames === 0);
                const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
                const data = await page.evaluate(() => ({ times: responseTimes, longTasks, injectionMs: window.injectionMs || 0 }));
                samples.push({ mode, phase, injectionMs: +data.injectionMs.toFixed(2),
                    progress: mode === '1.3.0' ? await diagnostics(page) : null,
                    inputToPostFrameTaskMs: data.times.map((n) => +n.toFixed(2)),
                    medianMs: +percentile(data.times, 0.5).toFixed(2), p95Ms: +percentile(data.times, 0.95).toFixed(2),
                    layoutMs: +(1000 * (after.LayoutDuration - before.LayoutDuration)).toFixed(2),
                    styleMs: +(1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration)).toFixed(2),
                    longTasksMs: data.longTasks.map((n) => +n.toFixed(2)),
                });
            }
            await page.close();
        }
        const report = { browser: await browser.version(), cpuThrottle: 4, messages: 200,
            sourceSha256: require('node:crypto').createHash('sha256').update(sources['1.3.0']).digest('hex'),
            description: '离线继承样式失效压力测试。不是网站实际 INP；startup 从脚本注入后开始，未包含宿主首次构建/下载。', samples };
        fs.writeFileSync(path.join(__dirname, 'input-benchmark-results.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
    } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
