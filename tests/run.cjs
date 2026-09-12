'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
// 任一检查失败立即返回非零状态，避免后续命令成功掩盖前一个失败。
for (const args of [
    ['--check', path.join(__dirname, '../AI-Web-Smooth.user.js')],
    ...['browser', 'regressions', 'scheduler'].map((name) => [path.join(__dirname, `${name}.test.cjs`)]),
]) {
    const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
