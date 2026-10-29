import { reportInsights } from '../shared/summary.js';
import { readFile, writeFile, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot, Group, Run } from '../shared/model.js';
import { sampleName, STATUS_LABEL, groupCounts, effectiveProtocol } from '../shared/model.js';
import { exportFile, groupDurationExport, groupOverrideExport } from './tables.js';
import { measurementFor, plannedGroup, measurementSummary } from '../shared/measurement.js';
import { MATERIAL_FIELDS, materialSummary } from '../shared/materials.js';
import { actualFieldSource, actualSpecimenName, actualSpecimenNameField, actualProtocolLabel, operationPlanDrift, planChangeLabel, startedPlanChanges, recordedPlanSearchText, plannedCustomFieldValue } from '../shared/planChanges.js';
import { formatRecordedDuration, recordedDuration, runDurationLabel } from '../shared/duration.js';
import { recordedClock } from '../shared/recordedTime.js';
import { followUpRoster, followUpSets } from '../shared/followUps.js';
import { eventDetailData, eventEarlierText, eventTimeLabel, issueEarlierText, operationStatusReason } from '../shared/history.js';
import { repeatSourceLabel } from '../shared/repeats.js';
import { latestEndedMark, latestEndedSummary, runningOperationSummary } from '../shared/library.js';
import { fieldSheetNoteText, fieldSheetRows } from '../shared/fieldSheet.js';

export const hashBytes = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
export function directoryContains(parent: string, child: string) {
  const root = resolve(parent);
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolve(child).startsWith(prefix);
}
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const shown = (value: unknown) =>
  value === null || value === undefined || value === '' ? '未记录' : String(value);
const recordedLabel = (time: string | null | undefined, offsetMinutes: number, timezone: string) => {
  const clock = recordedClock(time, offsetMinutes, timezone);
  return clock ? `${clock.clock} ${clock.zone}` : null;
};
const eventStamp = (snapshot: Snapshot, event: Snapshot['events'][number]) => {
  const local = eventTimeLabel(snapshot, event);
  return local ? `${local} · UTC ${event.createdAt}` : event.createdAt;
};
const table = (rows: [string, unknown][]) =>
  `<table class="details">${rows.map(([key, value]) => `<tr><th>${escape(key)}</th><td>${escape(shown(value))}</td></tr>`).join('')}</table>`;
const dimension = (value: unknown, unit: unknown) =>
  value === '' || value === undefined || value === null
    ? '未记录'
    : `${value} ${unit || '（单位未定）'}`;
