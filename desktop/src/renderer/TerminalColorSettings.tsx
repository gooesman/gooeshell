import { Check } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { normalizeTerminalPalette, resolveTerminalPalette, terminalPalettes } from '../shared/terminal-palettes';
import './terminal-colors.css';

export default function TerminalColorSettings({ settings, onChange }: {
  settings: AppSettings;
  onChange: (settings: Partial<AppSettings>) => void;
}) {
  const selected = normalizeTerminalPalette(settings.terminalPalette);
  const current = resolveTerminalPalette(settings.theme, selected);
  const choices = [
    { id: 'follow-interface', name: '跟随界面', description: '界面黑色时用纯黑，白色时用白昼', colors: resolveTerminalPalette(settings.theme).colors },
    ...terminalPalettes,
  ];
  const colors = current.colors;

  return <section className="terminal-colors-section" aria-labelledby="terminal-colors-heading">
    <h3 id="terminal-colors-heading">终端配色</h3>
    <p className="settings-description">可以与界面主题分开选择。保存后应用到所有已打开的终端。</p>
    <div className="terminal-palette-picker" role="group" aria-label="终端配色">
      {choices.map(palette => <button type="button" key={palette.id}
        className={`terminal-palette-choice${selected === palette.id ? ' selected' : ''}`}
        aria-pressed={selected === palette.id} onClick={() => onChange({ terminalPalette: palette.id })}>
        <span className="terminal-palette-swatch" style={{ backgroundColor: palette.colors.background }} aria-hidden="true">
          <span className="terminal-palette-prompt" style={{ color: palette.colors.foreground }}>&gt;_</span>
          <span className="terminal-palette-dots">{['blue', 'green', 'cyan', 'red', 'yellow', 'magenta'].map(color => <i key={color} style={{ backgroundColor: palette.colors[color as keyof typeof palette.colors] }} />)}</span>
        </span>
        <span className="terminal-palette-label"><strong>{palette.name}</strong><span>{palette.description}</span></span>
        {selected === palette.id && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>
    <div className="terminal-colors-preview" aria-label="终端颜色示例" style={{ backgroundColor: colors.background, color: colors.foreground }}>
      <div className="terminal-colors-preview-prompt"><span style={{ color: colors.green }}>work@server</span><span>:~$ ls</span></div>
      <div className="terminal-colors-preview-files"><span>README.md</span><span style={{ color: colors.blue }}>documents/</span><span style={{ color: colors.green }}>deploy.sh</span><span style={{ color: colors.cyan }}>current → releases/</span></div>
      <div className="terminal-colors-preview-labels" aria-hidden="true"><span>普通文本</span><span style={{ color: colors.blue }}>蓝色</span><span style={{ color: colors.green }}>绿色</span><span style={{ color: colors.cyan }}>青色</span></div>
    </div>
    <p className="terminal-colors-note">上方是颜色示例。文件名是否带颜色由服务器上的命令决定；配色只调整它输出的 ANSI 颜色，不会自动识别文件类型，也不会改动服务器配置。程序指定的真彩色不受此配色影响。</p>
  </section>;
}
