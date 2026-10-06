import { useEffect, useState } from 'react';
import type { CloudReport, CloudStatus, ReportJob } from '../shared/model';
import { unwrap, useWorkspace } from './context';

const stateText = {
  pending: '等待上传',
  uploading: '正在上传',
  uploaded: '已归档',
  failed: '上传失败',
};
export function ReportCloud({
  status,
  onStatus,
}: {
  status: CloudStatus | null;
  onStatus: (status: CloudStatus) => void;
}) {
  const { notify } = useWorkspace();
  const [jobs, setJobs] = useState<ReportJob[]>([]),
    [reports, setReports] = useState<CloudReport[] | null>(null);
  const [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void unwrap(window.labrecord.reportJobs())
        .then((value) => {
          if (active) setJobs(value);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function action(task: () => Promise<unknown>) {
    setWorking(true);
    setError('');
    try {
      await task();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const visible = [
    ...jobs.filter((j) => j.state !== 'uploaded'),
    ...jobs
      .filter((j) => j.state === 'uploaded')
      .slice(-3)
      .reverse(),
  ];
  return (
    <section className="report-cloud form-stack" aria-label="私人报告归档">
      <h3>私人报告归档</h3>
      <p className="hint">
        报告先保存到本机，再后台归档 PDF、HTML、JSON 和图片。上传期间可继续现场记录。HTML
        下载后离线打开。
      </p>
      {status?.connected && (
        <>
          <label className="archive-toggle">
            <span>生成报告后保存到私人库</span>
            <input
              type="checkbox"
              checked={status.reportArchiveEnabled}
              disabled={working}
              onChange={(e) => {
                const enabled = e.target.checked;
                const previous = status;
                onStatus({ ...status, reportArchiveEnabled: enabled });
                void action(async () => {
                  try {
                    const saved = await unwrap(window.labrecord.setReportArchiveEnabled(enabled));
                    onStatus({ ...saved, lastSyncedAt: previous.lastSyncedAt });
                  } catch (error) {
                    onStatus(previous);
                    throw error;
                  }
                });
              }}
            />
          </label>
          <div className="backup-actions">
            <button
              className="button"
              disabled={working}
              onClick={() =>
                void action(async () => {
                  await unwrap(window.labrecord.retryReportArchives());
                  setJobs(await unwrap(window.labrecord.reportJobs()));
                  notify('已尝试待上传任务，可继续记录。');
                })
              }
            >
              重试报告上传
            </button>
            <button
              className="button"
              disabled={working}
              onClick={() =>
                void action(async () => setReports(await unwrap(window.labrecord.cloudReports())))
              }
            >
              刷新云端报告
            </button>
            <button
              className="text-button"
              disabled={working}
              onClick={() =>
                void action(async () => {
                  await unwrap(window.labrecord.openCloudReports());
                })
              }
            >
              查看云端报告
            </button>
          </div>
        </>
      )}
      {visible.length > 0 && (
        <div className="report-job-list" role="status">
          {visible.map((job) => (
            <div className="report-job" key={job.id}>
              <strong>
                {job.code} · {job.experimentName}
              </strong>
              <span className={job.state === 'failed' ? 'error-text' : 'hint'}>
                本机已保存 · {stateText[job.state]}
              </span>
              {job.repository.toLowerCase() !== status?.repository.toLowerCase() && (
                <small className="hint">归档目标：{job.repository}，重新连接该库后可重试。</small>
              )}
              {job.error && <small className="error-text">{job.error}</small>}
            </div>
          ))}
        </div>
      )}
      {reports && (
        <div className="report-job-list">
          {reports.length ? (
            reports.map((report) => (
              <div className="report-job" key={report.id}>
                <strong>
                  {report.code} · {report.experimentName}
                </strong>
                <small className="hint">
                  {new Date(report.generatedAt).toLocaleString('zh-CN')}
                </small>
                <button
                  className="button small"
                  disabled={working}
                  onClick={() =>
                    void action(async () => {
                      const path = await unwrap(window.labrecord.downloadCloudReport(report.id));
                      if (path) notify('报告已下载：' + path);
                    })
                  }
                >
                  下载完整报告
                </button>
              </div>
            ))
          ) : (
            <p className="hint">云端暂无报告。生成报告后会出现在这里。</p>
          )}
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <small className="hint">
        每次导出保存为独立版本；关闭自动归档会保留待上传任务。单份云端报告上限 2
        GiB，大文件分段并在下载时校验重组。
      </small>
    </section>
  );
}
