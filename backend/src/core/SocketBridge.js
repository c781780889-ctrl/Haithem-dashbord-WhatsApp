'use strict';
const JWTService = require('./JWTService');
let _io = null;
const rooms = new Map();

const SocketBridge = {
    init(io) {
        _io = io;
        io.on('connection', (socket) => {
            socket.on('join', (room) => {
                socket.join(room);
                rooms.set(room, (rooms.get(room) || 0) + 1);
            });
            socket.on('join_user', ({ userId, token } = {}, ack) => {
                try {
                    const payload = JWTService.verifyAccessToken(String(token || '').replace(/^Bearer\\s+/i, ''));
                    const tokenUserId = String(payload?.id || payload?.userId || '');
                    if (!userId || tokenUserId !== String(userId)) throw new Error('invalid user room');
                    const room = `user:${userId}`;
                    socket.join(room);
                    rooms.set(room, (rooms.get(room) || 0) + 1);
                    if (typeof ack === 'function') ack({ success: true });
                } catch (_) {
                    if (typeof ack === 'function') ack({ success: false });
                }
            });
            socket.on('leave', (room) => {
                socket.leave(room);
                if (rooms.has(room)) rooms.set(room, rooms.get(room) - 1);
            });
            socket.on('disconnect', () => {});
        });
    },
    emit(event, data) { if (_io) _io.emit(event, data); },
    to(room) { return _io ? _io.to(room) : { emit: () => {} }; },
    getActiveRooms() { return Object.fromEntries(rooms); },
    getTotalConnections() { return _io ? _io.engine.clientsCount : 0; },
};
module.exports = SocketBridge;
