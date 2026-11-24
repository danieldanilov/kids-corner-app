// Dedicated module Worker: keeps demuxing and muxing off the main thread so the loading toys never stutter.
import { createEngine } from './engine.js';

const engine = createEngine((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = e => { engine.handle(e.data); };
