import { readFile, writeFile, mkdir, copyFile, stat, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const refreshScreenshots = !process.argv.includes('--preserve-screenshots');
const release = join(root, 'release');
const filename = `LabRecord-${packageInfo.version}-Windows-x64.zip`;
const zipBytes = await readFile(join(release, filename));
const zip = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const required = [
  'LabRecord.exe',
  'resources/app.asar',
  '使用说明.html',
  '示例表格/旧格式演示.tsv',
  '示例表格/演示规划.tsv',
  'LabRecord-LICENSE.txt',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'icudtl.dat',
  'resources.pak',
];
const files = [];
for (const name of required) {
  const entry = zip.file(name);
  if (!entry) throw new Error(`交付文件缺失：${name}`);
  const archived = await entry.async('nodebuffer');
  const unpacked = await readFile(join(release, 'win-unpacked', name));
  const hash = sha256(archived);
  if (sha256(unpacked) !== hash) throw new Error(`软件包与已验收程序不一致：${name}`);
  files.push({ path: name, bytes: archived.length, sha256: hash });
}
const testOutput = join(
  root,
  'test-results/desktop-Windows-desktop-pl-d8707-complete-backup-and-restore',
);
const runtime = JSON.parse(await readFile(join(testOutput, 'runtime.json'), 'utf8'));
const desktopReport = JSON.parse(
  await readFile(join(root, 'test-results/desktop-report.json'), 'utf8'),
);
if (
  !desktopReport.stats.expected ||
  desktopReport.stats.unexpected ||
  desktopReport.stats.skipped ||
  desktopReport.stats.flaky ||
  desktopReport.errors.length
)
  throw new Error('打包程序的完整桌面检查没有全部通过。');
if (!runtime.packaged || runtime.version !== packageInfo.version || runtime.platform !== 'win32')
  throw new Error('缺少本版本 Windows 打包程序的运行证据。');
if (resolve(runtime.appPath) !== resolve(join(release, 'win-unpacked/resources/app.asar')))
  throw new Error('验收程序的路径与交付目录不一致。');
const images = join(root, 'docs/images');
await mkdir(images, { recursive: true });
for (const name of ['planning', 'live', 'review'])
  if (refreshScreenshots)
    await copyFile(join(testOutput, `${name}.png`), join(images, `${name}.png`));
const upgradeOutput = join(
  root,
  'test-results/desktop-quick-entry-and-di-eb07b-act-plan-and-cloud-controls',
);
for (const name of ['quick-add', 'planning-small'])
  if (refreshScreenshots)
    await copyFile(join(upgradeOutput, `${name}.png`), join(images, `${name}.png`));
const exampleReport = join(upgradeOutput, 'example-report');
const reportManifest = JSON.parse(await readFile(join(exampleReport, 'manifest.json'), 'utf8'));
for (const file of reportManifest.files) {
  const bytes = await readFile(join(exampleReport, file.path));
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
    throw new Error('演示报告校验失败：' + file.path);
}
const demoDirectory = `演示实验报告-${packageInfo.version}`;
await cp(exampleReport, join(release, demoDirectory), { recursive: true });
const archiveOutput = (await readdir(join(root, 'test-results'))).find((name) =>
  name.startsWith('desktop-report-archive'),
);
if (!archiveOutput) throw new Error('缺少报告归档界面检查。');
if (refreshScreenshots)
  await copyFile(
    join(root, 'test-results', archiveOutput, 'report-cloud.png'),
    join(images, 'report-cloud.png'),
  );
if (zip.file('示例表格/旧表参考.tsv')) throw new Error('原始个人样品表不能进入公开软件包。');
const manifest = {
  format: 'LabRecordDelivery',
  formatVersion: 1,
  checkedAt: new Date().toISOString(),
  archive: {
    filename,
    bytes: (await stat(join(release, filename))).size,
    sha256: sha256(zipBytes),
  },
  archiveCrcChecked: true,
  archiveFileCount: Object.values(zip.files).filter((entry) => !entry.dir).length,
  verifiedAgainstTestedDirectory: files,
  runtime: { ...runtime, appPath: 'resources/app.asar' },
  desktopChecks: desktopReport.stats,
  exampleReport: { path: demoDirectory, manifest: reportManifest },
};
await writeFile(join(release, 'delivery-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(join(release, 'SHA256SUMS.txt'), `${manifest.archive.sha256}  ${filename}\n`);
console.log(
  JSON.stringify(
    {
      archive: manifest.archive,
      archiveFileCount: manifest.archiveFileCount,
      matchedFiles: files.length,
      screenshots: refreshScreenshots
        ? ['planning', 'live', 'review', 'quick-add', 'planning-small', 'report-cloud']
        : [],
      runtime,
    },
    null,
    2,
  ),
);
