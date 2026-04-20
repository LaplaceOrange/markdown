const os = require('os');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_COOKIE_CODE = process.env.ADMIN_COOKIE_CODE || '1145';
const NAME_ROOM_REGEX = /^[A-Za-z\u4e00-\u9fa5]{1,20}$/;
const MAX_ROOMS_PER_USER = 3;
const STATUS_PUSH_INTERVAL = 5000;

const settings = {
  maxPerson: Math.max(1, Number(process.env.DEFAULT_MAX_PERSON) || 5),
  bannedWords: ['78', '91', 'sb'],
};

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
app.use(express.static(path.join(__dirname, 'public')));

function normalizeValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeWords(words) {
  if (!Array.isArray(words)) {
    return settings.bannedWords;
  }

  const nextWords = Array.from(
    new Set(
      words
        .map((item) => normalizeValue(item).toLowerCase())
        .filter(Boolean),
    ),
  );

  return nextWords.length ? nextWords : settings.bannedWords;
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
  return normalizeValue(req.query.admin || req.body?.admin) === ADMIN_COOKIE_CODE;
}

app.get('/api/rooms', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(serializeRoom),
    settings: getPublicSettings(),
    load: getServerLoad(),
  });
});

app.get('/api/admin/rooms', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  return res.json({
    rooms: Object.keys(rooms).map(serializeRoom),
    settings: getPublicSettings(),
    load: getServerLoad(),
  });
});

app.post('/api/admin/settings', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: '无管理员权限。' });
  }

  const nextMaxPerson = Number(req.body?.maxPerson);
  const nextBannedWords = normalizeWords(req.body?.bannedWords);

  if (!Number.isInteger(nextMaxPerson) || nextMaxPerson < 1 || nextMaxPerson > 100) {
    return res.status(400).json({ message: 'maxPerson 必须是 1 到 100 之间的整数。' });
  }

  settings.maxPerson = nextMaxPerson;
  settings.bannedWords = nextBannedWords;

  emitSettingsUpdated();

  return res.json({
    message: '管理员设置已更新。',
    settings: getPublicSettings(),
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

  socket.on('create-room', ({ username, roomId }) => {
    const normalizedUser = normalizeValue(username);
    const normalizedRoomId = normalizeValue(roomId);

    if (!isValidName(normalizedUser) || !isValidName(normalizedRoomId)) {
      return socket.emit('action-error', { message: '昵称和房间号仅支持 20 字内中英文，且不能包含违禁词。' });
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
      return socket.emit('action-error', { message: '昵称和房间号仅支持 20 字内中英文，且不能包含违禁词。' });
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
  console.log(`Admin cookie code: ${ADMIN_COOKIE_CODE}`);
});
