// H5 适配层：把 weapp-vite web 运行时（@weapp-vite/web）暴露为全局 wx，
// 并补齐它没有的三个能力：connectSocket（WebSocket 桥）、canvasToTempFilePath
// （附件 JPEG 导出链）、scanCode（H5 手动输入 6 位配对码）。
// 小程序源码一行不改：本文件只存在于 h5/ 构建壳里。
import * as weapi from '@weapp-vite/web/runtime';

const g = globalThis;

// ---- 1) WebSocket 桥：小程序 SocketTask 接口（app.js 的 socket() 消费） ----
function connectSocket(options = {}) {
  const listeners = { open: [], message: [], close: [], error: [] };
  let socket = null;
  try {
    socket = new WebSocket(options.url);
  } catch (error) {
    options.fail?.({ errMsg: 'connectSocket:fail ' + (error?.message || error) });
    options.complete?.({ errMsg: 'connectSocket:fail' });
  }
  if (socket) {
    socket.addEventListener('open', () => { for (const f of listeners.open) f({}); });
    socket.addEventListener('message', (event) => {
      for (const f of listeners.message) f({ data: event.data });
    });
    socket.addEventListener('close', (event) => {
      for (const f of listeners.close) f({ code: event.code, reason: event.reason || '' });
    });
    socket.addEventListener('error', () => {
      for (const f of listeners.error) f({ errMsg: 'connectSocket.onError' });
    });
  }
  const task = {
    onOpen: (cb) => { listeners.open.push(cb); },
    onMessage: (cb) => { listeners.message.push(cb); },
    onClose: (cb) => { listeners.close.push(cb); },
    onError: (cb) => { listeners.error.push(cb); },
    send: ({ data, fail } = {}) => {
      if (!socket || socket.readyState !== 1) {
        fail?.({ errMsg: 'sendSocketMessage:fail socket not open' });
        throw new Error('socket not open');
      }
      socket.send(typeof data === 'string' ? data : String(data));
    },
    close: ({ code = 1000, reason = '' } = {}) => { try { socket?.close(code, reason); } catch {} },
    readyState: () => socket?.readyState ?? 3,
  };
  options.success?.({ socketTask: task });
  options.complete?.({ errMsg: 'connectSocket:ok' });
  return task;
}

// ---- 2) 附件链接管：选图 → 缩放转 JPEG → base64，全程标准 Web API ----
// 页面按小程序旧 canvas 接口调用（chooseMedia/getImageInfo/createCanvasContext/
// canvasToTempFilePath/getFileSystemManager.readFile），这里给出等价实现。
const virtualFiles = new Map();
let virtualSeq = 0;
const newVirtualPath = () => 'drc-h5://' + (++virtualSeq);

function pickFile(accept) {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) reject({ errMsg: 'chooseMedia:fail cancel' });
      else resolve(file);
    };
    input.oncancel = () => reject({ errMsg: 'chooseMedia:fail cancel' });
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    image.src = url;
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function toJpegBase64(file) {
  const { image, url } = await loadImage(file);
  const ratio = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  URL.revokeObjectURL(url);
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (value) => (value ? resolve(value) : reject(new Error('JPEG 转换失败'))), 'image/jpeg', 0.7,
  ));
  return fileToBase64(blob);
}

const chooseMedia = async (options = {}) => {
  const file = await pickFile('image/*');
  const path = newVirtualPath();
  virtualFiles.set(path, { file, name: file.name });
  return { type: 'image', tempFiles: [{ tempFilePath: path, size: file.size }] };
};

const chooseMessageFile = async (options = {}) => {
  const file = await pickFile(options.extension?.length ? '.' + options.extension.join(',.') : '');
  const path = newVirtualPath();
  virtualFiles.set(path, { file, name: file.name });
  return { tempFiles: [{ path, name: file.name, size: file.size, type: 'file' }] };
};

const getImageInfo = async (options = {}) => {
  const entry = virtualFiles.get(options.src);
  const { image, url } = await loadImage(entry?.file || options.src);
  const info = { path: options.src, width: image.naturalWidth, height: image.naturalHeight };
  URL.revokeObjectURL(url);
  options.success?.(info);
  return info;
};

// 旧 canvas 接口的 mock：drawImage 时真正完成缩放转换，draw 回调照常触发。
const createCanvasContext = (canvasId) => {
  const state = { fillStyle: '#000', image: null, jpeg: null };
  canvasContexts.set(canvasId, state);
  return {
    setFillStyle: (value) => { state.fillStyle = value; },
    fillRect: () => {},
    drawImage: async (src) => {
      const entry = virtualFiles.get(typeof src === 'string' ? src : '');
      if (entry?.file) state.jpeg = await toJpegBase64(entry.file);
    },
    draw: (_reserve, callback) => { setTimeout(callback || (() => {}), 0); },
  };
};
const canvasContexts = new Map();

const canvasToTempFilePath = (options = {}) => {
  const state = canvasContexts.get(options.canvasId);
  if (!state?.jpeg) return Promise.reject({ errMsg: 'canvasToTempFilePath:fail no image' });
  const path = newVirtualPath();
  virtualFiles.set(path, { base64: state.jpeg, name: 'photo.jpg' });
  const result = { tempFilePath: path };
  options.success?.(result);
  return result;
};

const getFileSystemManager = () => ({
  readFile: ({ filePath, encoding, success, fail, complete } = {}) => {
    const entry = virtualFiles.get(filePath);
    const run = async () => {
      if (!entry) throw new Error('文件不存在');
      const data = entry.base64 ?? await fileToBase64(entry.file);
      const value = encoding === 'base64' ? data : await (await fetch('data:application/octet-stream;base64,' + data)).text();
      success?.({ data: value });
      complete?.({ errMsg: 'readFile:ok' });
    };
    run().catch((error) => { fail?.({ errMsg: 'readFile:fail ' + error.message }); });
  },
});

// ---- 3) H5 扫码 = 手动输入电脑上显示的 6 位配对码（协议只要 scene 文本） ----
const scanCode = ({ success, fail } = {}) => {
  const value = g.prompt?.('请输入电脑上「远程控制」面板显示的 6 位配对码');
  if (value && /^\s*\d{6}\s*$/.test(value)) success?.({ result: value.trim(), path: '' });
  else fail?.({ errMsg: 'scanCode:fail cancel' });
};

const wx = Object.create(null);
Object.assign(wx, weapi);
wx.connectSocket = connectSocket;
wx.chooseMedia = chooseMedia;
wx.chooseMessageFile = chooseMessageFile;
wx.getImageInfo = getImageInfo;
wx.createCanvasContext = createCanvasContext;
wx.canvasToTempFilePath = canvasToTempFilePath;
wx.getFileSystemManager = getFileSystemManager;
wx.scanCode = scanCode;
// 微信专属、H5 无对应：给无害降级，页面按 fail/cancel 路径自然处理。
wx.login = (options = {}) => { options.success?.({ code: '' }); options.fail?.({ errMsg: 'login:fail web' }); };
wx.requestSubscribeMessage = (options = {}) => { options.fail?.({ errMsg: 'requestSubscribeMessage:fail web' }); };
wx.getRandomValues = undefined; // 故意留空：app.js 自带 WebCrypto 兜底
if (g.wx && typeof g.wx.connectSocket === 'function' && g.wx !== wx) {
  // 运行时若已注入全局 wx，只补缺口，不覆盖它的实现
  for (const key of ['connectSocket', 'canvasToTempFilePath']) if (typeof g.wx[key] !== 'function') g.wx[key] = wx[key];
} else {
  g.wx = wx;
}
