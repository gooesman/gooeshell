import {copyFile} from 'node:fs/promises';
await copyFile('src/main/server-transfer-agent.py','dist-main/main/server-transfer-agent.py');
