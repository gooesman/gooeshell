import type {LocalSessionInfo, SessionInfo, SshSessionInfo, HostProfile} from './types';

export function isLocalSession(session: SessionInfo): session is LocalSessionInfo { return session.kind === 'local'; }
export function isSshSession(session: SessionInfo): session is SshSessionInfo { return session.kind !== 'local'; }
export function sessionName(session: SessionInfo): string { return isLocalSession(session) ? session.name : session.profile.name; }
export function sessionEncoding(session: SessionInfo): HostProfile['encoding'] { return isLocalSession(session) ? 'utf8' : session.profile.encoding; }
export function sessionAddress(session: SessionInfo): string { return isLocalSession(session) ? session.cwd : `${session.profile.username}@${session.profile.host}:${session.profile.port}`; }
