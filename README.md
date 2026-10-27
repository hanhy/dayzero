# Dayzero 个人知识图谱

当前完成 **M1 知识与关系数据闭环**。默认页面是自己的真实知识库：Markdown 草稿自动保存，经明确确认后进入三维图谱，可手工维护关联、查看历史、使用回收站和备份。AI 自动录入和关联建议将在 M2 实现。

文档：[PRD](docs/PRD.md)、[技术计划](docs/TECHNICAL_PLAN.md)、[M1 执行计划](docs/M1_EXECUTION_PLAN.md)、[M1 验收记录](docs/M1_VALIDATION.md)。

## 本机开发

需要 Node.js 24、npm 11、Docker Compose。首次启动：

```bash
npm ci
cp .env.example .env
npm run keys:init
npm run db:up
npm run db:migrate
npm run dev
```

已有 `.env` 时保留原文件。`keys:init` 只初始化缺失的模型加密主密钥，不替换已有密钥，不打印密钥值。修改环境后需重启服务。

打开 <http://127.0.0.1:5188>。API 为 `127.0.0.1:3188`，PostgreSQL 为 `127.0.0.1:54329`。连接参数在 `.env`，worker 启动前需先执行迁移。

## Docker 运行

已初始化 `.env` 后运行：

```bash
docker compose up -d --build
```

打开 <http://127.0.0.1:3188>。app 等待数据库就绪并执行迁移，worker 等待 app 健康检查通过。数据库使用项目专用持久卷，`docker compose down` 保留数据。

只用 Docker 时可在复制 `.env.example` 后，通过一次性容器初始化主密钥，无需安装宿主机 Node：

```bash
docker compose build app
docker compose run --rm --no-deps -v "$PWD/.env:/app/.env" app npm run keys:init
docker compose up -d
```

模型设置可保存对话和向量模型的服务地址、模型 ID 与 API Key。密钥由后端 AES-256-GCM 加密保存，界面只显示配置状态；连接测试和模型调用属于 M2。未初始化主密钥时仍可编辑知识，保存新的 API Key 会被阻止。

## 使用与数据恢复

- 点击「新建知识点」，编辑标题、Markdown、别名、标签和来源；等到「已保存」，草稿便已写入数据库。
- 检查可选的手工关联，点击「确认加入图谱」。改名和修改正文保留节点 ID 与关联。
- 点击圆点或列表项展开正文。拖动旋转、滚轮缩放；自由飞行模式点击场景后 WASD 移动、QE 上下、Esc 退出。编辑输入不触发飞行。
- 版本历史可将旧正文恢复为新版本。删除后进入回收站，恢复节点时恢复有效的随节点删除关联；手工删除的关系不会自动恢复。
- 多窗口编辑发生冲突时，保留当前输入；可重试，也可下载本地编辑 JSON 副本并载入最新版本。副本用于保留和手工合并改动，不是完整恢复文件。
- Markdown 导入生成新草稿，不自动入图或连线。单篇导出使用 JSON 值的 front matter；普通 Markdown 也能导入，不支持任意 YAML 元数据或文件夹双向同步。
- 「导出备份」下载版本化 JSON，包含节点、草稿、关系、版本历史与人工确认记录；恢复前显示摘要，首版仅允许恢复到空知识库，保留原 ID、方向和历史。

普通备份不含模型配置、API Key 或加密主密钥。恢复知识后需重新配置模型；迁移整个数据库时另行妥善保留原 `.env` 中的主密钥。正文以数据库为唯一来源，不在本机创建逐篇 Markdown 文件。

M0 的 1,000 点 / 5,000 边演示单独保留在 [基准页面](http://127.0.0.1:3188/?benchmark=1)，不会混入个人图谱。M1 真实空间的坐标与显示色不代表语义聚类结果。

## 验证命令

```bash
npm run check
npm run build
npm run test:integration
npm run test:e2e
```

集成和浏览器验证需要数据库在线，数据库用户需有创建测试库权限。脚本创建独立临时数据库，结束后删除，不向个人库写测试样本。浏览器测试需要宿主机 Google Chrome，使用 `3199`、`5199` 端口，不复用开发服务。

| 命令                       | 验证内容                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm run db:migrate`       | 迁移校验与 LangGraph 检查点初始化，可重复执行                                        |
| `npm run test:integration` | 事务回滚、幂等、版本冲突、图约束、历史、备份恢复、密钥保护、真实 worker 与新进程读取 |
| `npm run test:e2e`         | Markdown 完整闭环、多窗口冲突、模型设置，以及 M0 三维交互、帧率和 WebGL 降级         |
| `npm run verify:workflow`  | M0 LangGraph 跨进程暂停恢复、提交后重放及并发幂等                                    |
| `npm run verify:cluster`   | M0 Leiden 子进程协议与确定性验证                                                     |

聚类验证另需 Python 3.11：

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r scripts/clustering/requirements.txt
npm run verify:cluster
```

验证证据写入被 Git 忽略的 `artifacts/`。M1 集成报告为 `m1-integration.json`，浏览器截图为 `m1-editor.png`；M0 报告为 `workflow.json`、`clustering.json` 和 `space.json`。`verify:m0` 保留旧技术验证入口，其中浏览器阶段也会执行当前 M1 用例。

## 工程结构

```text
apps/web           React、CodeMirror、Markdown 阅读与三维知识空间
apps/server        Fastify API、事务知识服务、备份与加密设置
apps/worker        pg-boss、outbox 分发和幂等回执
packages/contracts TypeBox 共享契约
packages/db        PostgreSQL 连接、Drizzle 入口和 SQL 迁移
packages/workflows LangGraph M0 验证流程，M2 接入真实录入
scripts/clustering Python Leiden 与依赖锁定
tests              规则、健康检查与浏览器用例
docs               需求、计划和验收记录
```

`GET /api/health/live` 验证进程在线；`GET /api/health` 检查 PostgreSQL、pgvector 和知识业务迁移，未就绪返回 503。`GET /api/m0/evidence` 只读此前技术验证摘要。依赖和基础镜像已锁定，系统包仍来自 Debian 软件源，未承诺位级相同的镜像产物。
