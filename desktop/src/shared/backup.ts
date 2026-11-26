import type {AppSettings, ConnectionGroup, HostKeyPreference} from './types';

export const settingFields = {
  shortcuts: ['shortcuts', 'shortcutSchemaVersion', 'copyOnSelect', 'sudoPasswordSubmit'],
  appearance: ['theme', 'editorPalette', 'terminalPalette', 'terminalBold', 'commandMarks',
    'showConnectionHistory', 'filesToggleIconOnly', 'fontWeight', 'chineseFontWeight', 'fontFamily',
    'chineseFont', 'fontSize', 'lineHeight', 'cursorBlink', 'backgroundImage', 'backgroundOpacity'],
  editors: ['externalEditorPath', 'externalEditorByExtension'],
} as const satisfies Record<string, readonly (keyof AppSettings)[]>;
export type SettingSection = keyof typeof settingFields;
export const settingSections = Object.keys(settingFields) as SettingSection[];

export function pickSettings(settings:Partial<AppSettings>, sections:SettingSection[]):Partial<AppSettings> {
  const keys = sections.flatMap(section => [...settingFields[section]]);
  return Object.fromEntries(keys.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
}

export interface BackupCatalog {
  settings:SettingSection[];
  groups:Pick<ConnectionGroup,'id'|'name'>[];
  connections:{id:string;name:string;host:string;groupId?:string;identityIds:string[];hasPrivateKey?:boolean}[];
  identities:{id:string;name:string;username:string}[];
  commandCount:number;
  commandGroupCount:number;
  hasSecrets:boolean;
  hosts:Pick<HostKeyPreference,'host'|'port'>[];
}
export interface BackupSelection {
  settings:SettingSection[];
  groupIds:string[];
  connectionIds:string[];
  identityIds:string[];
  commands:boolean;
  secrets:boolean;
  privateKeys?:boolean;
  hostPreferences:boolean;
}
export function ordinarySelection(catalog:BackupCatalog):BackupSelection {
  return {settings:catalog.settings, groupIds:catalog.groups.map(item=>item.id),
    connectionIds:catalog.connections.map(item=>item.id), identityIds:catalog.identities.map(item=>item.id),
    commands:catalog.commandCount + catalog.commandGroupCount > 0, secrets:false, hostPreferences:false};
}
export function hasSelection(value:BackupSelection) {
  return !!(value.settings.length || value.groupIds.length || value.connectionIds.length ||
    value.identityIds.length || value.commands || value.hostPreferences);
}
