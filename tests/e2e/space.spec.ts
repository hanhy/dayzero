import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Metrics } from '../../apps/web/src/Space.tsx';

type BenchmarkWindow = Window & { benchmark?: Metrics };

test('renders baseline workload and supports orbit, selection, focus and flight exit', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  await page.addInitScript(() => {
    window.addEventListener('dayzero:benchmark', (event) => {
      (window as BenchmarkWindow).benchmark = (
        event as CustomEvent<Metrics>
      ).detail;
    });
  });
  await page.goto('/?benchmark=1');
  await expect(
    page.getByRole('heading', { name: '知识空间 / 技术预览' }),
  ).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('数据库与迁移已就绪')).toBeVisible();
  await expect(page.getByTestId('fps')).not.toContainText('—', {
    timeout: 15_000,
  });
  const position = () =>
    page.evaluate(() =>
      (window as BenchmarkWindow).benchmark!.cameraPosition.join(','),
    );
  const canvas = page.locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  const beforeOrbit = await position();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y + 35, { steps: 10 });
  await page.mouse.up();
  await expect.poll(position).not.toBe(beforeOrbit);
  const beforeZoom = await position();
  await page.mouse.wheel(0, 200);
  await expect.poll(position).not.toBe(beforeZoom);
  await page.getByRole('button', { name: '基准节点 0001' }).click();
  await expect(
    page.getByRole('heading', { name: '基准节点 0001' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '定位这个节点' }).click();
  await page.getByRole('button', { name: '返回全景' }).click();
  await page.getByRole('button', { name: '自由飞行' }).click();
  await expect(page.getByTestId('navigation-mode')).toContainText('飞行模式');
  await canvas.click({
    position: { x: bounds.width / 2, y: bounds.height / 2 },
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(document.pointerLockElement)))
    .toBe(true);
  const beforeFlight = await position();
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  await expect.poll(position).not.toBe(beforeFlight);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('navigation-mode')).toContainText('轨道模式');
  await page.getByRole('button', { name: '自由飞行' }).click();
  await page.getByRole('textbox', { name: '搜索基准节点' }).fill('0002');
  await expect(
    page.getByRole('button', { name: '基准节点 0002' }),
  ).toBeVisible();
  await page.waitForTimeout(1100);
  const beforeTyping = await position();
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await page.waitForTimeout(1100);
  expect(await position()).toBe(beforeTyping);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('navigation-mode')).toContainText('轨道模式');
  await page.getByRole('textbox', { name: '搜索基准节点' }).clear();
  await page.getByRole('checkbox', { name: '显示基准边' }).uncheck();
  await expect(
    page.getByRole('checkbox', { name: '显示基准边' }),
  ).not.toBeChecked();
  await page.getByRole('checkbox', { name: '显示基准边' }).check();
  // Observe several seconds rather than treating one startup frame as a benchmark.
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1050);
    samples.push(
      Number(
        (await page.getByTestId('fps').innerText()).replace(' FPS', '').trim(),
      ),
    );
  }
  const renderer = await page.locator('canvas').evaluate((canvas) => {
    const gl = (canvas as HTMLCanvasElement).getContext('webgl2');
    if (!gl) return 'unknown';
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return extension
      ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  });
  const report = {
    status: 'passed',
    checkedAt: new Date().toISOString(),
    nodes: 1000,
    edges: 5000,
    viewport: page.viewportSize(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    renderer,
    fpsSamples: samples,
    meanFps: samples.reduce((a, b) => a + b, 0) / samples.length,
    checks: [
      'orbit-drag',
      'wheel-zoom',
      'node-select-and-focus',
      'pointer-lock',
      'flight-translation',
      'typing-does-not-move-camera',
      'escape-exits-flight',
    ],
    note: 'Headless Chrome route feasibility only; final user-device performance remains M4/M6 acceptance.',
  };
  expect(errors).toEqual([]);
  expect(report.meanFps).toBeGreaterThanOrEqual(30);
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/m0-space.png', fullPage: true });
  await writeFile('artifacts/space.json', JSON.stringify(report, null, 2));
});

test('keeps node inspection available without WebGL', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ) {
      if (String(args[0]).startsWith('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.goto('/?benchmark=1');
  await expect(
    page.getByText(/三维场景暂不可用|当前浏览器不支持 WebGL/),
  ).toBeVisible();
  await page.getByRole('button', { name: '基准节点 0001' }).click();
  await expect(
    page.getByRole('heading', { name: '基准节点 0001' }),
  ).toBeVisible();
});
