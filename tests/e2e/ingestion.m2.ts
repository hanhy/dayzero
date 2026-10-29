import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

test('AI ingestion: model tests, durable review, edited relation and explicit commit', async ({
  page,
  request,
}) => {
  const streamPrompts: string[] = [];
  let streamCancelled = false;
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (body.stream) {
      streamPrompts.push(body.messages[0].content);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let closed = false;
      res.on('close', () => {
        closed = true;
        if (!res.writableEnded) streamCancelled = true;
      });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '这是一个简单的概念解释。' } }] })}\n\n`,
      );
      await delay(1500);
      if (closed) return;
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '它说明了选中文字的含义。' }, finish_reason: 'stop' }] })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/embeddings') {
      res.end(
        JSON.stringify({
          data: body.input.map((_: string, index: number) => ({
            index,
            embedding: [0.3, 0.7, 0.4],
          })),
        }),
      );
      return;
    }
    const input = body.messages[1]
      ? JSON.parse(body.messages[1].content)
      : null;
    const content = !input
      ? '连接成功'
      : body.messages[0].content.includes('"coreConcept"')
        ? JSON.stringify({
            coreConcept: input.title,
            summary: '链式法则计算梯度，支持参数更新。',
          })
        : JSON.stringify({
            matches: input.candidates.map((c: any) => ({
              targetId: c.targetId,
              level: 'high',
              reason: '两者在参数优化中协同使用',
              duplicate: false,
            })),
            proposals: input.candidates.slice(0, 1).map((c: any) => ({
              targetId: c.targetId,
              type: 'used_for',
              direction: 'outgoing',
              description: '求导为更新提供梯度',
              draftQuote: input.draft.markdown.slice(0, 12),
              targetQuote: c.excerpt.slice(0, 12),
              confidence: 'supported',
            })),
          });
    res.end(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const profiles = [
      { id: randomUUID(), purpose: 'chat', name: '联调对话模型' },
      { id: randomUUID(), purpose: 'embedding', name: '联调向量模型' },
    ];
    for (const p of profiles) {
      const response = await request.put(`/api/models/${p.id}`, {
        data: {
          name: p.name,
          purpose: p.purpose,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          modelId: p.purpose,
          apiKey: 'isolated-fixture-only',
        },
      });
      expect(response.ok()).toBe(true);
    }
    const d = await (
      await request.post('/api/drafts', { data: { operationId: randomUUID() } })
    ).json();
    const edited = await (
      await request.put(`/api/drafts/${d.id}`, {
        data: {
          operationId: randomUUID(),
          expectedRevision: d.revision,
          title: '梯度下降',
          markdown: '# 梯度下降\n\n沿梯度反方向更新模型参数。',
          aliases: [],
          tags: [],
          sources: [],
          links: [],
        },
      })
    ).json();
    expect(
      (
        await request.post(`/api/drafts/${d.id}/commit`, {
          data: {
            operationId: randomUUID(),
            expectedRevision: edited.revision,
            confirmed: true,
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: /联调向量模型/ }).click();
    await page.getByRole('button', { name: '测试已保存配置' }).click();
    await expect(page.getByRole('status')).toContainText('3 维');
    await page.getByRole('button', { name: '关闭模型设置' }).click();
    await page
      .getByRole('button', { name: '＋ 新建知识点', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: '知识点标题', exact: true })
      .fill('反向传播');
    await page
      .getByRole('textbox', { name: 'Markdown 正文' })
      .fill('# 反向传播\n\n链式法则计算梯度，帮助更新参数。');
    const ai = page.getByRole('region', { name: 'AI 录入工作流' });
    await ai.getByRole('button', { name: '开始 AI 分析' }).click();
    await expect(ai.getByRole('button', { name: '接受建议' })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('knowledge-count')).toHaveText('1');
    await expect(ai).toContainText('两者在参数优化中协同使用');
    await expect(ai.getByText('概念解释', { exact: true })).toBeVisible();
    await expect(ai).toContainText('链式法则计算梯度，支持参数更新。');
    await expect(ai.getByText(/^待澄清：|^拆分建议：/)).toHaveCount(0);
    // Selection alone must not call a model. The first delta must be visible
    // while the upstream stream is still unfinished, and stop must cancel it.
    await page.getByRole('button', { name: '阅读预览', exact: true }).click();
    await page
      .locator('.markdown-preview p')
      .first()
      .evaluate((element) => {
        element.setAttribute('tabindex', '-1');
        (element as HTMLElement).focus();
        const range = document.createRange();
        range.setStart(element.firstChild!, 0);
        range.setEnd(element.firstChild!, 4);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
    await expect(page.getByRole('toolbar', { name: '划词操作' })).toBeVisible();
    expect(streamPrompts).toHaveLength(0);
    await page.getByRole('button', { name: '用 AI 解释选中文字' }).click();
    const wordPopup = page.getByRole('dialog', { name: '划词解释' });
    await expect(wordPopup.getByLabel('词语解释内容')).toContainText(
      '这是一个简单的概念解释。',
    );
    await expect(wordPopup.getByRole('status')).toHaveText('正在生成…');
    await expect(wordPopup.getByLabel('词语解释内容')).not.toContainText(
      '它说明了选中文字的含义。',
    );
    await expect(wordPopup.getByRole('status')).toHaveText('解释完成');
    expect(streamPrompts[0]).toBe(
      '链式法则是什么？请以最简单的方式介绍它的概念',
    );
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({
      path: 'artifacts/word-explanation.png',
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(wordPopup).toHaveCount(0);
    await expect(page.getByRole('toolbar', { name: '划词操作' })).toHaveCount(
      0,
    );
    await page
      .getByRole('textbox', { name: '知识点标题', exact: true })
      .selectText();
    await expect(page.getByRole('toolbar', { name: '划词操作' })).toBeVisible();
    await page.getByRole('button', { name: '用 AI 解释选中文字' }).click();
    await expect(wordPopup.getByLabel('词语解释内容')).toContainText(
      '这是一个简单的概念解释。',
    );
    await wordPopup.getByRole('button', { name: '停止生成' }).click();
    await expect(wordPopup.getByRole('status')).toHaveText('已停止生成');
    await expect.poll(() => streamCancelled).toBe(true);
    await wordPopup.getByRole('button', { name: '关闭划词解释' }).click();
    await expect(wordPopup).toHaveCount(0);
    await expect(page.getByTestId('knowledge-count')).toHaveText('1');
    await page
      .getByRole('button', { name: '编辑 Markdown', exact: true })
      .click();
    await page.getByRole('textbox', { name: 'Markdown 正文' }).focus();
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.getByRole('toolbar', { name: '划词操作' })).toBeVisible();
    expect(streamPrompts).toHaveLength(2);
    await page.keyboard.press('Escape');
    await ai.getByRole('button', { name: '接受建议' }).click();
    await ai
      .getByRole('combobox', { name: '建议关系类型' })
      .selectOption('prerequisite');
    await ai
      .getByRole('combobox', { name: '建议关系方向' })
      .selectOption('incoming');
    await ai
      .getByRole('textbox', { name: '建议关联说明' })
      .fill('梯度下降是理解优化过程的前置背景');
    await ai.getByRole('button', { name: '保存审阅决定' }).click();
    await expect(
      ai.getByRole('button', { name: '保存审阅决定' }),
    ).toBeEnabled();
    await page.reload();
    await page.getByRole('button', { name: '草稿 1', exact: true }).click();
    await page
      .locator('.library-item-button')
      .filter({ hasText: '反向传播' })
      .click();
    await expect(
      ai.getByRole('combobox', { name: '建议关系类型' }),
    ).toHaveValue('prerequisite');
    await expect(
      ai.getByRole('combobox', { name: '建议关系方向' }),
    ).toHaveValue('incoming');
    await expect(ai.getByRole('textbox', { name: '建议关联说明' })).toHaveValue(
      '梯度下降是理解优化过程的前置背景',
    );
    const currentDraft = (
      await (await request.get('/api/knowledge')).json()
    ).drafts.find((value: { title: string }) => value.title === '反向传播');
    const previousRun = await (
      await request.get(`/api/drafts/${currentDraft.id}/ingestion`)
    ).json();
    await ai.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`/api/drafts/${currentDraft.id}/ingestion`)
            ).json()
          ).id,
      )
      .not.toBe(previousRun.id);
    await expect(ai.getByRole('button', { name: '接受建议' })).toBeVisible({
      timeout: 30000,
    });
    const regenerated = await (
      await request.get(`/api/drafts/${currentDraft.id}/ingestion`)
    ).json();
    expect(
      (await (await request.get(`/api/ingestion/${previousRun.id}`)).json())
        .status,
    ).toBe('cancelled');
    expect(regenerated.decision).toBeNull();
    await expect(page.getByTestId('knowledge-count')).toHaveText('1');
    await expect(
      ai.getByRole('button', { name: '确认 AI 审阅并入图' }),
    ).toBeDisabled();
    await expect(
      ai.getByRole('combobox', { name: '建议关系类型' }),
    ).toHaveValue('used_for');
    await ai.getByRole('button', { name: '接受建议' }).click();
    await ai
      .getByRole('combobox', { name: '建议关系类型' })
      .selectOption('prerequisite');
    await ai
      .getByRole('combobox', { name: '建议关系方向' })
      .selectOption('incoming');
    await ai
      .getByRole('textbox', { name: '建议关联说明' })
      .fill('梯度下降是理解优化过程的前置背景');
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/m2-review.png', fullPage: true });
    await ai.getByRole('button', { name: '确认 AI 审阅并入图' }).click();
    await expect(page.getByTestId('knowledge-count')).toHaveText('2', {
      timeout: 30000,
    });
    const library = await (await request.get('/api/knowledge')).json();
    expect(library.relations).toHaveLength(1);
    const edge = library.relations[0];
    expect(edge.type).toBe('prerequisite');
    expect(
      library.nodes.find((node: any) => node.id === edge.sourceId).title,
    ).toBe('梯度下降');
    expect(
      library.nodes.find((node: any) => node.id === edge.targetId).title,
    ).toBe('反向传播');
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
