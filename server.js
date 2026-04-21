const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
let adminCookieCode = process.env.ADMIN_COOKIE_CODE || '1145';
const NAME_ROOM_REGEX = /^[A-Za-z0-9\u4e00-\u9fa5]{1,20}$/;
const MAX_ROOMS_PER_USER = 3;
const STATUS_PUSH_INTERVAL = 5000;

const settings = {
  maxPerson: Math.max(1, Number(process.env.DEFAULT_MAX_PERSON) || 5),
  bannedWords: ['78', '91', 'sb'],
  bannedPlayers: [],
};

const ipUsers = Object.create(null);

/**
 * rooms:
 * {
 *   [roomId]: {
 *     owner: string,
 *     content: string,
 *     members: Set<string>
 *   }
 * }
 */
const rooms = Object.create(null);

/**
 * userOwnedRooms:
 * {
 *   [username]: Set<roomId>
 * }
 */
const userOwnedRooms = Object.create(null);

/**
 * socketSessions:
 * Map<socket.id, { username: string, roomId: string | null }>
 */
const socketSessions = new Map();

app.use(express.json());

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWords(words) {
  if (!Array.isArray(words)) {
    return settings.bannedWords.filter((word) => word !== 'admin');
  }

  const nextWords = Array.from(
    new Set(
      words
        .map((item) => normalizeValue(item).toLowerCase())
        .filter((item) => Boolean(item) && item !== 'admin'),
    ),
  );

   return nextWords.length ? nextWords : settings.bannedWords.filter((word) => word !== 'admin');
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) {
    return settings.bannedPlayers;
  }

  return Array.from(
    new Set(
      players
        .map((item) => normalizeValue(item))
        .filter((item) => isValidName(item)),
    ),
  );
}

function randomLetters(length) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += letters[Math.floor(Math.random() * letters.length)];
  }
  return output;
}

function generateDefaultUsername() {
  let candidate = `User${randomLetters(4)}`;
  while (!isValidName(candidate)) {
    candidate = `User${randomLetters(4)}`;
  }
  return candidate;
}

function normalizeIp(value) {
  const normalized = normalizeValue(value);
  if (!normalized) {
    return '';
  }

  if (normalized === '::1' || normalized === '127.0.0.1' || normalized === '::ffff:127.0.0.1') {
    return 'loopback';
  }

  return normalized.replace(/^::ffff:/, '');
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return normalizeIp(forwarded.split(',')[0]);
  }

  return normalizeIp(req.socket?.remoteAddress || req.ip || '');
}

function ensureIdentityByIp(ip) {
  if (!ipUsers[ip]) {
    ipUsers[ip] = generateDefaultUsername();
  }

  return ipUsers[ip];
}

function bindIpUser(ip, username) {
  if (!ip || !isValidName(username)) {
    return '';
  }

  ipUsers[ip] = username;
  return ipUsers[ip];
}

function isBannedPlayer(username) {
  return settings.bannedPlayers.includes(normalizeValue(username));
}

function getOnlineUsers() {
  return Array.from(
    new Set(
      Array.from(socketSessions.values())
        .map((session) => normalizeValue(session.username))
        .filter(Boolean),
    ),
  );
}

function getAdminSettings() {
  return {
    maxPerson: settings.maxPerson,
    bannedWords: [...settings.bannedWords],
    bannedPlayers: [...settings.bannedPlayers],
  };
}

function parseCookies(cookieHeader) {
  const cookies = Object.create(null);
  const source = typeof cookieHeader === 'string' ? cookieHeader : '';

  source.split(';').forEach((item) => {
    const parts = item.split('=');
    const key = normalizeValue(parts.shift());
    if (!key) {
      return;
    }

    cookies[key] = decodeURIComponent(parts.join('=') || '');
  });

  return cookies;
}

function decodeBase64(value) {
  try {
    return Buffer.from(String(value || ''), 'base64').toString('utf8');
  } catch (error) {
    return '';
  }
}

function isValidAdminCode(value) {
  const normalized = normalizeValue(value);
  return Boolean(normalized) && /^[A-Za-z0-9]+$/.test(normalized);
}

function hasBannedWord(value) {
  const normalized = normalizeValue(value).toLowerCase();
  return settings.bannedWords.some((word) => normalized.includes(word));
}

function isValidName(value) {
  const normalized = normalizeValue(value);
  return Boolean(normalized) && NAME_ROOM_REGEX.test(normalized) && !hasBannedWord(normalized);
}

