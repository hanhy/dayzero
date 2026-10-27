import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test('personal knowledge round trip: autosave, confirm, link, history, recycle, import, backup and model settings', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: '从第一个知识点开始' }),
  ).toBeVisible();
  const editor = page.getByRole('region', { name: '知识编辑器' });
  await page
    .getByRole('button', { name: '＋ 新建知识点', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '知识点标题', exact: true })
    .fill('梯度下降');
  await page
    .getByRole('textbox', { name: 'Markdown 正文' })
    .fill('# 梯度下降\n\n沿梯度反方向更新参数。');
  await page.getByText('别名、标签与来源', { exact: false }).click();
  await page.getByRole('textbox', { name: '知识点别名' }).fill('GD, 梯度法');
  await page.getByRole('textbox', { name: '知识点标签' }).fill('优化, 数学');
  await page.getByRole('textbox', { name: '知识点来源' }).fill('个人整理');
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/knowledge')).json()).drafts[0]?.title,
    )
    .toBe('梯度下降');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await page.reload();
  await page.getByRole('button', { name: '草稿 1', exact: true }).click();
  await page
    .locator('.library-item-button')
    .filter({ hasText: '梯度下降' })
    .click();
  await expect(
    page.getByRole('textbox', { name: '知识点标题', exact: true }),
  ).toHaveValue('梯度下降');
  await expect(
    page.getByRole('textbox', { name: 'Markdown 正文' }),
  ).toContainText('沿梯度反方向更新参数');
  await page.getByRole('button', { name: '确认加入图谱 ↗' }).click();
  await expect(page.getByTestId('knowledge-count')).toHaveText('1');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await page
    .getByRole('button', { name: '＋ 新建知识点', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '知识点标题', exact: true })
    .fill('反向传播');
  await page
    .getByRole('textbox', { name: 'Markdown 正文' })
    .fill('# 反向传播\n\n利用链式法则求梯度。');
  await page.getByRole('button', { name: '＋ 添加手工关联' }).click();
  await page
    .getByRole('combobox', { name: '草稿关联1关系类型' })
    .selectOption('used_for');
  await page
    .getByRole('textbox', { name: '草稿关联1关联说明' })
    .fill('计算梯度用于更新参数');
  await page.getByRole('button', { name: '确认加入图谱 ↗' }).click();
  await expect(page.getByTestId('knowledge-count')).toHaveText('2');
  await expect(editor.locator('.relation-row')).toContainText(
    '用于 → 梯度下降',
  );
  await page
    .getByRole('button', { name: '编辑 Markdown', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: '知识点标题', exact: true })
    .fill('反向传播方法');
  await page
    .getByRole('textbox', { name: 'Markdown 正文' })
    .fill(
      '# 反向传播方法\n\n<script>window.__M1_XSS__ = 1</script>\n\n| 过程 | 说明 |\n| --- | --- |\n| 反传 | 求梯度 |\n\n[危险链接](javascript:alert(1))',
    );
  await expect
    .poll(async () =>
      (await (await request.get('/api/knowledge')).json()).nodes.some(
        (node: { title: string }) => node.title === '反向传播方法',
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: '阅读预览' }).click();
  await expect(editor.locator('table')).toContainText('求梯度');
  expect(
    await page.evaluate(
      () => (window as Window & { __M1_XSS__?: number }).__M1_XSS__,
    ),
  ).toBeUndefined();
  await expect(editor.locator('script')).toHaveCount(0);
  await page.getByText('内容历史与版本恢复', { exact: true }).click();
  await editor
    .locator('.version-row')
    .filter({ hasText: 'v1 · 反向传播' })
    .getByRole('button', { name: '恢复此版本' })
    .click();
  await expect(
    page.getByRole('textbox', { name: '知识点标题', exact: true }),
  ).toHaveValue('反向传播');
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '确认移入回收站' }).click();
  await expect(page.getByTestId('knowledge-count')).toHaveText('1');
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await page
    .locator('.library-item')
    .filter({ hasText: '反向传播' })
    .getByRole('button', { name: '恢复', exact: true })
    .click();
  await expect(page.getByTestId('knowledge-count')).toHaveText('2');
  const state = await (await request.get('/api/knowledge')).json();
  expect(
    state.relations.filter(
      (edge: { deletedAt: string | null }) => !edge.deletedAt,
    ),
  ).toHaveLength(1);

  await page.getByLabel('导入 Markdown 文件').setInputFiles({
    name: '概率.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 条件概率\n\n在给定条件下讨论事件。'),
  });
  await expect(
    page.getByRole('textbox', { name: '知识点标题', exact: true }),
  ).toHaveValue('条件概率');
  await expect(page.getByTestId('knowledge-count')).toHaveText('2');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出备份', exact: true }).click(),
  ]);
  await mkdir('artifacts', { recursive: true });
  await download.saveAs('artifacts/m1-browser-backup.json');
  const backup = JSON.parse(
    await readFile('artifacts/m1-browser-backup.json', 'utf8'),
  );
  expect(backup.nodes).toHaveLength(2);
  expect(backup.format).toBe('dayzero-knowledge');
  expect(backup.confirmations.length).toBeGreaterThan(0);
  await page
    .getByLabel('恢复备份文件')
    .setInputFiles('artifacts/m1-browser-backup.json');
  const restore = page.getByRole('dialog', { name: '恢复备份确认' });
  await expect(restore).toContainText('当前知识库已有内容');
  await expect(
    restore.getByRole('button', { name: '确认恢复备份' }),
  ).toBeDisabled();
  await restore.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page
    .getByRole('textbox', { name: '模型配置名称' })
    .fill('本地对话模型');
  await page
    .getByRole('textbox', { name: '模型服务地址' })
    .fill('http://127.0.0.1:11434/v1');
  await page
    .getByRole('textbox', { name: '模型 ID', exact: true })
    .fill('local-model');
  await page
    .getByLabel('模型 API Key', { exact: true })
    .fill('e2e-only-dummy-key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(
    page.getByText('配置已保存，密钥仅保存在服务端。'),
  ).toBeVisible();
  await expect(page.getByLabel('模型 API Key', { exact: true })).toHaveValue(
    '',
  );
  await page.getByRole('button', { name: '关闭模型设置' }).click();
  await page.getByRole('button', { name: '知识点 2', exact: true }).click();
  await page
    .locator('.library-item-button')
    .filter({ hasText: '反向传播' })
    .click();
  await expect(editor.locator('.relation-row')).toContainText('梯度下降');
  await page.screenshot({ path: 'artifacts/m1-editor.png', fullPage: true });
  // A second client saves first. Recover without silently overwriting either edit.
  const current = (
    await (await request.get('/api/knowledge')).json()
  ).nodes.find((node: { title: string }) => node.title === '反向传播');
  const remote = await request.put(`/api/nodes/${current.id}`, {
    data: {
      operationId: crypto.randomUUID(),
      expectedRevision: current.revision,
      title: '其他窗口的版本',
      markdown: current.markdown,
      aliases: current.aliases,
      tags: current.tags,
      sources: current.sources,
    },
  });
  expect(remote.ok()).toBe(true);
  await page
    .getByRole('textbox', { name: '知识点标题', exact: true })
    .fill('本地尚未保存的版本');
  await expect(page.getByTestId('save-status')).toHaveText('保存失败');
  const [localCopy] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '下载本地副本并载入最新版本' }).click(),
  ]);
  await localCopy.saveAs('artifacts/m1-conflict-copy.json');
  expect(
    JSON.parse(await readFile('artifacts/m1-conflict-copy.json', 'utf8')).title,
  ).toBe('本地尚未保存的版本');
  await expect(
    page.getByRole('textbox', { name: '知识点标题', exact: true }),
  ).toHaveValue('其他窗口的版本');
  await expect(page.getByTestId('save-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await expect(editor).toHaveCount(0);
  expect(errors).toEqual([]);
});
