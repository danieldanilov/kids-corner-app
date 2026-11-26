// One ffmpeg.wasm instance in a Worker of its own, started by decoders-ffmpeg.js from the engine's Worker. It is
// separate so a run that hangs (ffmpeg.wasm can loop forever after many runs) can be killed with terminate(),
// and so a recycled instance frees all its memory at once.
//
// Messages in:  {op:'init', module, coreURL, spawn}   module: the compiled WebAssembly.Module, shared, not recompiled
//               {op:'decode', id, win, args, cap, buf}  win: the window AVI (transferred); args: ffmpeg's arguments
//                                                       after the input, ending before the output; buf: a buffer to
//                                                       fill, handed back from the last run (transferred)
// Messages out: {op:'ready'} | {op:'error', error}
//               {op:'done', id, ret, used, buf, log}    buf holds `used` bytes of raw frames (transferred)

let core = null, logTail = [];
let out = new Uint8Array(0), used = 0;
const put = (src, off, len) => {
  if (used + len > out.length) { const next = new Uint8Array(Math.max(used + len, out.length * 2)); next.set(out.subarray(0, used)); out = next; }
  out.set(src.subarray(off, off + len), used); used += len;
};

self.onmessage = async ({ data }) => {
  if (data.op === 'init') {
    try {
      const m = await import(data.coreURL);
      core = await m.default({
        instantiateWasm(imports, done) { WebAssembly.instantiate(data.module, imports).then(inst => done(inst, data.module)); return {}; },
        locateFile: p => p,
        mainScriptUrlOrBlob: `${data.coreURL}#${btoa(JSON.stringify({ wasmURL: '', workerURL: '' }))}`,
      });
      core.setLogger(({ message }) => { logTail.push(String(message)); if (logTail.length > 12) logTail.shift(); });
      // ffmpeg writes its raw output to this device (as pipe:<fd>), straight into `out`, not into a MEMFS file.
      const dev = core.FS.makedev(200, 0);
      core.FS.registerDevice(dev, { open() {}, close() {}, read() { return 0; }, write(stream, buffer, offset, length) { put(buffer, offset, length); return length; } });
      core.FS.mkdev('/sink', dev);
      postMessage({ op: 'ready' });
    } catch (e) { postMessage({ op: 'error', error: String(e?.message || e) }); }
    return;
  }
  if (data.op === 'decode') {
    out = data.buf && data.buf.byteLength >= data.cap ? new Uint8Array(data.buf) : new Uint8Array(data.cap);
    used = 0; logTail = [];
    let ret = -1, stream = null;
    const id = `/w${data.id}`;
    try {
      stream = core.FS.open('/sink', 'w');
      core.FS.writeFile(id + '.avi', new Uint8Array(data.win), { canOwn: true });
      ret = core.exec('-nostdin', '-v', 'error', '-i', id + '.avi', ...data.args, `pipe:${stream.fd}`);
      core.reset();
    } catch (e) { logTail.push(String(e?.message || e)); ret = -2; }
    try { if (stream) core.FS.close(stream); } catch { /* closed */ }
    try { core.FS.unlink(id + '.avi'); } catch { /* gone */ }
    const buf = out.buffer;
    out = new Uint8Array(0);
    postMessage({ op: 'done', id: data.id, ret, used, buf, log: logTail.join(' | ').slice(0, 400) }, [buf]);
  }
};
