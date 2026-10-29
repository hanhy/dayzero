import { useEffect, useState } from 'react';
import type { ModelProfile, ProfileInput } from '@dayzero/contracts';
import { api, mutation } from './api.ts';

const empty: ProfileInput = {
  name: '',
  purpose: 'chat',
  baseUrl: '',
  modelId: '',
  apiKey: '',
  clearKey: false,
};
export default function ModelSettings({ onClose }: { onClose: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]),
    [ready, setReady] = useState(false);
  const [id, setId] = useState<string>(() => crypto.randomUUID()),
    [form, setForm] = useState<ProfileInput>(empty);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = async () => {
    const result = await api<{
      profiles: ModelProfile[];
      encryptionReady: boolean;
    }>('/api/models');
    setProfiles(result.profiles);
    setReady(result.encryptionReady);
  };
  useEffect(() => {
    void refresh().catch((error) => setError(error.message));
  }, []);
  const select = (profile?: ModelProfile) => {
    setId(profile?.id ?? crypto.randomUUID());
    setForm(
      profile
        ? {
            name: profile.name,
            purpose: profile.purpose,
            baseUrl: profile.baseUrl,
            modelId: profile.modelId,
            apiKey: '',
            clearKey: false,
          }
        : empty,
    );
    setError('');
    setNotice('');
  };
  const save = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await mutation(`/api/models/${id}`, form, 'PUT');
      setForm((current) => ({ ...current, apiKey: '', clearKey: false }));
      await refresh();
      setNotice('配置已保存，密钥仅保存在服务端。');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="editor-drawer settings-drawer" aria-label="模型设置">
      <header className="drawer-header">
        <div>
          <span className="eyebrow">MODEL CONNECTIONS</span>
          <h2>模型配置</h2>
        </div>
        <button
          className="icon-button"
          aria-label="关闭模型设置"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="editor-scroll">
        <p className="muted">
          分别保存对话模型和向量模型的连接配置。保存后可分别测试连接，草稿内可启动
          AI 分析。
        </p>
        {!ready && (
          <div className="notice-banner">
            密钥加密尚未初始化，服务地址等配置仍可保存。
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="success-banner" role="status">
            {notice}
          </div>
        )}
        <div className="profile-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={
                id === profile.id ? 'profile-card active' : 'profile-card'
              }
              onClick={() => select(profile)}
            >
              <strong>{profile.name}</strong>
              <small>
                {profile.purpose === 'chat' ? '对话' : '向量'} ·{' '}
                {profile.modelId} ·{' '}
                {profile.keyConfigured ? '密钥已保存' : '无密钥'}
              </small>
            </button>
          ))}
        </div>
        <button className="secondary-button" onClick={() => select()}>
          ＋ 新配置
        </button>
        <div className="settings-form">
          <label>
            配置名称
            <input
              aria-label="模型配置名称"
              value={form.name}
              maxLength={100}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
            />
          </label>
          <label>
            用途
            <select
              aria-label="模型用途"
              value={form.purpose}
              onChange={(event) =>
                setForm({
                  ...form,
                  purpose: event.target.value as ProfileInput['purpose'],
                })
              }
            >
              <option value="chat">对话模型</option>
              <option value="embedding">向量模型</option>
            </select>
          </label>
          <label>
            服务地址
            <input
              aria-label="模型服务地址"
              placeholder="https://your-provider.example/v1"
              value={form.baseUrl}
              onChange={(event) =>
                setForm({ ...form, baseUrl: event.target.value })
              }
            />
          </label>
          <label>
            模型 ID
            <input
              aria-label="模型 ID"
              value={form.modelId}
              maxLength={200}
              onChange={(event) =>
                setForm({ ...form, modelId: event.target.value })
              }
            />
          </label>
          <label>
            API Key
            <input
              aria-label="模型 API Key"
              type="password"
              autoComplete="new-password"
              placeholder={
                profiles.find((profile) => profile.id === id)?.keyConfigured
                  ? '已保存，留空则保留原密钥'
                  : '本地服务可留空'
              }
              value={form.apiKey ?? ''}
              onChange={(event) =>
                setForm({ ...form, apiKey: event.target.value })
              }
            />
          </label>
          {profiles.find((profile) => profile.id === id)?.keyConfigured && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={form.clearKey ?? false}
                onChange={(event) =>
                  setForm({ ...form, clearKey: event.target.checked })
                }
              />
              清除原密钥
            </label>
          )}
        </div>
        {profiles.some((profile) => profile.id === id) && (
          <button
            className="text-button danger-text"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(`/api/models/${id}`, { method: 'DELETE' })
                .then(async () => {
                  await refresh();
                  select();
                })
                .catch((error) => setError(error.message))
                .finally(() => setBusy(false));
            }}
          >
            删除此配置
          </button>
        )}
      </div>
      <footer className="drawer-footer">
        <button
          className="secondary-button"
          disabled={busy || !profiles.some((p) => p.id === id)}
          onClick={() => {
            setBusy(true);
            setError('');
            setNotice('');
            void mutation<{ durationMs: number; dimensions?: number }>(
              `/api/models/${id}/test`,
              {},
            )
              .then((result) =>
                setNotice(
                  `连接测试通过 · ${result.durationMs} ms${result.dimensions ? ` · ${result.dimensions} 维` : ''}`,
                ),
              )
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          测试已保存配置
        </button>
        <span>普通备份不包含模型配置和密钥</span>
        <button
          className="primary-button"
          disabled={
            busy ||
            !form.name.trim() ||
            !form.baseUrl.trim() ||
            !form.modelId.trim()
          }
          onClick={() => {
            void save();
          }}
        >
          保存配置
        </button>
      </footer>
    </section>
  );
}
