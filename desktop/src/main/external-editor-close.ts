import type { MessageBoxSyncOptions } from 'electron';
import type { ExternalEditorService } from './external-editor';

export async function confirmExternalEditorExit(
  service: Pick<ExternalEditorService, 'pendingForExit'>,
  prompt: (options: MessageBoxSyncOptions) => number,
  showFiles: () => void,
): Promise<boolean> {
  const { edits, opening } = await service.pendingForExit();
  if (!edits.length && !opening) return true;
  const files = edits.map(edit => `${edit.connectionName} · ${edit.path}\n${edit.message}`).join('\n\n');
  const response = prompt({
    type: 'question', title: '外部文件尚未完成回传',
    message: edits.length ? `有 ${edits.length} 个外部文件需要处理。` : '外部文件正在打开。',
    detail: [files, opening ? `另有 ${opening} 个文件正在打开。` : '', '退出后停止自动回传，本地草稿保留。外部编辑器中未保存的内容仍由该编辑器管理。'].filter(Boolean).join('\n\n'),
    buttons: ['查看文件', '取消', '退出并保留草稿'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response === 0) showFiles();
  return response === 2;
}
