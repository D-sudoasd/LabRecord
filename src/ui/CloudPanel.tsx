import { useState, useEffect } from 'react';
import { Cloud, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { CloudStatus, CloudResult } from '../shared/model';
import { useWorkspace, unwrap } from './context';
import { ReportCloud } from './ReportCloud';
export function CloudPanel({ onBusyChange }: { onBusyChange?: (value: boolean) => void }) {
  const { flush, replace, notify } = useWorkspace();
  const [status, setStatus] = useState<CloudStatus | null>(null),
    [repository, setRepository] = useState('');
  const [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [result, setResult] = useState<CloudResult | null>(null);
  function changeBusy(value: boolean) {
    setBusy(value);
    onBusyChange?.(value);
  }
  async function refresh() {
    const value = await unwrap(window.labrecord.cloudStatus());
    setStatus(value);
    setRepository(value.repository || '');
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    changeBusy(true);
    setError('');
    try {
      const name = repository
        .trim()
        .replace(/^https:\/\/github\.com\//i, '')
        .replace(/\/$/, '')
        .replace(/\.git$/, '');
      const value = await unwrap(
        window.labrecord.cloudConnect({
          repository: name,
          token: token || undefined,
          create: true,
        }),
      );
      setStatus(value);
      setRepository(value.repository);
      setToken('');
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      changeBusy(false);
    }
  }
  async function sync(mode: 'auto' | 'upload' | 'download' = 'auto') {
    changeBusy(true);
    setError('');
    try {
      await flush();
      const value = await unwrap(window.labrecord.cloudSync(mode));
      setResult(value);
      if (value.snapshot) replace(value.snapshot);
      await refresh();
      if (value.action !== 'conflict') notify(value.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      changeBusy(false);
    }
  }
  return (
    <section className="cloud-panel form-stack" aria-label="GitHub 云同步">
      <h3>
        <Cloud size={18} /> GitHub 私人仓库同步
      </h3>
      <p className="hint">
        记录与现场图片一起同步。换电脑时连接同一私人仓库，点击同步即可接收；离线编辑后再次同步。
      </p>
      {status?.connected && (
        <p className="hint">
          <CheckCircle2 size={15} /> 已连接 {status.repository} · {status.account}
          {status.lastSyncedAt
            ? ` · 最近同步 ${new Date(status.lastSyncedAt).toLocaleString('zh-CN')}`
            : ' · 尚未同步'}
        </p>
      )}
      {!status?.connected ? (
        <form className="form-stack" onSubmit={connect}>
          <label className="field">
            <span>私人仓库</span>
            <input
              aria-label="私人仓库"
              required
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
              placeholder="你的账号/实验数据仓库"
              autoCapitalize="none"
              spellCheck={false}
            />
            <small>接受仓库网址或“账号/仓库名”；当前账号下不存在时创建私人仓库。</small>
          </label>
          <label className="field">
            <span>
              GitHub 访问令牌{status?.githubCliAvailable ? '（可留空，使用当前 GitHub 登录）' : ''}
            </span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                status?.githubCliAvailable
                  ? '已检测到 GitHub CLI 登录'
                  : '仅用于该仓库，Contents 读写权限'
              }
            />
            <small>
              令牌由此电脑的系统凭据加密保存，不会进入实验备份或仓库。已有仓库可使用细粒度令牌；创建仓库需要相应权限。
            </small>
          </label>
          <button className="button" disabled={busy}>
            {busy ? '连接中…' : '连接私人仓库'}
          </button>
        </form>
      ) : (
        <div className="backup-actions">
          <button
            className="button primary"
            disabled={busy}
            onClick={() => {
              void sync();
            }}
          >
            <RefreshCw size={16} />
            {busy ? '正在同步…' : '同步实验记录'}
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => {
              setStatus((old) => (old ? { ...old, connected: false } : old));
              setResult(null);
            }}
          >
            更换仓库或登录
          </button>
        </div>
      )}
      {result && (
        <div role="status" className={result.action === 'conflict' ? 'cloud-conflict' : 'callout'}>
          <p>{result.message}</p>
          {result.action === 'conflict' && (
            <>
              <p className="hint">
                本机 {result.local.experiments} 个实验 / {result.local.recorded} 次记录；云端{' '}
                {result.remote?.experiments} 个实验 / {result.remote?.recorded} 次记录。
              </p>
              <div className="backup-actions">
                <button
                  disabled={busy}
                  className="button"
                  onClick={() => {
                    void sync('download');
                  }}
                >
                  使用云端，本机留备份
                </button>
                <button
                  disabled={busy}
                  className="button"
                  onClick={() => {
                    void sync('upload');
                  }}
                >
                  使用本机，云端留历史
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <ReportCloud status={status} onStatus={setStatus} />
      {error && (
        <p role="alert" className="error-text">
          {error} 当前输入和本机记录已保留，可重试。
        </p>
      )}
      <small className="hint">
        同步会检查私人仓库并校验备份，图片较多时自动分段。两端都有修改时先选择保留哪份。完整备份展开上限
        512 MB，原始仪器数据仍保存在各自路径。
      </small>
    </section>
  );
}