function getOwnedRoomCount(username) {
  return userOwnedRooms[username] ? userOwnedRooms[username].size : 0;
}

function ensureOwnerSet(username) {
  if (!userOwnedRooms[username]) {
    userOwnedRooms[username] = new Set();
  }
  return userOwnedRooms[username];
}

function getRoomMemberNames(roomId) {
  const room = rooms[roomId];
  if (!room) {
    return [];
  }

  return Array.from(
    new Set(
      Array.from(room.members)
        .map((socketId) => socketSessions.get(socketId)?.username || '')
        .filter(Boolean),
    ),
  );
}

function serializeRoom(roomId) {
  const room = rooms[roomId];
  return {
    roomId,
    owner: room.owner,
    memberCount: room.members.size,
    maxPerson: settings.maxPerson,
  };
}

function getServerLoad() {
  const memoryUsage = process.memoryUsage();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    nodeMemoryMB: Math.round(memoryUsage.rss / 1024 / 1024),
    heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
    systemLoadAvg: os.loadavg().map((value) => Number(value.toFixed(2))),
    totalConnections: socketSessions.size,
    activeRooms: Object.keys(rooms).length,
  };
}

function getPublicSettings() {
  return {
    maxPerson: settings.maxPerson,
    bannedWords: [...settings.bannedWords],
  };
}

function emitRoomPresence(roomId) {
  const room = rooms[roomId];
  if (!room) {
    return;
  }

  io.to(roomId).emit('room-presence', {
    roomId,
    memberCount: room.members.size,
    memberNames: getRoomMemberNames(roomId),
    maxPerson: settings.maxPerson,
  });
}

function emitRoomsUpdated() {
  io.emit('rooms-updated', {
    rooms: Object.keys(rooms).map(serializeRoom),
  });
}

function emitSystemOverview() {
  io.emit('system-overview', {
    load: getServerLoad(),
    settings: getPublicSettings(),
  });
}

function emitSettingsUpdated() {
  io.emit('settings-updated', getPublicSettings());
  emitRoomsUpdated();
  emitSystemOverview();

  Object.keys(rooms).forEach((roomId) => {
    emitRoomPresence(roomId);
  });
}

function emitBanState(socket) {
  if (!socket) {
    return;
  }

  const session = socketSessions.get(socket.id);
  socket.emit('ban-state', {
    isBanned: isBannedPlayer(session?.username || ''),
  });
}

function emitBanStates() {
  socketSessions.forEach((session, socketId) => {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (!targetSocket) {
      return;
    }

    targetSocket.emit('ban-state', {
      isBanned: isBannedPlayer(session.username || ''),
    });
  });
}

function removeRoom(roomId) {
  const room = rooms[roomId];
  if (!room) {
    return;
  }

  for (const socketId of room.members) {
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
      targetSocket.leave(roomId);
      targetSocket.emit('room-deleted', { roomId });
    }

    const session = socketSessions.get(socketId);
    if (session && session.roomId === roomId) {
      session.roomId = null;
    }
  }

  room.members.clear();

  if (userOwnedRooms[room.owner]) {
    userOwnedRooms[room.owner].delete(roomId);
    if (userOwnedRooms[room.owner].size === 0) {
      delete userOwnedRooms[room.owner];
    }
  }

  delete rooms[roomId];
}

function isAdminRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return decodeBase64(cookies.adminpass) === adminCookieCode;
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/rooms', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(serializeRoom),
    settings: getPublicSettings(),
    load: getServerLoad(),
  });
});

app.get('/api/identity', (req, res) => {
  const ip = getClientIp(req);

  if (!ip) {
    return res.status(400).json({ message: '无法识别客户端 IP。' });
  }

  const username = ensureIdentityByIp(ip);

  return res.json({
    username,
  });
});

app.post('/api/identity', (req, res) => {
  const ip = getClientIp(req);
  const username = normalizeValue(req.body?.username);

  if (!ip) {
    return res.status(400).json({ message: '无法识别客户端 IP。' });
  }

  if (!isValidName(username)) {
    return res.status(400).json({ message: '昵称仅支持 20 字内中英文，且不能包含违禁词。' });
  }

  return res.json({
    username: bindIpUser(ip, username),
  });
});

app.get('/api/admin/session', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ ok: false, message: '无管理员权限。' });
  }

  return res.json({ ok: true });
});

