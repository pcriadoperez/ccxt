import { fork } from 'node:child_process';
const child = fork(new URL('./ipcchild.mjs', import.meta.url).pathname, [], {
  execArgv: ['--max-old-space-size=1024'], stdio: ['inherit','inherit','inherit','ipc'],
  env: {...process.env},
});
let got = 0;
// The parent also serves HTTP + walks books; emulate that it is not instantaneous.
child.on('message', () => { got++; });
setInterval(() => console.log(`[parent] received ${got} messages`), 5000);
setTimeout(() => { child.kill(); process.exit(0); }, 65000);
