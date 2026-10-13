import { Modal } from './components';

const rows = [
  [
    'Ctrl + 1 / 2 / 3',
    '切换实验规划、现场记录、回看导出',
    '没有实验、对话框开着、按了 Alt 或 Shift 时无效',
  ],
  ['Ctrl + K', '全库搜索样品或实验', '正在输入、对话框开着或正在保存时无效'],
  ['Ctrl + /', '打开这个快捷键表', '正在输入、对话框开着或正在保存时无效'],
  [
    'F8',
    '开始当前操作，或完成并切到下一项',
    '输入框、输入法、对话框、修饰键、重复按键、正在保存时无效',
  ],
  ['Alt + N', '在规划页新增样品', '不在规划页，或对话框开着时无效'],
  ['Alt + ↑ / ↓', '调整当前聚焦的队列顺序', '只在待测队列的序号或样品按钮上；输入框里无效'],
  ['Ctrl + Enter', '连续添加样品，或提交现场记录', '不在对应的输入里时无效'],
  ['Esc', '关闭对话框或菜单', '正在保存、暂时不能关闭时无效'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="快捷键" onClose={onClose}>
      <table className="shortcut-table">
        <tbody>
          {rows.map(([key, action, limit]) => (
            <tr key={key}>
              <th scope="row">{key}</th>
              <td>
                {action}
                <small>{limit}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
