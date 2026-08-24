import zlib from 'node:zlib';
const mb = (b) => (b / 1048576).toFixed(2);
function snap (tag) {
    global.gc(); global.gc();
    const m = process.memoryUsage();
    console.log(`${tag.padEnd(34)} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB ab=${mb(m.arrayBuffers)}MB`);
    return m;
}
const base = snap('baseline');
// exactly what ws does on the receive path for a client
const N = Number(process.argv[2] || 143);
const streams = [];
const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ x: 'y'.repeat(50000) })));
for (let i = 0; i < N; i++) {
    const s = zlib.createInflateRaw({ windowBits: zlib.constants.Z_DEFAULT_WINDOWBITS });
    s.on('data', () => {});
    s.write(payload); s.flush(() => {});
    streams.push(s);
}
await new Promise((r) => setTimeout(r, 2000));
const after = snap(`after ${N} inflateRaw contexts`);
console.log(`per-context rss delta: ${((after.rss - base.rss) / N / 1024).toFixed(1)} KB`);
console.log(`per-context ext delta: ${((after.external - base.external) / N / 1024).toFixed(1)} KB`);
// now add deflate contexts (send path, only if the client compresses outgoing frames >1KB)
const defl = [];
for (let i = 0; i < N; i++) {
    const s = zlib.createDeflateRaw({ windowBits: 15, memLevel: 8 });
    s.on('data', () => {});
    s.write(Buffer.from('x'.repeat(4096))); s.flush(() => {});
    defl.push(s);
}
await new Promise((r) => setTimeout(r, 2000));
const after2 = snap(`+ ${N} deflateRaw contexts`);
console.log(`per-deflate rss delta: ${((after2.rss - after.rss) / N / 1024).toFixed(1)} KB`);
console.log(`TOTAL for ${N} conns (inflate+deflate): ${mb(after2.rss - base.rss)} MB`);
process.exit(0);
