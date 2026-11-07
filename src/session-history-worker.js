const { parentPort, workerData } = require('worker_threads');
const { listResumableSessions } = require('./session-history');

parentPort.postMessage(listResumableSessions(workerData));
