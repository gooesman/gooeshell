import {copyFile} from 'node:fs/promises';
await copyFile('src/main/server-transfer-agent.py','dist-main/main/server-transfer-agent.py');
await copyFile('src/main/fallback-task.py','dist-main/main/fallback-task.py');