function planning(group: Group): [string, unknown][] {
  return [
    ['样品名称', group.name],
    ['材料短名', group.material],
    ...MATERIAL_FIELDS.map(({ key, label }): [string, unknown] => [label, group[key]]),
    ['样品状态（原文）', group.state],
    ['厚度', dimension(group.thickness, group.thicknessUnit)],
    ['宽度', dimension(group.width, group.dimensionUnit)],
    ['高度（可选）', dimension(group.height, group.dimensionUnit)],
    ['实验方式', group.mode],
    ['实验制度', group.protocol ?? ''],
    ['优先级', group.priority],
    ['制备 / 试剂名称', group.preparation],
    ['计划备注', group.notes],
  ];
}
function actualDisplay(value: unknown, source: string) {
  if (value !== undefined && value !== null && value !== '') return value;
  if (source === '旧版空值（含义不明）') return source;
  if (source === '用户更正（已清空）') return '已清空';
  if (source === '用户更正（明确空值）') return '明确空值';
  if (source === '开始时按计划初始化') return '计划未填写';
  return '未记录';
}
function actualDimension(value: unknown, unit: unknown, source: string) {
  if (value === undefined || value === null || value === '') return actualDisplay(value, source);
  return dimension(value, unit);
}
function actualSpecimenRows(run: Run): [string, unknown][] {
  return [
    ['实际样品名称', actualDisplay(actualSpecimenName(run), actualFieldSource(run, actualSpecimenNameField(run)))],
    ['实际样品名称来源', actualFieldSource(run, actualSpecimenNameField(run))],
    ['实际样品状态', actualDisplay(run.actualSample?.state, actualFieldSource(run, 'actualSample.state'))],
    ['实际样品状态来源', actualFieldSource(run, 'actualSample.state')],
    ['实际厚度', actualDimension(run.actual.thickness, run.actual.thicknessUnit, actualFieldSource(run, 'actual.thickness'))],
    ['实际厚度来源', actualFieldSource(run, 'actual.thickness')],
    ['实际厚度单位来源', actualFieldSource(run, 'actual.thicknessUnit')],
    ['实际宽度', actualDimension(run.actualSample?.width, run.actualSample?.dimensionUnit, actualFieldSource(run, 'actualSample.width'))],
    ['实际宽度来源', actualFieldSource(run, 'actualSample.width')],
    ['实际高度', actualDimension(run.actualSample?.height, run.actualSample?.dimensionUnit, actualFieldSource(run, 'actualSample.height'))],
    ['实际高度来源', actualFieldSource(run, 'actualSample.height')],
    ['实际宽高单位来源', actualFieldSource(run, 'actualSample.dimensionUnit')],
  ];
}
function actualRows(run: Run): [string, unknown][] {
  return [
    ...actualSpecimenRows(run),
    ['实际实验方式', run.actual.mode],
    ['开始时实验制度', run.snapshot.group.protocol ?? ''],
    ['实际实验制度', run.actual.protocol],
    ['实际制备 / 试剂名称', run.actual.preparation],
    ['数据文件夹', run.filename],
    ['实际文件名', run.actual.filename],
    ['扫描编号', run.actual.scanId],
    ['仪器数据文件引用', run.actual.files],
    ['开始时间（记录时区）', recordedLabel(run.startedAt, run.offsetMinutes, run.timezone)],
    ['结束时间（记录时区）', recordedLabel(run.endedAt, run.offsetMinutes, run.timezone)],
    ['开始时间 UTC', run.startedAt],
    ['结束时间 UTC', run.endedAt],
    [
      '起止间隔（秒）',
      run.startedAt && run.endedAt && Date.parse(run.endedAt) >= Date.parse(run.startedAt)
        ? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000
        : null,
    ],
    ['用时', runDurationLabel(run)],
    ['记录时区', run.timezone],
    ['记录时 UTC 偏移（分钟）', run.offsetMinutes],
    ['原始开始（记录时区）', recordedLabel(run.originalStartedAt, run.offsetMinutes, run.timezone)],
    ['原始结束（记录时区）', recordedLabel(run.originalEndedAt, run.offsetMinutes, run.timezone)],
    ['原始点击开始时间 UTC', run.originalStartedAt],
    ['原始点击结束时间 UTC', run.originalEndedAt],
  ];
}
export async function renderReport(
  snapshot: Snapshot,
  experimentId: string,
  root: string,
  generatedAt = new Date().toISOString(),
) {
  const experiment = snapshot.experiments.find((e) => e.id === experimentId);
  if (!experiment) throw new Error('实验不存在。');
  const insights = reportInsights(snapshot, experimentId);
  const selected = snapshot.items
    .filter((i) => i.experimentId === experimentId)
    .sort((a, b) => a.order - b.order);
  const fieldRows = new Map(fieldSheetRows(snapshot, experimentId).map((row) => [row.itemId, row]));
  const attachments = snapshot.attachments.filter((a) => a.experimentId === experimentId);
  const pictures = new Map<string, { html: string; path: string }>();
  for (const attachment of attachments) {
    if (!/^attachments\/[a-f0-9-]+\.(png|jpe?g|webp|gif)$/.test(attachment.relativePath))
      throw new Error('图片路径无效。');
    const file = resolve(root, attachment.relativePath);
    if (!file.startsWith(resolve(root) + sep)) throw new Error('图片路径超出实验数据目录。');
    const bytes = await readFile(file);
    if (bytes.length !== attachment.size || hashBytes(bytes) !== attachment.sha256)
      throw new Error(`图片校验失败：${attachment.name}`);
    pictures.set(attachment.id, {
      path: `images/${attachment.id}${extname(attachment.relativePath)}`,
      html: `<figure><img alt="${escape(attachment.name)}" src="data:${escape(attachment.mime)};base64,${bytes.toString('base64')}"/><figcaption>${escape(attachment.name)} · ${escape(attachment.sha256)}</figcaption></figure>`,
    });
  }
  const events = snapshot.events.filter((e) => e.experimentId === experimentId);
  const issues = events.filter((e) => e.type === 'issue');
  const recorded = recordedDuration(snapshot.runs.filter((run) => run.experimentId === experimentId));
  const roster = followUpRoster(snapshot, experimentId);
  const unlinkedIssues = followUpSets(snapshot, experimentId).unlinkedIssues;
  const rosterItems = roster.length
    ? `<ul>${roster.map((entry) => `<li>${escape(entry.sampleCode)} · ${escape(entry.gaps.join('、'))}</li>`).join('')}</ul>`
    : '<p>没有挂在具体操作上的待核对项。</p>';
  const rosterHtml = `<section class="follow-up-roster"><h2>待核对清单</h2><p>只列出已有实际记录的时间或缺文件，以及挂到操作上的未处理问题。尚未开始的计划不因为还没记录而列入。</p>${rosterItems}<p>未关联到操作的问题：${unlinkedIssues} 条。</p></section>`;
  const rosterMarkdown = `## 待核对清单\n\n只列出已有实际记录的时间或缺文件，以及挂到操作上的未处理问题。尚未开始的计划不因为还没记录而列入。\n\n${
    roster.length
      ? roster.map((entry) => `- ${entry.sampleCode} · ${entry.gaps.join('、')}`).join('\n')
      : '没有挂在具体操作上的待核对项。'
  }\n\n未关联到操作的问题：${unlinkedIssues} 条。\n\n`;
  const checks = [
    `${insights.pending} 项待测，${insights.running} 项进行中，${insights.skipped} 项跳过，${insights.interrupted} 项中断。`,
    `${insights.unresolvedIssues} 条问题待处理；${insights.missingTimes} 次操作的起止时间不完整。`,
    `${insights.missingFiles} 次操作尚未补充实际文件名、扫描编号或文件引用。`,
    [
      recorded.completeCount
        ? `${formatRecordedDuration(recorded.milliseconds)}已记录用时（${recorded.completeCount} 次完整起止）`
        : '',
      recorded.incompleteCount ? `${recorded.incompleteCount} 次起止不完整，未计入` : '',
    ]
      .filter(Boolean)
      .join('；'),
    `${insights.groupsWithoutWidth} 个样品组尚未填写宽度；高度为可选信息。`,
    ...(latestEndedSummary(snapshot, experimentId)
      ? [`最近结束：${latestEndedSummary(snapshot, experimentId)}`]
      : []),
    ...(runningOperationSummary(snapshot, experimentId)
      ? [runningOperationSummary(snapshot, experimentId)]
      : []),
  ].filter((line) => line);
  const operations = selected
    .map((item) => {
      const run = snapshot.runs.find((r) => r.itemId === item.id);
      const sample = run?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId)!;
      const stored = snapshot.groups.find((g) => g.id === sample.groupId);
      const group = run?.snapshot.group || plannedGroup(stored!, sample, item);
      const fields = run?.snapshot.fields || experiment.fields;
      const fieldRow = fieldRows.get(item.id);
      const noteText = fieldRow ? fieldSheetNoteText(fieldRow) : '';
      const noteHtml = `<p class="measurement-note"><strong>测量备注：</strong>${escape(noteText || '未填写')}</p>`;
      const planRows: [string, unknown][] = [
        ...planning(group),
        ['测量配置', measurementSummary(measurementFor(snapshot, item))],
        ['数据文件夹', run?.filename || item.plannedName],
      ];
      const valueRows: [string, unknown][] = fields.map((field) => [
        `${field.label}${field.unit ? ` / ${field.unit}` : ''}（计划 → 实际）`,
        `${shown(plannedCustomFieldValue(sample.values, group.values, field.id))} → ${shown(run?.actual[field.id])}`,
      ]);
      const history = events.filter((e) => e.itemId === item.id || (run && e.runId === run.id));
      const changes = run ? startedPlanChanges(run) : [];
      const drift = operationPlanDrift(snapshot, item);
      const protocolLabel = actualProtocolLabel(run);
      const recordedPlanText = recordedPlanSearchText(run);
      const reason = operationStatusReason(snapshot, item);
      const endedMark = latestEndedMark(snapshot, item.id);
      const changeHtml = changes.length
        ? `<h3>与开始时计划不同</h3>${table(changes.map((change) => [planChangeLabel(change), `${change.planned} → ${change.actual}`]))}`
        : '';
      return `<section class="operation"><h2>${escape(sample.code)} · ${escape(sampleName(group))}<span>${escape(STATUS_LABEL[item.status])}${endedMark ? ` · ${escape(endedMark)}` : ''}${reason ? ` · 原因：${escape(reason)}` : ''}${item.repeatOf ? ' · 重测' : ''}</span></h2><p class="identity">sample_id: ${escape(sample.id)} · plan_item_id: ${escape(item.id)}${run ? ` · run_id: ${escape(run.id)}` : ''}${item.repeatOf ? ` · 原操作: ${escape(item.repeatOf)}${repeatSourceLabel(snapshot, item) ? ` · 重测来源: ${escape(repeatSourceLabel(snapshot, item))}` : ''}` : ''}</p>${drift ? `<p>当前计划已不同：${escape(drift)}</p>` : ''}${protocolLabel ? `<p>${escape(protocolLabel)}</p>` : ''}${recordedPlanText ? `<p>${escape(recordedPlanText)}</p>` : ''}${noteHtml}<div class="columns"><div><h3>${run ? '开始时的计划' : '当前计划'}</h3>${table(planRows)}</div><div><h3>实际操作记录</h3>${run ? table(actualRows(run)) : '<p>尚无实际操作记录；没有生成起止时间。</p>'}</div></div>${valueRows.length ? `<h3>自定义参数</h3>${table(valueRows)}` : ''}${changeHtml}${history.length ? `<details open><summary>问题与修改历史 · ${history.length} 条</summary><ol class="timeline">${history.map((e) => `<li><time>${escape(eventStamp(snapshot, e))}</time><strong>${escape(e.type)}</strong><p>${escape(e.text)}</p>${eventEarlierText(e) ? `<p>${escape(eventEarlierText(e))}</p>` : ''}${Object.keys(eventDetailData(e)).length ? `<pre>${escape(JSON.stringify(eventDetailData(e), null, 2))}</pre>` : ''}</li>`).join('')}</ol></details>` : ''}${attachments
        .filter((a) => a.runId === run?.id)
        .map((a) => pictures.get(a.id)!.html)
        .join('')}</section>`;
    })
    .join('');
  const groupRows = snapshot.groups
    .filter((g) => g.experimentId === experimentId)
    .map((g) => {
      const c = groupCounts(snapshot, g);
      const [recorded, incomplete] = groupDurationExport(snapshot, g.id);
      const durationUnknown = recorded === '' && incomplete === '';
      const overrides = groupOverrideExport(snapshot, g);
      return `<tr><td>${escape(sampleName(g))}<small>${escape(g.state)}</small><small>${escape(materialSummary(g))}</small>${overrides ? `<small>${overrides.split('\n').map((line) => escape(line)).join('<br>')}</small>` : ''}</td><td>${escape(shown(g.preparedCount))}</td><td>${c.planned}</td><td>${escape(shown(c.spare))}</td><td>${escape(durationUnknown ? shown(recorded) : recorded)}</td><td>${escape(durationUnknown ? shown(incomplete) : incomplete)}</td><td>${escape(dimension(g.thickness, g.thicknessUnit))}</td><td>${escape(dimension(g.width, g.dimensionUnit))}</td><td>${escape(dimension(g.height, g.dimensionUnit))}</td><td>${escape(shown(g.protocol))}</td></tr>`;
    })
    .join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escape(experiment.name)} · 实验报告</title><style>
  :root{color-scheme:light}*{box-sizing:border-box}body{font-family:'Microsoft YaHei','Segoe UI',sans-serif;color:#263b35;line-height:1.65;max-width:1080px;margin:auto;padding:40px;background:#fff}h1{font-size:30px;margin:6px 0}h2{font-size:20px;border-bottom:1px solid #dce8df;padding-bottom:10px}h2 span{float:right;font-size:13px;color:#207269}h3{font-size:14px;color:#207269;margin:16px 0 8px}.eyebrow{color:#207269;letter-spacing:.12em;font-size:12px}.meta,.identity,small{color:#72827b;font-size:11px;overflow-wrap:anywhere}.summary{display:flex;gap:12px;margin:24px 0;flex-wrap:wrap}.summary div{flex:1;min-width:120px;background:#f3f8f4;padding:16px;border-radius:10px}.summary b{display:block;font-size:26px}.check{padding:16px;background:#f9f7ee;border-radius:10px}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:12px;margin:12px 0}td,th{border-bottom:1px solid #e2eae4;padding:8px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{font-weight:600;background:#f5f8f5}.details th{width:38%}.details td{white-space:pre-wrap}.columns{display:grid;grid-template-columns:1fr 1fr;gap:22px}td small{display:block}section.operation{margin:28px 0;border-top:2px solid #2a7467;padding-top:12px}p,pre{overflow-wrap:anywhere}.measurement-note{white-space:pre-wrap}pre{white-space:pre-wrap;font-size:10px;background:#f7f9f7;padding:8px}figure{margin:14px 0;break-inside:avoid}figure img{max-width:100%;max-height:360px}figcaption{font-size:10px;color:#6f8178;overflow-wrap:anywhere}.timeline{padding-left:20px}.timeline li{margin:10px 0}.timeline time{font-size:11px;margin-right:12px}footer{border-top:1px solid #ddd;margin-top:32px;font-size:11px;color:#72827b}@page{size:A4;margin:15mm}@media print{body{max-width:none;padding:0;font-size:11px}h2,h3,summary{break-after:avoid}tr{break-inside:avoid}.columns{gap:12px}.operation{break-before:auto}}@media(max-width:700px){body{padding:20px}.columns{grid-template-columns:1fr}}
  </style></head><body><header><div class="eyebrow">LABRECORD · 实验报告 · 格式版本 1</div><h1>${escape(experiment.name)}</h1><p>${escape(experiment.description)}</p><p class="meta">实验编号 ${escape(experiment.code)} · 实验 ID ${escape(experiment.id)} · 导出时间 UTC ${escape(generatedAt)}</p></header><div class="summary"><div><b>${insights.completed} / ${insights.plannedOperations}</b>已完成 / 计划操作</div><div><b>${insights.plannedSamples}</b>不同待测样品 · 重测 ${insights.repeats} 次</div><div><b>${insights.spareKnown}</b>已知备样${insights.unknownPreparation ? ` · ${insights.unknownPreparation} 组数量未定` : ''}</div><div><b>${insights.unresolvedIssues}</b>待处理问题</div></div><section class="check"><h3>后续核对</h3><ul>${checks.map((c) => `<li>${escape(c)}</li>`).join('')}</ul></section>${rosterHtml}<h2>样品准备与尺寸</h2><table><thead><tr><th>名称 / 状态</th><th>准备</th><th>计划样品</th><th>备样</th><th>已记录用时</th><th>未计入次数</th><th>厚度</th><th>宽度</th><th>高度（可选）</th><th>实验制度</th></tr></thead><tbody>${groupRows}</tbody></table><h2>问题汇总</h2>${issues.length ? `<ul>${issues.map((e) => `<li>${escape(eventStamp(snapshot, e))} · ${escape(e.text)}${issueEarlierText(e) ? ` · ${escape(issueEarlierText(e))}` : ''} · ${e.data.resolvedAt ? `已处理 ${escape(e.data.resolvedAt)}` : '待处理'}</li>`).join('')}</ul>` : '<p>尚无问题记录。</p>'}${operations}<h2>实验整体历史</h2>${events
    .filter((e) => !e.itemId && !e.runId)
    .map((e) => `<p>${escape(eventStamp(snapshot, e))} · ${escape(e.type)} · ${escape(e.text)}</p>`)
    .join(
      '',
    )}<footer>由已保存记录生成。未知值保留为未记录，旧版空值的来源无法确定；旧表完成标记不作为实际操作。实际字段分别标明旧版记录、按计划初始化或用户更正，按计划初始化不是独立测量。操作时间用于大致对应数据，精确时间以仪器数据为准。完整结构化记录见 records.json，图片及 SHA-256 见 manifest.json。</footer></body></html>`;
  const groupDurationMarkdown = `## 样品组已记录用时\n\n${snapshot.groups
    .filter((group) => group.experimentId === experimentId)
    .map((group) => {
      const [recorded, incomplete] = groupDurationExport(snapshot, group.id);
      const overrides = groupOverrideExport(snapshot, group).replaceAll('\n', '、');
      const parts = [
        recorded ? `已记录 ${recorded}` : '',
        incomplete !== '' ? `未计入 ${incomplete} 次` : '',
        overrides ? `样品差异：${overrides}` : '',
      ].filter(Boolean);
      return `- ${sampleName(group)}（${group.state}）：${parts.join('；') || '尚无实际记录'}`;
    })
    .join('\n')}\n\n`;
  const markdown = `# ${experiment.name.replaceAll('\n', ' ')} · 实验记录\n\n实验编号：${experiment.code}\n实验 ID：${experiment.id}\n导出时间 UTC：${generatedAt}\n报告格式版本：1\n\n## 文件与读取方法\n\n- report.html：独立可阅读报告，图片已嵌入，可离线打开。\n- report.pdf：用于阅读和分享。\n- records.json：LabRecord 格式版本 ${snapshot.schemaVersion}，包含本实验的全部实体、稳定 ID、参数、单位、空值、起止时间、原始值和修改历史；分析时以此明细复核。\n- images/：现场图片原文件，按附件 ID 关联。\n- manifest.json：文件清单、SHA-256 及计数。\n\n## 完成情况与待核对信息\n\n${checks.map((c) => `- ${c}`).join('\n')}\n\n已完成 ${insights.completed} / ${insights.plannedOperations} 项，${insights.plannedSamples} 个不同计划样品，重测 ${insights.repeats} 次。\n\n${rosterMarkdown}${groupDurationMarkdown}## 数据含义\n\n准备数量包含备样，计划操作数包含重测。未记录字段不补造；旧版空值含义不明，现场清空与按计划初始化分别标明来源。原表完成标记属于历史信息。没有开始或结束的记录不能推断其时间。开始时的计划来自 run.snapshot，其中的实验制度是开始时写下的原文；样品组后来修改的制度只出现在当前样品组，不改写该次快照。实际样品名称与宽高来自 run.actualSample，实际厚度、实际实验制度及文件关联来自 run.actual；初始实际参数沿用计划，不是独立测量结果。时间修正和问题保存在 events。仪器数据文件只记录原路径引用，未复制进此报告。实验是否有效需由仪器数据与实际条件判断。\n\n## 全部操作\n\n${selected
    .map((item) => {
      const run = snapshot.runs.find((r) => r.itemId === item.id);
      const sample = run?.snapshot.sample || snapshot.samples.find((s) => s.id === item.sampleId)!;
      const stored = snapshot.groups.find((g) => g.id === sample.groupId);
      const group = run?.snapshot.group || plannedGroup(stored!, sample, item);
      const startLocal = run
        ? recordedLabel(run.startedAt, run.offsetMinutes, run.timezone)
        : null;
      const endLocal = run ? recordedLabel(run.endedAt, run.offsetMinutes, run.timezone) : null;
      const reason = operationStatusReason(snapshot, item);
      const endedMark = latestEndedMark(snapshot, item.id);
      const protocolLabel = actualProtocolLabel(run);
      const recordedPlanText = recordedPlanSearchText(run);
      const fieldRow = fieldRows.get(item.id);
      const noteText = fieldRow ? fieldSheetNoteText(fieldRow) : '';
      return `### ${sample.code} · ${sampleName(group)}\n\n状态：${STATUS_LABEL[item.status]}${endedMark ? `；${endedMark}` : ''}${reason ? `；原因：${reason}` : ''}；样品 ID：${sample.id}；操作 ID：${item.id}${item.repeatOf ? `；原操作 ID：${item.repeatOf}${repeatSourceLabel(snapshot, item) ? `；重测来源：${repeatSourceLabel(snapshot, item)}` : ''}` : ''}\n\n测量配置：${measurementSummary(measurementFor(snapshot, item))}\n\n数据文件夹：${shown(run?.filename || item.plannedName)}\n\n测量备注：${shown(noteText)}\n\n开始（记录时区）：${shown(startLocal)}；结束（记录时区）：${shown(endLocal)}\n\n开始 UTC：${shown(run?.startedAt)}；结束 UTC：${shown(run?.endedAt)}；用时：${run ? runDurationLabel(run) : '尚未开始'}\n\n${operationPlanDrift(snapshot, item) ? `当前计划已不同：${operationPlanDrift(snapshot, item)}\n\n` : ''}${protocolLabel ? `${protocolLabel}\n\n` : ''}${recordedPlanText ? `${recordedPlanText}\n\n` : ''}${
        run
          ? `开始时样品状态：${shown(run.snapshot.group.state)}\n\n${actualSpecimenRows(run)
              .map(([label, value]) => `- ${label}：${shown(value)}`)
              .join('\n')}\n\n`
          : ''
      }${
        run && startedPlanChanges(run).length
          ? `与开始时计划不同：\n\n${startedPlanChanges(run)
              .map((change) => `- ${planChangeLabel(change)}：${change.planned} → ${change.actual}`)
              .join('\n')}\n\n`
          : ''
      }${attachments
        .filter((a) => a.runId === run?.id)
        .map((a) => `[图片：${a.name.replace(/[\[\]\n]/g, '_')}](${pictures.get(a.id)!.path})`)
        .join('\n')}\n`;
    })
    .join('\n')}\n`;
  return { html, markdown, insights, pictures, generatedAt };
}
export async function writeReportBundle(
  snapshot: Snapshot,
  experimentId: string,
  root: string,
  parent: string,
  pdf: (htmlPath: string) => Promise<Buffer>,
) {
  const experiment = snapshot.experiments.find((e) => e.id === experimentId);
  if (!experiment) throw new Error('实验不存在。');
  const safeCode =
    experiment.code.replace(/[<>:"/\\|?*\x00-\x1f. ]+/g, '_').slice(0, 80) || 'experiment';
  const id = randomUUID();
  const target = join(
    parent,
    `${safeCode}-实验报告-${new Date().toLocaleDateString('sv-SE')}-${id.slice(0, 8)}`,
  );
  const staging = join(parent, `LabRecord-report-${id}`);
  await mkdir(join(staging, 'images'), { recursive: true });
  try {
    const rendered = await renderReport(snapshot, experimentId, root);
    await writeFile(join(staging, 'report.html'), rendered.html);
    await writeFile(join(staging, 'README-agent.md'), rendered.markdown);
    await exportFile(snapshot, experimentId, 'json', join(staging, 'records.json'));
    const bytes = await pdf(join(staging, 'report.html'));
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF 生成失败。');
    await writeFile(join(staging, 'report.pdf'), bytes);
    const paths = ['report.html', 'report.pdf', 'records.json', 'README-agent.md'];
    for (const attachment of snapshot.attachments.filter((a) => a.experimentId === experimentId)) {
      const path = rendered.pictures.get(attachment.id)!.path;
      await copyFile(join(root, attachment.relativePath), join(staging, path));
      paths.push(path);
    }
    const files = [];
    for (const path of paths) {
      const content = await readFile(join(staging, path));
      const attachment = snapshot.attachments.find(
        (image) => rendered.pictures.get(image.id)?.path === path,
      );
      if (
        attachment &&
        (content.length !== attachment.size || hashBytes(content) !== attachment.sha256)
      )
        throw new Error(`图片在报告生成时发生变化，请重新导出：${attachment.name}`);
      files.push({ path, bytes: content.length, sha256: hashBytes(content) });
    }
    await writeFile(
      join(staging, 'manifest.json'),
      JSON.stringify(
        {
          format: 'LabRecordReport',
          formatVersion: 1,
          experimentId,
          generatedAt: rendered.generatedAt,
          insights: rendered.insights,
          files,
        },
        null,
        2,
      ),
    );
    await rename(staging, target);
    return target;
  } finally {
    if (
      !directoryContains(parent, staging) ||
      !staging.endsWith(`LabRecord-report-${id}`)
    )
      throw new Error('报告临时路径无效。');
    await rm(staging, { recursive: true, force: true });
  }
}
