import { decodeTerminalBytes, decodeTerminalBytesFallback } from '../../src/renderer/terminal-output';
import './terminal-tabs';

Object.assign(window, { __decodeTerminalBytes: decodeTerminalBytes, __decodeTerminalBytesFallback: decodeTerminalBytesFallback });
