/**
 * 渲染验收截图工具
 *
 * 用本机 Edge (无头模式) 打开开发服务器页面，等 WebGL 首帧渲染完成后截图。
 * 同时抓取 console 错误与页面内运行时状态，作为"渲染确实发生了"的证据。
 *
 * 用法：node tools/shot.mjs [url] [outfile]
 */

import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2] || 'http://127.0.0.1:5180/';
const OUT = process.argv[3] || 'probe/shot.png';

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // 无头模式下强制启用 WebGL（SwiftShader 软渲染兜底）
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,1000',
  ],
  defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
});

const page = await browser.newPage();

const consoleErrors = [];
const pageErrors = [];

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

// 等加载层消失（说明 init() 走完了）
try {
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 45000 },
  );
} catch {
  consoleErrors.push('加载层未消失（init 可能未完成）');
}

// 再等几帧，确保 WebGL 至少渲染过一次
await new Promise((r) => setTimeout(r, 2500));

// 读取页面内状态作为运行时证据
const probe = await page.evaluate(() => {
  const canvas = document.getElementById('scene');
  const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl');
  const labels = document.querySelectorAll('.spot-label').length;
  const visibleLabels = [...document.querySelectorAll('.spot-label')].filter(
    (e) => e.style.display !== 'none',
  ).length;
  return {
    canvasW: canvas?.width,
    canvasH: canvas?.height,
    webgl: !!gl,
    renderer: gl
      ? (() => {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a';
        })()
      : null,
    labels,
    visibleLabels,
    elMin: document.getElementById('el-min')?.textContent,
    elMax: document.getElementById('el-max')?.textContent,
    drop: document.getElementById('el-drop')?.textContent,
  };
});

await page.screenshot({ path: OUT, type: 'png' });

// 额外截一张不同视角，便于判断地形细节
await page.evaluate(() => {
  const btn = document.querySelector('.views button[data-view="yuzui"]');
  btn?.click();
});
await new Promise((r) => setTimeout(r, 2200));
const OUT2 = OUT.replace(/\.png$/, '_yuzui.png');
await page.screenshot({ path: OUT2, type: 'png' });

const OUT3 = OUT.replace(/\.png$/, '_yulei.png');
await page.evaluate(() => {
  const btn = document.querySelector('.views button[data-view="yuleige"]');
  btn?.click();
});
await new Promise((r) => setTimeout(r, 2200));
await page.screenshot({ path: OUT3, type: 'png' });

console.log(JSON.stringify({ probe, consoleErrors, pageErrors, files: [OUT, OUT2, OUT3] }, null, 2));

await browser.close();

const size = (await fs.stat(OUT)).size;
console.log(`主截图 ${OUT} ${size} 字节`);
