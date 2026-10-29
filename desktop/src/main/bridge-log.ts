import type {Client} from 'ssh2';
import type {BridgeLogRead} from '../shared/mcp';
import {executeBridgeChannel,quote} from './bridge-command';

export const LOG_READ_PYTHON=String.raw`
import base64, hashlib, json, os, stat, sys
r=json.loads(sys.stdin.readline(65536))
fd=os.open(r['path'],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
    s=os.fstat(fd)
    if not stat.S_ISREG(s.st_mode): raise ValueError('日志必须是普通文件，不能是管道或链接')
    identity=str(s.st_dev)+':'+str(s.st_ino)
    def boundary(offset):
        start=max(0,offset-64)
        os.lseek(fd,start,os.SEEK_SET)
        return hashlib.sha256(os.read(fd,offset-start)).hexdigest()[:32]
    expected=identity+':'+boundary(r['offset'])
    reset=(r.get('cursor') is not None and r['cursor']!=expected) or r['offset']>s.st_size
    offset=0 if reset else r['offset']
    os.lseek(fd,offset,os.SEEK_SET)
    data=os.read(fd,r['maxBytes'])
    # Do not split a UTF-8 codepoint at the next cursor. Invalid log bytes are replaced.
    while data and offset+len(data)<s.st_size:
        try: data.decode('utf-8'); break
        except UnicodeDecodeError as e:
            if e.reason!='unexpected end of data': break
            extra=os.read(fd,1)
            if not extra: break
            data+=extra
    end=offset+len(data)
    print(json.dumps(dict(data=base64.b64encode(data).decode('ascii'),nextOffset=end,cursor=identity+':'+boundary(end),reset=reset,eof=end>=s.st_size)))
finally: os.close(fd)
`;
export async function readBridgeLog(client:Client,request:BridgeLogRead,encoding:string,signal:AbortSignal){
  const result=await executeBridgeChannel(client,'python3 -c '+quote(LOG_READ_PYTHON),encoding,signal,15000,Buffer.from(JSON.stringify(request)+'\n'));
  if(result.exitCode!==0||result.truncated)throw new Error(result.stderr.slice(-2048)||'读取日志失败');
  const {data,...value}=JSON.parse(result.stdout);return{...value,output:Buffer.from(data,'base64').toString('utf8')};
}