app.get('/api/admin/rooms', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  return res.json({
    rooms: Object.keys(rooms).map(serializeRoom),
    onlineUsers: getOnlineUsers(),
    settings: getAdminSettings(),
    load: getServerLoad(),
  });
});

app.post('/api/admin/settings', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  const nextMaxPerson = Number(req.body?.maxPerson);
  const nextBannedWords = normalizeWords(req.body?.bannedWords);
  const nextBannedPlayers = normalizePlayers(req.body?.bannedPlayers);
  const nextAdminCode = normalizeValue(req.body?.adminCode);

  if (!Number.isInteger(nextMaxPerson) || nextMaxPerson < 1 || nextMaxPerson > 100) {
    return res.status(400).json({ message: 'maxPerson 必须是 1 到 100 之间的整数。' });
  }

  if (nextAdminCode && !isValidAdminCode(nextAdminCode)) {
    return res.status(400).json({ message: '管理员暗号仅支持数字或字母。' });
  }

  settings.maxPerson = nextMaxPerson;
  settings.bannedWords = nextBannedWords;
  settings.bannedPlayers = nextBannedPlayers;
  if (nextAdminCode) {
    adminCookieCode = nextAdminCode;
  }

  emitSettingsUpdated();
  emitBanStates();

  return res.json({
    message: '管理员设置已更新。',
    settings: getAdminSettings(),
  });
});

app.post('/api/admin/players/ban', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  const username = normalizeValue(req.body?.username);
  if (!isValidName(username)) {
    return res.status(400).json({ message: '玩家名仅支持 20 字内数字、中英文，且不能包含违禁词。' });
  }

  if (!settings.bannedPlayers.includes(username)) {
    settings.bannedPlayers.push(username);
  }

  emitBanStates();

  return res.json({
    message: `玩家 ${username} 已封禁。`,
    settings: getAdminSettings(),
    onlineUsers: getOnlineUsers(),
  });
});

app.delete('/api/admin/rooms/:roomId', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  const roomId = normalizeValue(req.params.roomId);
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ message: '房间不存在或已删除。' });
  }

  removeRoom(roomId);
  emitRoomsUpdated();
  emitSystemOverview();

  return res.json({
    message: `房间 ${roomId} 已删除。`,
  });
});

