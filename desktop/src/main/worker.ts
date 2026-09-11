import { parentPort, workerData } from 'node:worker_threads';
import { SshService } from './ssh-service';
const service = new SshService(event => parentPort!.postMessage({event}), workerData.knownHostsFile);
const methods = new Set(['connect','disconnect','confirmHostKey','remoteList','transfer','cancelTransfer','readFile','writeFile','readTextFile','writeTextFile','chmod','runFile','mkdir','rename','terminalInput','terminalBinaryInput','terminalResize','terminalAck','shutdown']);
parentPort!.on('message', async ({id,method,args}) => {
  try {
    if (!methods.has(method)) throw new Error('不支持的连接操作');
    const value = await (service as any)[method](...args);
    if (id) parentPort!.postMessage({id,value});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if(id) parentPort!.postMessage({id,error:message});
    else parentPort!.postMessage({event:{type:'notice',message}});
  }
});
