import { useState, useEffect } from 'react';
import {
  FlaskConical,
  LayoutList,
  NotebookPen,
  ClipboardCheck,
  Settings,
  Plus,
  CheckCircle2,
  LoaderCircle,
  AlertCircle,
  X,
  ArrowRight,
  HardDrive,
  Download,
  Upload,
  FolderOpen,
  Trash2,
  FilePlus2,
  BookOpen,
  Cloud,
  Eye,
} from 'lucide-react';
import { useWorkspace, unwrap } from './context';
import { Plan } from './Plan';
import { Live } from './Live';
import { Review } from './Review';
import { Modal } from './components';
import { CloudPanel } from './CloudPanel';
import { ExperimentOverview } from './ExperimentOverview';
import { DEFAULT_PATTERN, filenameFor, type Field, type DesktopInfo } from '../shared/model';
import './workspace.css';

function NewExperiment({ onClose }: { onClose: () => void }) {
  const { execute } = useWorkspace();
  const [name, setName] = useState(''),
    [code, setCode] = useState('EXP-' + new Date().toLocaleDateString('sv-SE').replaceAll('-', '')),
    [description, setDescription] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await execute({ type: 'createExperiment', name, code, description });
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="新建实验" onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <label className="field">
          <span>实验名称 *</span>
          <input
            required
            autoFocus
            placeholder="例如 10 月同步辐射原位拉伸"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="field">
          <span>实验编号 *</span>
          <input required value={code} onChange={(event) => setCode(event.target.value)} />
          <small>用于生成预期文件名，在同一本地数据库中唯一。</small>
        </label>
        <label className="field">
          <span>说明（可选）</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            placeholder="束线、机时、实验目标或联系人等"
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            创建实验
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function SettingsDialog({
  onClose,
  dataFirst = false,
}: {
  onClose: () => void;
  dataFirst?: boolean;
}) {
  const { snapshot, experimentId, execute, notify, replace, flush } = useWorkspace();
  const experiment = snapshot.experiments.find((e) => e.id === experimentId);
  const [name, setName] = useState(experiment?.name || ''),
    [description, setDescription] = useState(experiment?.description || ''),
    [pattern, setPattern] = useState(experiment?.namingPattern || DEFAULT_PATTERN),
    [fields, setFields] = useState<Field[]>(experiment?.fields || []);
  const [info, setInfo] = useState<DesktopInfo | null>(null),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [cloudWorking, setCloudWorking] = useState(false),
    [tab, setTab] = useState<'experiment' | 'data' | 'cloud'>(
      dataFirst ? 'cloud' : experiment ? 'experiment' : 'data',
    );
  useEffect(() => {
    unwrap(window.labrecord.info())
      .then(setInfo)
      .catch((error) => setError(error.message));
  }, []);
  let preview: string;
  try {
    preview = filenameFor(pattern, experiment?.code || 'EXP', 'SAMPLE-01', 1);
  } catch (failure) {
    preview = (failure as Error).message;
  }
  function patchField(id: string, patch: Partial<Field>) {
    setFields((old) => old.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!experiment) return;
    setWorking(true);
    try {
      await execute({
        type: 'updateExperiment',
        id: experiment.id,
        name,
        description,
        namingPattern: pattern,
        fields,
      });
      notify('实验设置已保存。');
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function backup() {
    setWorking(true);
    try {
      await flush();
      const path = await unwrap(window.labrecord.backup());
      if (path) notify(`完整备份已保存：${path}`);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function restore() {
    setWorking(true);
    try {
      await flush();
      const data = await unwrap(window.labrecord.restore());
      if (data) {
        replace(data);
        notify('备份已恢复，原有数据已另存完整备份。');
        onClose();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal
      title="实验设置与本地数据"
      onClose={onClose}
      wide
      closeDisabled={working || cloudWorking}
    >
      <div className="dialog-tabs">
        {experiment && (
          <button
            className={tab === 'experiment' ? 'active' : ''}
            disabled={working || cloudWorking}
            onClick={() => setTab('experiment')}
          >
            实验设置
          </button>
        )}
        <button
          className={tab === 'data' ? 'active' : ''}
          disabled={working || cloudWorking}
          onClick={() => setTab('data')}
        >
          保存与备份
        </button>
        <button
          className={tab === 'cloud' ? 'active' : ''}
          disabled={working || cloudWorking}
          onClick={() => setTab('cloud')}
        >
          云同步
        </button>
      </div>
      {tab === 'experiment' && experiment ? (
        <form onSubmit={save} className="form-stack">
          <div className="form-grid">
            <label className="field">
              <span>实验名称</span>
              <input required value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>实验编号</span>
              <input value={experiment.code} readOnly />
            </label>
          </div>
          <label className="field">
            <span>实验说明</span>
            <textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="section-title">
            <h3>文件命名规则</h3>
          </div>
          <label className="field">
            <span>规则</span>
            <input value={pattern} onChange={(event) => setPattern(event.target.value)} />
            <small>
              支持 {'{experiment}'}、{'{sample}'}、{'{run:03}'}
              。样品原名保留，预期文件名中的特殊字符替换为下划线。
            </small>
          </label>
          <div className="filename-preview">
            <span>预览</span>
            <code>{preview}</code>
          </div>
          <div className="section-title">
            <h3>自定义实验参数</h3>
            <button
              type="button"
              className="button small"
              onClick={() =>
                setFields((old) => [
                  ...old,
                  { id: crypto.randomUUID(), label: '', type: 'text', unit: '', options: [] },
                ])
              }
            >
              <Plus size={14} />
              添加字段
            </button>
          </div>
          <p className="hint">
            字段可以填写尺寸、成分、温度、浓度、载荷等。已有操作保留开始时的字段与单位。
          </p>
          <div className="field-definition-list">
            {fields.map((field, index) => (
              <div className="field-definition" key={field.id}>
                <input
                  aria-label={`字段 ${index + 1} 名称`}
                  required
                  placeholder="参数名称"
                  value={field.label}
                  onChange={(event) => patchField(field.id, { label: event.target.value })}
                />
                <select
                  aria-label={`字段 ${index + 1} 类型`}
                  value={field.type}
                  onChange={(event) =>
                    patchField(field.id, { type: event.target.value as Field['type'] })
                  }
                >
                  <option value="text">文本</option>
                  <option value="number">数值</option>
                  <option value="select">选项</option>
                </select>
                <input
                  aria-label={`字段 ${index + 1} 单位`}
                  placeholder="单位（可空）"
                  value={field.unit}
                  onChange={(event) => patchField(field.id, { unit: event.target.value })}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`移除字段 ${index + 1}`}
                  onClick={() => setFields((old) => old.filter((f) => f.id !== field.id))}
                >
                  <Trash2 size={16} />
                </button>
                {field.type === 'select' && (
                  <input
                    className="span-4"
                    aria-label={`字段 ${index + 1} 选项`}
                    placeholder="选项用逗号分隔，例如 纵向,横向,45°"
                    value={field.options.join(',')}
                    onChange={(event) =>
                      patchField(field.id, {
                        options: event.target.value
                          .split(/[,，]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                )}
              </div>
            ))}
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <footer className="modal-actions">
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button disabled={working} className="button primary">
              保存实验设置
            </button>
          </footer>
        </form>
      ) : tab === 'cloud' ? (
        <CloudPanel onBusyChange={setCloudWorking} />
      ) : (
        <div className="form-stack">
          <div className="data-summary">
            <HardDrive size={28} />
            <div>
              <h3>所有记录保存在这台电脑</h3>
              <p>离线可用。软件包和实验数据分别保存，更新软件不会覆盖记录。</p>
            </div>
          </div>
          <label className="field">
            <span>数据目录</span>
            <code className="path-display">{info?.dataPath || '读取中…'}</code>
          </label>
          <label className="field">
            <span>自动备份目录</span>
            <code className="path-display">{info?.backupPath || '读取中…'}</code>
            <small>
              每天首次打开或保存实验后创建一份完整备份，保留最近 10 份自动备份；手动备份不自动清理。
            </small>
          </label>
          {info?.automaticBackupError && (
            <p className="error-text" role="alert">
              自动备份未成功：{info.automaticBackupError}。请检查存储目录，并使用手动备份重试。
            </p>
          )}
          <div className="backup-actions">
            <button
              className="button primary"
              disabled={working}
              onClick={() => {
                void backup();
              }}
            >
              <Download size={17} />
              备份全部数据与附件
            </button>
            <button
              className="button"
              disabled={working}
              onClick={() => {
                void restore();
              }}
            >
              <Upload size={17} />
              恢复完整备份
            </button>
            <button
              className="button"
              onClick={() => {
                void unwrap(window.labrecord.revealData()).catch((error) =>
                  setError(error.message),
                );
              }}
            >
              <FolderOpen size={17} />
              打开数据目录
            </button>
          </div>
          <div className="callout">
            <p>
              完整备份包含全部实验、修改历史和现场图片。恢复前会检查数据库、文件清单与
              SHA-256，并备份当前数据。
            </p>
            <p>实验数据文件引用保存为路径；仪器数据保存在原来的位置。</p>
          </div>
          <p className="hint">LabRecord {info?.version || ''} · 起止时间用于大致对应仪器数据</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
export function App() {
  const workspace = useWorkspace();
  const {
    snapshot,
    experimentId,
    setExperimentId,
    page,
    setPage,
    loading,
    busy,
    dirtyCount,
    failedCount,
    alert,
    execute,
    flush,
    notify,
  } = workspace;
  const [cloudFirst, setCloudFirst] = useState(false);
  const [newExperiment, setNewExperiment] = useState(false),
    [settings, setSettings] = useState(false),
    [overview, setOverview] = useState(false);
  const experiment = snapshot.experiments.find((e) => e.id === experimentId);
  function navigate(action: () => void) {
    void flush()
      .then(action)
      .catch((error) => notify(error.message, true));
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !experiment ||
        !event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        document.querySelector('dialog[open]')
      )
        return;
      const next = ({ '1': 'plan', '2': 'live', '3': 'review' } as const)[
        event.key as '1' | '2' | '3'
      ];
      if (!next) return;
      event.preventDefault();
      void flush()
        .then(() => setPage(next))
        .catch((error) => notify(error.message, true));
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [experiment, flush, setPage, notify]);
  const nav = [
    { id: 'plan' as const, label: '实验规划', detail: '样品与测试安排', icon: LayoutList },
    { id: 'live' as const, label: '现场记录', detail: '操作与现场观察', icon: NotebookPen },
    { id: 'review' as const, label: '回看导出', detail: '核对与实验报告', icon: ClipboardCheck },
  ];
  return (
    <div className="app-shell">
      <aside className="app-rail">
        <div className="rail-brand">
          <div className="brand-mark" title="LabRecord">
            <FlaskConical size={25} />
          </div>
          <div className="rail-brand-copy">
            <strong>LabRecord</strong>
            <span>让实验记录井然有序</span>
          </div>
        </div>
        <p className="rail-section-label">实验工作空间</p>
        <nav aria-label="主要导航">
          {nav.map(({ id, label, detail, icon: Icon }, index) => (
            <button
              key={id}
              className={page === id ? 'active' : ''}
              disabled={!experiment}
              aria-label={label}
              aria-current={page === id ? 'page' : undefined}
              aria-keyshortcuts={`Control+${index + 1}`}
              title={`${label} · Ctrl + ${index + 1}`}
              onClick={() => navigate(() => setPage(id))}
            >
              <Icon size={21} />
              <span className="nav-copy">
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
              <span className="nav-step" aria-hidden="true">
                {index + 1}
              </span>
            </button>
          ))}
        </nav>
        <div className="rail-bottom">
          <button
            aria-label="打开使用说明"
            title="使用说明"
            onClick={() => {
              void unwrap(window.labrecord.openHelp()).catch((error) =>
                notify(error.message, true),
              );
            }}
          >
            <BookOpen size={19} />
            <span>使用说明</span>
          </button>
          <button
            aria-label="打开设置"
            title="实验设置与本地数据"
            onClick={() => navigate(() => setSettings(true))}
          >
            <Settings size={19} />
            <span>实验设置</span>
          </button>
          <div className="rail-storage">
            <HardDrive size={18} />
            <div>
              <strong>离线可用</strong>
              <small>记录自动保存到本机</small>
            </div>
          </div>
          <small className="rail-shortcut">Ctrl + 1 / 2 / 3 切换页面</small>
        </div>
      </aside>
      <main className="app-main">
        <header className="app-header workspace-header">
          <div className="experiment-switcher">
            <div className="experiment-symbol">
              <FlaskConical size={19} aria-hidden="true" />
            </div>
            <div className="experiment-selection">
              <span className="header-caption">当前实验</span>
              <select
                aria-label="选择实验"
                value={experimentId}
                onChange={(event) => {
                  const id = event.target.value;
                  navigate(() => setExperimentId(id));
                }}
              >
                {snapshot.experiments.length ? (
                  snapshot.experiments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · {e.code}
                    </option>
                  ))
                ) : (
                  <option value="">尚未建立实验</option>
                )}
              </select>
            </div>
            <button
              className="icon-button"
              aria-label="新建实验"
              title="新建实验"
              onClick={() => navigate(() => setNewExperiment(true))}
            >
              <Plus size={19} />
            </button>
          </div>
          <button
            className="button small overview-open"
            aria-label="实验概览"
            title="实验概览"
            onClick={() => navigate(() => setOverview(true))}
            disabled={!experiment}
          >
            <Eye size={17} />
            <span>实验概览</span>
          </button>
          <button
            className="button small cloud-open"
            aria-label="云同步"
            onClick={() =>
              navigate(() => {
                setCloudFirst(true);
                setSettings(true);
              })
            }
          >
            <Cloud size={17} />
            <span>云同步</span>
          </button>
          <div className={`save-indicator ${failedCount ? 'failed' : ''}`} role="status">
            {failedCount ? (
              <>
                <AlertCircle size={16} />
                <span>保存失败</span>
                {dirtyCount > 0 ? (
                  <button
                    className="text-button"
                    onClick={() => {
                      void flush().catch((error) => notify(error.message, true));
                    }}
                  >
                    重试
                  </button>
                ) : (
                  <span>请重试操作</span>
                )}
              </>
            ) : busy || dirtyCount ? (
              <>
                <LoaderCircle size={16} className="spin" />
                <span>正在保存</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={16} />
                <span>已保存到本机</span>
              </>
            )}
          </div>
        </header>
        {loading ? (
          <div className="loading-screen">
            <LoaderCircle className="spin" />
            <p>正在读取本地实验记录</p>
          </div>
        ) : !experiment ? (
          <div className="welcome">
            <div className="welcome-decoration">
              <span className="deco-line" />
              <FlaskConical size={46} />
              <span className="deco-line" />
            </div>
            <div className="eyebrow">PLAN. RECORD. REVISIT.</div>
            <h1>让每一次实验，都有清楚的记录。</h1>
            <p>
              提前安排样品与文件命名，现场随手记录变化。
              <br />
              准备、测试、备样分开管理；所有内容离线保存在本机。
            </p>
            <div className="welcome-actions">
              <button className="button primary" onClick={() => setNewExperiment(true)}>
                <Plus size={18} />
                新建第一个实验
              </button>
              <button
                className="button"
                disabled={busy > 0}
                onClick={() => {
                  void execute({ type: 'demo' }).catch(() => {});
                }}
              >
                <FilePlus2 size={17} />
                载入演示实验
              </button>
            </div>
            <div className="welcome-steps">
              <div>
                <span>01</span>
                <strong>实验规划</strong>
                <p>样品状态、制备、数量与参数</p>
              </div>
              <ArrowRight size={18} />
              <div>
                <span>02</span>
                <strong>现场记录</strong>
                <p>开始、结束、备注与问题</p>
              </div>
              <ArrowRight size={18} />
              <div>
                <span>03</span>
                <strong>回看导出</strong>
                <p>操作历史、表格与完整备份</p>
              </div>
            </div>
          </div>
        ) : (
          <div key={experimentId}>
            {page === 'plan' ? <Plan /> : page === 'live' ? <Live /> : <Review />}
          </div>
        )}
      </main>
      {alert && (
        <div
          className={`toast ${alert.error ? 'error' : ''}`}
          role={alert.error ? 'alert' : 'status'}
        >
          {alert.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{alert.message}</span>
          <button className="toast-dismiss" aria-label="关闭提示" onClick={workspace.dismissAlert}>
            <X size={16} />
          </button>
        </div>
      )}
      {newExperiment && <NewExperiment onClose={() => setNewExperiment(false)} />}{' '}
      {settings && (
        <SettingsDialog
          dataFirst={cloudFirst}
          onClose={() => {
            setSettings(false);
            setCloudFirst(false);
          }}
        />
      )}
      {overview && experiment && (
        <ExperimentOverview experiment={experiment} onClose={() => setOverview(false)} />
      )}
    </div>
  );
}