io.on('connection', (socket) => {
  socketSessions.set(socket.id, {
    username: '',
    roomId: null,
  });

  socket.emit('settings-updated', getPublicSettings());
  socket.emit('system-overview', {
    load: getServerLoad(),
    settings: getPublicSettings(),
  });
  emitBanState(socket);

  socket.on('register-user', ({ username }) => {
    const normalizedUser = normalizeValue(username);
    const session = socketSessions.get(socket.id);

    if (!session || !isValidName(normalizedUser)) {
      return;
    }

    session.username = normalizedUser;
    emitBanState(socket);
  });

  socket.on('create-room', ({ username, roomId }) => {
    const normalizedUser = normalizeValue(username);
    const normalizedRoomId = normalizeValue(roomId);
    const session = socketSessions.get(socket.id);

    if (!isValidName(normalizedUser) || !isValidName(normalizedRoomId)) {
      return socket.emit('action-error', { message: '昵称和房间号仅支持 20 字内数字、中英文，且不能包含违禁词。' });
    }

    if (isBannedPlayer(normalizedUser)) {
      return socket.emit('action-error', { message: '当前账号已被封禁，无法创建房间。' });
    }

    if (session) {
      session.username = normalizedUser;
    }

    if (rooms[normalizedRoomId]) {
      return socket.emit('action-error', { message: '房间号已存在。' });
    }

    if (getOwnedRoomCount(normalizedUser) >= MAX_ROOMS_PER_USER) {
      return socket.emit('action-error', { message: '每个账户最多创建 3 个房间。' });
    }

    rooms[normalizedRoomId] = {
      owner: normalizedUser,
      content: '# 欢迎使用 Markdown 协作编辑器\n\n开始编写内容吧。',
      members: new Set(),
    };

    ensureOwnerSet(normalizedUser).add(normalizedRoomId);

    socket.emit('room-created', {
      room: serializeRoom(normalizedRoomId),
    });

    emitRoomsUpdated();
    emitSystemOverview();
  });

  socket.on('join-room', ({ username, roomId }) => {
    const normalizedUser = normalizeValue(username);
    const normalizedRoomId = normalizeValue(roomId);
    const session = socketSessions.get(socket.id);

    if (!session) {
      return socket.emit('action-error', { message: '会话不存在，请刷新页面。' });
    }

    if (!isValidName(normalizedUser) || !isValidName(normalizedRoomId)) {
      return socket.emit('action-error', { message: '昵称和房间号仅支持 20 字内数字、中英文，且不能包含违禁词。' });
    }

    const room = rooms[normalizedRoomId];
    if (!room) {
      return socket.emit('action-error', { message: '房间不存在。' });
    }

    if (!room.members.has(socket.id) && room.members.size >= settings.maxPerson) {
      return socket.emit('action-error', { message: `该房间已满，最多允许 ${settings.maxPerson} 人在线。` });
    }

    if (session.roomId && rooms[session.roomId]) {
      const previousRoomId = session.roomId;
      rooms[previousRoomId].members.delete(socket.id);
      socket.leave(previousRoomId);
      emitRoomPresence(previousRoomId);
    }

    socket.join(normalizedRoomId);
    room.members.add(socket.id);

    session.username = normalizedUser;
    session.roomId = normalizedRoomId;

    socket.emit('room-joined', {
      room: serializeRoom(normalizedRoomId),
      content: room.content,
      isOwner: room.owner === normalizedUser,
      isBanned: isBannedPlayer(normalizedUser),
      memberNames: getRoomMemberNames(normalizedRoomId),
      maxPerson: settings.maxPerson,
    });

    emitRoomPresence(normalizedRoomId);
    emitRoomsUpdated();
    emitSystemOverview();
  });

  socket.on('leave-room', () => {
    const session = socketSessions.get(socket.id);
    if (!session || !session.roomId) {
      return;
    }

    const roomId = session.roomId;
    const room = rooms[roomId];
    if (room) {
      room.members.delete(socket.id);
      socket.leave(roomId);
      emitRoomPresence(roomId);
    }

    session.roomId = null;

    emitRoomsUpdated();
    emitSystemOverview();
  });

  socket.on('delete-room', ({ username, roomId }) => {
    const normalizedUser = normalizeValue(username);
    const normalizedRoomId = normalizeValue(roomId);
    const room = rooms[normalizedRoomId];

    if (!room) {
      return socket.emit('action-error', { message: '房间不存在或已删除。' });
    }

    if (room.owner !== normalizedUser) {
      return socket.emit('action-error', { message: '只有房主可以删除房间。' });
    }

    if (isBannedPlayer(normalizedUser)) {
      return socket.emit('action-error', { message: '当前账号已被封禁，无法删除房间。' });
    }

    removeRoom(normalizedRoomId);

    socket.emit('room-removed', { roomId: normalizedRoomId });
    emitRoomsUpdated();
    emitSystemOverview();
  });

  socket.on('sync-content', ({ roomId, content }) => {
    const normalizedRoomId = normalizeValue(roomId);
    const room = rooms[normalizedRoomId];
    const session = socketSessions.get(socket.id);

    if (!room || !session || session.roomId !== normalizedRoomId) {
      return;
    }

    if (isBannedPlayer(session.username)) {
      socket.emit('action-error', { message: '当前账号已被封禁，无法修改房间内容。' });
      emitBanState(socket);
      return;
    }

    room.content = typeof content === 'string' ? content : '';

    /**
     * 关键广播逻辑：
     * - 发送者本地 textarea 已经更新，不需要再回发给自己；
     * - 使用 socket.to(roomId).emit(...) 只广播给同一房间内的其他成员；
     * - 其他成员收到后覆盖本地文本并重新执行浏览器端 Markdown 渲染；
     * - 并发策略为最后一次写入覆盖（last write wins）。
     */
    socket.to(normalizedRoomId).emit('remote-content', {
      roomId: normalizedRoomId,
      content: room.content,
      updatedBy: session.username,
    });
  });

  socket.on('disconnect', () => {
    const session = socketSessions.get(socket.id);
    if (session && session.roomId && rooms[session.roomId]) {
      const room = rooms[session.roomId];
      room.members.delete(socket.id);
      emitRoomPresence(session.roomId);
    }

    socketSessions.delete(socket.id);

    emitRoomsUpdated();
    emitSystemOverview();
  });
});

setInterval(() => {
  emitSystemOverview();
}, STATUS_PUSH_INTERVAL);

server.listen(PORT, () => {
  console.log(`Markdown collaboration server running at http://localhost:${PORT}`);
  console.log(`Admin cookie code: ${adminCookieCode}`);
});
