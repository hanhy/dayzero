import { createCipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { ModelProfile, ProfileInput } from '@dayzero/contracts';
import { ApiError, rows } from './knowledge-service.ts';

const profileFields = `id,name,purpose,base_url AS "baseUrl",model_id AS "modelId",encrypted_key IS NOT NULL AS "keyConfigured",updated_at AS "updatedAt"`;
export class ModelProfiles {
  constructor(
    private pool: Pool,
    private masterKey = process.env.MODEL_MASTER_KEY ?? '',
  ) {}
  get encryptionReady() {
    return Buffer.from(this.masterKey, 'base64').length === 32;
  }
  async list() {
    return {
      profiles: await rows<ModelProfile>(
        this.pool,
        `SELECT ${profileFields} FROM knowledge.model_profiles ORDER BY created_at,id`,
      ),
      encryptionReady: this.encryptionReady,
    };
  }
  async save(id: string, input: ProfileInput) {
    if (input.clearKey && input.apiKey)
      throw new ApiError(400, '清除密钥和设置新密钥不能同时提交');
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new ApiError(400, '请输入完整的模型服务地址');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new ApiError(
        400,
        '服务地址仅支持 HTTP/HTTPS，且不能包含凭据或查询参数',
      );
    if (!input.name.trim() || !input.modelId.trim())
      throw new ApiError(400, '配置名称和模型 ID 不能为空');
    let encrypted: string | null = null;
    if (input.apiKey) {
      if (!this.encryptionReady)
        throw new ApiError(
          503,
          '服务尚未初始化密钥加密，请先执行本机密钥初始化',
        );
      const nonce = randomBytes(12);
      const cipher = createCipheriv(
        'aes-256-gcm',
        Buffer.from(this.masterKey, 'base64'),
        nonce,
      );
      const ciphertext = Buffer.concat([
        cipher.update(input.apiKey, 'utf8'),
        cipher.final(),
      ]);
      encrypted = `v1:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
    }
    const result = await rows<ModelProfile>(
      this.pool,
      `INSERT INTO knowledge.model_profiles(id,name,purpose,base_url,model_id,encrypted_key)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=$2,purpose=$3,base_url=$4,model_id=$5,
      encrypted_key=CASE WHEN $7 THEN NULL WHEN $6::text IS NOT NULL THEN $6 ELSE knowledge.model_profiles.encrypted_key END,updated_at=now()
      RETURNING ${profileFields}`,
      [
        id,
        input.name.trim(),
        input.purpose,
        url.toString().replace(/\/$/, ''),
        input.modelId.trim(),
        encrypted,
        Boolean(input.clearKey),
      ],
    );
    return result[0]!;
  }
  async remove(id: string) {
    await this.pool.query('DELETE FROM knowledge.model_profiles WHERE id=$1', [
      id,
    ]);
    return { removed: true };
  }
}
