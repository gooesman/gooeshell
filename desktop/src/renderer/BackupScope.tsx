import React from 'react';
import {ordinarySelection, type BackupCatalog, type BackupSelection, type SettingSection} from '../shared/backup';
import './backup-scope.css';

const settingNames:Record<SettingSection,string> = {
  shortcuts:'快捷键与鼠标', appearance:'外观与通用设置', editors:'外部编辑器',
};
export const emptySelection:BackupSelection = {
  settings:[], groupIds:[], connectionIds:[], identityIds:[], commands:false, secrets:false, hostPreferences:false,
};
function toggle<T>(items:T[], targets:T[], add:boolean):T[] {
  const updated = new Set(items);
  for (const id of targets) { if (add) updated.add(id); else updated.delete(id); }
  return [...updated];
}
function Check({label,checked,mixed=false,disabled=false,onChange}:{
  label:string; checked:boolean; mixed?:boolean; disabled?:boolean; onChange:(checked:boolean)=>void;
}) {
  return <label><input type="checkbox" checked={checked} disabled={disabled}
    ref={node=>{if(node)node.indeterminate=mixed;}} onChange={e=>onChange(e.target.checked)}/>{label}</label>;
}

export default function BackupScope({catalog,value,onChange,restore=false,disabled}:{
  catalog:BackupCatalog; value:BackupSelection; onChange:(value:BackupSelection)=>void; restore?:boolean; disabled:boolean;
}) {
  const all = ordinarySelection(catalog);
  const conn = new Set(value.connectionIds), identities = new Set(value.identityIds), groups = new Set(value.groupIds);
  const byGroup = new Map<string|undefined, BackupCatalog['connections']>();
  const needed = new Set<string>();
  for (const item of catalog.connections) {
    const members = byGroup.get(item.groupId) ?? [];
    members.push(item); byGroup.set(item.groupId,members);
    if (conn.has(item.id)) for (const id of item.identityIds) if (!identities.has(id)) needed.add(id);
  }
  function changeRecords(patch:Partial<BackupSelection>) {
    const next = {...value,...patch};
    if (!next.connectionIds.length && !next.identityIds.length) next.secrets=false;
    if (!catalog.connections.some(c=>c.hasPrivateKey && next.connectionIds.includes(c.id))) next.privateKeys=false;
    onChange(next);
  }
  const totalConnections = catalog.connections.length + catalog.groups.length;
  const selectedConnections = conn.size + groups.size;
  function groupRow(groupId:string|undefined, name:string) {
    const members = byGroup.get(groupId) ?? [];
    const ids = members.map(member=>member.id);
    const count = ids.filter(id=>conn.has(id)).length;
    const checked = ids.length>0 ? count===ids.length : !!groupId && groups.has(groupId);
    return <div key={groupId ?? ''} className="backup-group">
      <Check label={name} checked={checked} mixed={count>0 && count<ids.length} onChange={add=>changeRecords({
        connectionIds:toggle(value.connectionIds,ids,add), groupIds:groupId?toggle(value.groupIds,[groupId],add):value.groupIds,
      })}/>
      {members.map(member=><div key={member.id} className="backup-member">
        <Check label={member.name===member.host?member.name:member.name+' · '+member.host} checked={conn.has(member.id)}
          onChange={add=>changeRecords({connectionIds:toggle(value.connectionIds,[member.id],add),
            groupIds:groupId ? toggle(value.groupIds,[groupId],add || count>1) : value.groupIds})}/>
      </div>)}
    </div>;
  }
  return <fieldset className="backup-scope" disabled={disabled}>
    <legend>{restore?'恢复范围':'备份范围'}</legend>
    <div className="backup-actions">
      <button type="button" className="text-button" onClick={()=>onChange({...all,privateKeys:value.privateKeys,secrets:value.secrets,hostPreferences:value.hostPreferences})}>全选</button>
      <button type="button" className="text-button" onClick={()=>onChange(emptySelection)}>清空</button>
    </div>
    <div className="backup-categories">
      {catalog.settings.map(key=><Check key={key} label={settingNames[key]} checked={value.settings.includes(key)}
        onChange={add=>onChange({...value,settings:toggle(value.settings,[key],add)})}/>)}
      <Check label={'命令库（'+catalog.commandCount+' 条）'} checked={value.commands} disabled={!all.commands}
        onChange={commands=>onChange({...value,commands})}/>
      <div><Check label={'登录身份（'+identities.size+'/'+catalog.identities.length+'）'} checked={!!identities.size&&identities.size===catalog.identities.length}
        mixed={identities.size>0&&identities.size<catalog.identities.length} disabled={!catalog.identities.length}
        onChange={add=>changeRecords({identityIds:add?all.identityIds:[]})}/>
        {!!catalog.identities.length && <details><summary>选择身份</summary><div className="backup-list">
          {catalog.identities.map(item=><Check key={item.id} label={item.name+' · '+item.username} checked={identities.has(item.id)}
            onChange={add=>changeRecords({identityIds:toggle(value.identityIds,[item.id],add)})}/>)}
        </div></details>}</div>
      <div><Check label={'连接与分组（'+conn.size+'/'+catalog.connections.length+' 个连接）'}
        checked={!!totalConnections && selectedConnections===totalConnections} mixed={selectedConnections>0&&selectedConnections<totalConnections} disabled={!totalConnections}
        onChange={add=>changeRecords({connectionIds:add?all.connectionIds:[],groupIds:add?all.groupIds:[]})}/>
        {!!totalConnections && <details><summary>选择分组和连接</summary><div className="backup-list">
          {catalog.groups.map(group=>groupRow(group.id,group.name))}
          {byGroup.has(undefined) && groupRow(undefined,'未分组')}
        </div></details>}</div>
    </div>
    {needed.size>0 && <p className="settings-description">所选连接和跳板机引用了 {needed.size} 个未选身份。仅保留用户名，或
      <button type="button" className="text-button" onClick={()=>changeRecords({identityIds:toggle(value.identityIds,[...needed],true)})}>带上关联身份</button>。</p>}
    {catalog.connections.some(c=>c.hasPrivateKey) && <Check label={restore?'恢复所选连接和跳板机的 SSH 私钥文件':'包含所选连接和跳板机的 SSH 私钥文件'} checked={!!value.privateKeys}
      disabled={!catalog.connections.some(c=>conn.has(c.id)&&c.hasPrivateKey)} onChange={privateKeys=>onChange({...value,privateKeys})}/>}
    {(!restore || catalog.hasSecrets) && <Check label="包含所选连接和身份长期保存的密码和私钥口令" checked={value.secrets}
      disabled={!conn.size&&!identities.size} onChange={secrets=>onChange({...value,secrets})}/>}
    {!restore && value.privateKeys && value.secrets && <p className="settings-description">没有口令的私钥可直接备份。如果以前记住的密码无法备份，导出后会告诉你是哪条连接。</p>}
    {catalog.hosts.length>0 && <><Check label={catalog.hosts.length+' 个地址的跳过指纹验证设置'} checked={value.hostPreferences}
      onChange={hostPreferences=>onChange({...value,hostPreferences})}/>
      <details><summary>查看地址</summary><div className="backup-list">{catalog.hosts.map(item=><div key={JSON.stringify(item)}>{item.host}:{item.port}</div>)}</div></details>
      {restore&&value.hostPreferences&&<p className="settings-description">恢复后，这些地址将跳过 SSH 主机指纹验证。</p>}</>}
    {restore && value.settings.length>0 && <p className="settings-description">将替换本机设置：{value.settings.map(key=>settingNames[key]).join('、')}。</p>}
  </fieldset>;
}
