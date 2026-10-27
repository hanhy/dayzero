# Dayzero 个人知识图谱

当前阶段为 **M0 工程基线与技术验证**。浏览器中的 1,000 个点和 5,000 条边是固定种子的基准数据，不是个人知识库，也不表示已完成 AI 分类。

需求与开发计划分别见 [PRD](docs/PRD.md) 和[技术计划](docs/TECHNICAL_PLAN.md)。

## 本机开发

需要 Node.js 24、npm 11、Docker Compose，以及 Python 3.11。Docker Desktop 需处于运行状态。

```bash
npm ci
cp .env.example .env
npm run db:up
npm run db:migrate
python3.11 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r scripts/clustering/requirements.txt
npm run dev
```

打开 <http://127.0.0.1:5188>。API 在 `127.0.0.1:3188`，隔离数据库在 `127.0.0.1:54329`。数据库参数由 `.env` 配置，启动 worker 前应先执行迁移。

启动后可以选择基准节点、定位镜头、切换轨道观察与自由飞行。飞行模式下点击场景获取鼠标控制，WASD 移动，QE 上下，Esc 退出；搜索框内输入不会移动相机。

## Docker 运行

只运行页面和后台服务时，无需在宿主机安装 Node.js 或 Python：

```bash
docker compose up -d --build
```

打开 <http://127.0.0.1:3188>。app 会等待数据库就绪并执行迁移，worker 等待 app 健康检查通过。数据库使用项目专用持久卷。`docker compose down` 停止服务并保留数据库；删除卷会丢失数据。

镜像中的 Node 与 PostgreSQL 基础镜像已固定 digest，npm 依赖和 Python 依赖分别由锁文件固定。系统包仍通过 Debian 软件源安装，未承诺位级相同的镜像产物。

## 验证命令

```bash
npm run check
npm run build
npm run verify:m0
```

`verify:m0` 需要数据库在线、Python 虚拟环境已安装依赖、宿主机装有 Google Chrome。浏览器测试使用独立的 `3199` 和 `5199` 端口，不复用日常开发服务。可分别执行：

| 命令                      | 验证内容                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `npm run db:migrate`      | SQL 迁移校验与 LangGraph 检查点初始化；可重复运行           |
| `npm run verify:workflow` | 跨进程暂停恢复、提交后崩溃、重放、并发幂等及拒绝不写入      |
| `npm run verify:cluster`  | Python 子进程 JSON 协议、固定输入复现、三组节点与空库孤立点 |
| `npm run test:e2e`        | 实际旋转缩放、飞行移动、输入隔离、WebGL 降级及帧率采样      |

验证结果写入被 Git 忽略的 `artifacts/`，包含 `workflow.json`、`clustering.json`、`space.json` 和 `m0-space.png`。工作流验证只写 `m0` schema，不创建正式知识点，不调用付费模型。重新运行会产生新的独立验证记录。

Docker 中可执行 `docker compose exec worker npm run verify:workflow` 或 `docker compose exec worker /opt/venv/bin/python scripts/clustering/verify.py`。浏览器测试在宿主机运行。

## 工程结构

```text
apps/web          React、Vite 和三维基准页面
apps/server       Fastify API、静态页面与健康检查
apps/worker       pg-boss 后台进程与任务验证
packages/contracts 共享数据契约
packages/db       连接、Drizzle 入口、SQL 迁移
packages/workflows LangGraph 隔离验证流程
scripts/clustering Python Leiden 与带哈希的依赖锁定
tests             规则、健康检查与浏览器验证
docs              需求、计划与 M0 验证记录
```

`GET /api/health/live` 只验证进程在线；`GET /api/health` 校验数据库和 M0 迁移，未就绪返回 503。`GET /api/m0/evidence` 读取上次 CLI 验证结果摘要，不能代替当前运行健康检查。

Markdown 编辑、真实知识入库、模型配置与关联建议属于后续里程碑。M0 的通过仅表明技术路线和恢复机制可用。
