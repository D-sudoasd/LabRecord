import { safeStorage } from 'electron';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GithubClient, repositorySchema } from './github-sync.js';
import type { CloudStatus } from '../shared/model.js';
const exec = promisify(execFile);
const configSchema = z
  .object({
    repository: repositorySchema,
    account: z.string(),
    source: z.enum(['github-cli', 'encrypted-token']),
    encryptedToken: z.string().optional(),
    reportArchiveEnabled: z.boolean().optional(),
  })
  .strict();
type Config = z.infer<typeof configSchema>;
async function githubToken(): Promise<string | null> {
  try {
    const result = await exec('gh', ['auth', 'token', '--hostname', 'github.com'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 8192,
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
export class CloudCredentials {
  constructor(readonly path: string) {}
  async config(): Promise<Config | null> {
    try {
      return configSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('云同步配置读取失败，请重新连接私人仓库。');
    }
  }
  async client(): Promise<{ config: Config; client: GithubClient }> {
    const config = await this.config();
    if (!config) throw new Error('请先连接 GitHub 私人仓库。');
    let token: string | null = null;
    if (config.source === 'github-cli') token = await githubToken();
    else if (safeStorage.isEncryptionAvailable() && config.encryptedToken) {
      try {
        token = safeStorage.decryptString(Buffer.from(config.encryptedToken, 'base64'));
      } catch {
        throw new Error('此电脑无法读取登录信息，请重新连接。');
      }
    }
    if (!token)
      throw new Error('GitHub 登录不可用，请重新连接；可粘贴仅用于此私人仓库的访问令牌。');
    return { config, client: new GithubClient(token) };
  }
  async status(lastSyncedAt: string | null): Promise<CloudStatus> {
    const config = await this.config();
    const cli = !!(await githubToken());
    return {
      repository: config?.repository || '',
      account: config?.account || '',
      connected: !!config,
      githubCliAvailable: cli,
      lastSyncedAt,
      reportArchiveEnabled: config?.reportArchiveEnabled !== false,
    };
  }
  async connect(input: unknown) {
    const value = z
      .object({
        repository: repositorySchema,
        token: z.string().max(512).optional(),
        create: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const explicit = value.token?.trim();
    const token = explicit || (await githubToken());
    if (!token) throw new Error('请粘贴 GitHub 访问令牌，或先完成 GitHub CLI 登录。');
    const account = await new GithubClient(token).connect(value.repository, value.create);
    const config: Config = {
      repository: value.repository,
      account,
      source: explicit ? 'encrypted-token' : 'github-cli',
      reportArchiveEnabled: (await this.config())?.reportArchiveEnabled !== false,
    };
    if (explicit) {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('此电脑的系统凭据加密不可用，无法安全保存令牌。');
      config.encryptedToken = safeStorage.encryptString(explicit).toString('base64');
    }
    await writeFile(this.path + '.tmp', JSON.stringify(config));
    await rename(this.path + '.tmp', this.path);
    return this.status(null);
  }
  async setReportArchiveEnabled(enabled: unknown) {
    const value = z.boolean().parse(enabled),
      config = await this.config();
    if (!config) throw new Error('请先连接私人仓库。');
    config.reportArchiveEnabled = value;
    await writeFile(this.path + '.tmp', JSON.stringify(config));
    await rename(this.path + '.tmp', this.path);
    return this.status(null);
  }
}
