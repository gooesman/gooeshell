import {useEffect, useState} from 'react';
import type {AppSettings} from '../shared/types';
import {fontChoices,isBundledFont,terminalFontFamily,bundledFontCatalog,findFont,availableWeights,nearestWeight,fontWeightLabel} from '../shared/fonts';
import type {FontFamilyInfo} from '../shared/font-types';
import {loadFontCatalog,acquireTerminalFont} from './terminal-font-bundle';
import './fonts.css';

export default function FontSettings({settings, onChange}: {settings: AppSettings; onChange: (partial: Partial<AppSettings>) => void}) {
  const [catalog,setCatalog]=useState<FontFamilyInfo[]>(bundledFontCatalog);
  const [loading,setLoading]=useState(true);
  const [previewFamily,setPreviewFamily]=useState('');
  const [fontError, setFontError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void loadFontCatalog().then(fonts => {if (!cancelled) setCatalog(fonts);}).catch(() => {
      if (!cancelled) setFontError('暂时无法读取系统字体，仍可选择内置字体。');
    }).finally(()=>{if(!cancelled)setLoading(false);});
    return () => {cancelled = true;};
  }, []);
  useEffect(() => {
    if(loading)return;
    let cancelled=false;let release:(()=>void)|undefined;
    void acquireTerminalFont(settings,catalog).then(bundle=>{
      if(cancelled){bundle.release();return;}release=bundle.release;setPreviewFamily(bundle.family);setFontError(bundle.warnings.join(' '));
    }).catch(error=>{if(!cancelled){setPreviewFamily('');setFontError(error.message);}});
    return()=>{cancelled=true;release?.();};
  },[catalog,loading,settings.fontFamily,settings.chineseFont,settings.fontWeight,settings.chineseFontWeight]);

  const selector = (language: 'english' | 'chinese', key: 'fontFamily' | 'chineseFont', label: string) => {
    const choices = fontChoices(catalog.map(font=>font.family), language, settings[key]);
    const recommended = choices.recommended.includes(choices.selected);
    const weightKey=language==='english'?'fontWeight':'chineseFontWeight';
    const weights=availableWeights(findFont(catalog,settings[key]));
    const weightId=language==='english'?'font-weight-en':'font-weight-zh';
    const choose=(family:string)=>onChange({[key]:family,[weightKey]:nearestWeight(availableWeights(findFont(catalog,family)),settings[weightKey])});
    return <div className="form-field font-family-field">
      <div className="font-label-row"><label htmlFor={language === 'english' ? 'font-en' : 'font-zh'}>{label}</label>{recommended && <span className="font-recommended-badge">★ 推荐</span>}</div>
      <select id={language === 'english' ? 'font-en' : 'font-zh'} value={choices.selected} onChange={event => choose(event.target.value)}>
        {choices.recommended.length > 0 && <optgroup label="★ 推荐字体">{choices.recommended.map(font => <option className="font-recommended-option" key={font} value={font}>★ {font}{isBundledFont(font) ? ' · 内置' : ''}</option>)}</optgroup>}
        {choices.other.length > 0 && <optgroup label="其他可用字体">{choices.other.map(font => <option key={font} value={font}>{font}{isBundledFont(font) ? ' · 内置' : ''}</option>)}</optgroup>}
        {choices.missing && <optgroup label="当前字体（未检测到）"><option value={choices.missing}>{choices.missing}</option></optgroup>}
      </select>
      {choices.recommended.length > 0 && <div className="font-recommendations" aria-label={`${label}推荐`}>{choices.recommended.slice(0, 3).map(font => <button type="button" key={font} className={`font-recommendation${choices.selected === font ? ' selected' : ''}`} aria-pressed={choices.selected === font} onClick={() => choose(font)}>{font}</button>)}</div>}
      <label className="font-weight-label" htmlFor={weightId}>{language==='english'?'英文字重':'中文字重'}</label>
      <select id={weightId} value={settings[weightKey]} disabled={loading||!weights.length} onChange={event=>onChange({[weightKey]:Number(event.target.value)})}>
        {!weights.includes(settings[weightKey])&&<option value={settings[weightKey]} disabled>当前 {settings[weightKey]} · {loading?'检测中':'此字体未提供'}</option>}
        {weights.map(weight=><option key={weight} value={weight}>{fontWeightLabel(weight)}</option>)}
      </select>
      <span className="font-help">{loading?'正在读取字体字重…':weights.length===1?'此字体仅提供一种真实字重，可换用其他字体。':weights.length?'仅列出字体实际提供的字重。':'未检测到字重，请选择可用字体。'}</span>
    </div>;
  };

  return <section className="font-settings-section">
    <h3>终端字体</h3>
    <p className="settings-description">中英文可分别选择字体和字重，推荐字体以 ★ 标记。中文设置同时用于全角字符和中文标点。</p>
    <div className="form-grid">
      {selector('english', 'fontFamily', '英文字体')}
      {selector('chinese', 'chineseFont', '中文字体')}
      <div className="form-field"><label htmlFor="font-size">字号 · {settings.fontSize} px</label><input id="font-size" type="range" min={8} max={40} step={1} value={settings.fontSize} onChange={event => onChange({fontSize: Number(event.target.value)})} /></div>
      <div className="form-field"><label htmlFor="line-height">行高 · {settings.lineHeight.toFixed(2)}</label><input id="line-height" type="range" min={1} max={1.8} step={.05} value={settings.lineHeight} onChange={event => onChange({lineHeight: Number(event.target.value)})} /></div>
    </div>
    <div className="font-preview" style={{fontFamily:previewFamily||terminalFontFamily(settings),fontSize:settings.fontSize,fontWeight:previewFamily?400:settings.fontWeight,lineHeight:settings.lineHeight}}><span className="accent">root@server</span><span className="preview-muted">:~$ </span>ls -lah<br />0123456789 AaBbCc 终端中文字体预览<br /><span className="preview-muted">drwxr-xr-x　文档 / Documents</span></div>
    {fontError && <p className="font-help" role="status">{fontError}</p>}
  </section>;
}
