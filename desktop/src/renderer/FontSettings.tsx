import {useEffect, useState} from 'react';
import type {AppSettings} from '../shared/types';
import {fontChoices, isBundledFont, terminalFontFamily, terminalFontLoads} from '../shared/fonts';
import {api} from './api';
import './fonts.css';

export default function FontSettings({settings, onChange}: {settings: AppSettings; onChange: (partial: Partial<AppSettings>) => void}) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [fontError, setFontError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api.fonts().then(fonts => {if (!cancelled) setInstalled(fonts);}).catch(() => {
      if (!cancelled) setFontError('暂时无法读取系统字体，仍可选择内置字体。');
    });
    return () => {cancelled = true;};
  }, []);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(terminalFontLoads(settings).map(font => document.fonts.load(font, 'M中文'))).catch(() => {
      if (!cancelled) setFontError('字体加载失败，请重新选择字体。');
    });
    return () => {cancelled = true;};
  }, [settings.fontFamily, settings.chineseFont, settings.fontSize, settings.fontWeight]);

  const selector = (language: 'english' | 'chinese', key: 'fontFamily' | 'chineseFont', label: string) => {
    const choices = fontChoices(installed, language, settings[key]);
    const recommended = choices.recommended.includes(choices.selected);
    return <div className="form-field font-family-field">
      <div className="font-label-row"><label htmlFor={language === 'english' ? 'font-en' : 'font-zh'}>{label}</label>{recommended && <span className="font-recommended-badge">★ 推荐</span>}</div>
      <select id={language === 'english' ? 'font-en' : 'font-zh'} value={choices.selected} onChange={event => onChange({[key]: event.target.value})}>
        {choices.recommended.length > 0 && <optgroup label="★ 推荐字体">{choices.recommended.map(font => <option className="font-recommended-option" key={font} value={font}>★ {font}{isBundledFont(font) ? ' · 内置' : ''}</option>)}</optgroup>}
        {choices.other.length > 0 && <optgroup label="其他可用字体">{choices.other.map(font => <option key={font} value={font}>{font}{isBundledFont(font) ? ' · 内置' : ''}</option>)}</optgroup>}
        {choices.missing && <optgroup label="当前字体（未检测到）"><option value={choices.missing}>{choices.missing}</option></optgroup>}
      </select>
      {choices.recommended.length > 0 && <div className="font-recommendations" aria-label={`${label}推荐`}>{choices.recommended.slice(0, 3).map(font => <button type="button" key={font} className={`font-recommendation${choices.selected === font ? ' selected' : ''}`} aria-pressed={choices.selected === font} onClick={() => onChange({[key]: font})}>{font}</button>)}</div>}
    </div>;
  };

  return <section className="font-settings-section">
    <h3>终端字体</h3>
    <p className="settings-description">推荐字体以 ★ 标记。下拉列表包含内置字体和本机已安装字体，可滚动选择。</p>
    <div className="form-grid">
      {selector('english', 'fontFamily', '英文字体')}
      {selector('chinese', 'chineseFont', '中文字体')}
      <div className="form-field"><label htmlFor="font-weight">字重</label><select id="font-weight" value={settings.fontWeight} onChange={event => onChange({fontWeight: Number(event.target.value) as 400 | 700})}><option value={400}>普通 · Regular</option><option value={700}>粗体 · Bold</option></select><span className="font-help">三套内置英文字体均提供原生粗体。</span></div>
      <div className="form-field"><label htmlFor="font-size">字号 · {settings.fontSize} px</label><input id="font-size" type="range" min={8} max={40} step={1} value={settings.fontSize} onChange={event => onChange({fontSize: Number(event.target.value)})} /></div>
      <div className="form-field full-width"><label htmlFor="line-height">行高 · {settings.lineHeight.toFixed(2)}</label><input id="line-height" type="range" min={1} max={1.8} step={.05} value={settings.lineHeight} onChange={event => onChange({lineHeight: Number(event.target.value)})} /></div>
    </div>
    <div className="font-preview" style={{fontFamily: terminalFontFamily(settings), fontSize: settings.fontSize, fontWeight: settings.fontWeight, lineHeight: settings.lineHeight}}><span className="accent">root@server</span><span className="preview-muted">:~$ </span>ls -lah<br />0123456789 AaBbCc 终端中文字体预览<br /><span className="preview-muted">drwxr-xr-x　文档 / Documents</span></div>
    {fontError && <p className="font-help" role="status">{fontError}</p>}
  </section>;
}
