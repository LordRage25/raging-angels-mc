const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",") : true } });
const PORT = process.env.PORT || 3000;
const PRESIDENT_ACCESS_CODE = process.env.PRESIDENT_ACCESS_CODE;
const rooms = new Map();

app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "raging-angels-chapel", time: new Date().toISOString() }));
app.get("/api/capabilities", (_req, res) => res.json({
  clubhouse: true,
  realtimeSignalling: true,
  presidentFloorControl: true,
  speechTranslation: Boolean(process.env.TRANSLATION_API_URL && process.env.TRANSLATION_API_KEY),
  speechTranslationProviderConfigured: Boolean(process.env.TRANSLATION_API_URL && process.env.TRANSLATION_API_KEY),
  note: "Voice translation is enabled only after a supported speech/translation provider is configured."
}));

function roomState(roomName) {
  if (!rooms.has(roomName)) rooms.set(roomName, { floor: { mode: "president", speakerId: null, paused: new Set() }, members: new Map() });
  return rooms.get(roomName);
}
function publicState(state) {
  return {
    floor: { mode: state.floor.mode, speakerId: state.floor.speakerId, pausedIds: [...state.floor.paused] },
    members: [...state.members.entries()].map(([id, m]) => ({ id, name: m.name, role: m.role, language: m.language, muted: m.muted || false }))
  };
}
function emitState(roomName) {
  const state = roomState(roomName);
  io.to(roomName).emit("chapel:state", publicState(state));
}
function isPresident(socket, state) {
  return state.members.get(socket.id)?.role === "president";
}

io.on("connection", socket => {
  socket.on("chapel:join", (payload = {}, ack = () => {}) => {
    const roomName = String(payload.room || "main-chapel").slice(0, 80);
    const name = String(payload.name || "Member").slice(0, 50);
    const language = String(payload.language || "en").slice(0, 12);
    const wantsPresident = payload.role === "president";
    const presidentAuthorized = wantsPresident && PRESIDENT_ACCESS_CODE && payload.presidentCode === PRESIDENT_ACCESS_CODE;
    const state = roomState(roomName);
    const role = presidentAuthorized ? "president" : "member";
    if (role === "president" && [...state.members.values()].some(m => m.role === "president")) {
      return ack({ ok: false, error: "A President is already connected to this chapel." });
    }
    socket.join(roomName);
    socket.data.roomName = roomName;
    state.members.set(socket.id, { name, language, role, muted: false });
    ack({ ok: true, id: socket.id, role, state: publicState(state) });
    emitState(roomName);
    socket.to(roomName).emit("chapel:member-joined", { id: socket.id, name, role, language });
  });

  socket.on("chapel:request-floor", (_payload = {}, ack = () => {}) => {
    const roomName = socket.data.roomName;
    if (!roomName) return ack({ ok: false, error: "Join a chapel first." });
    const state = roomState(roomName);
    if (isPresident(socket, state)) return ack({ ok: true, message: "The President already holds the floor." });
    if (state.floor.mode !== "president" || state.floor.speakerId) return ack({ ok: false, error: "The floor is currently occupied." });
    state.floor.mode = "member";
    state.floor.speakerId = socket.id;
    state.floor.paused.delete(socket.id);
    io.to(roomName).emit("chapel:floor-granted", { speakerId: socket.id });
    emitState(roomName);
    ack({ ok: true });
  });

  socket.on("chapel:president-control", (payload = {}, ack = () => {}) => {
    const roomName = socket.data.roomName;
    if (!roomName) return ack({ ok: false, error: "Join a chapel first." });
    const state = roomState(roomName);
    if (!isPresident(socket, state)) return ack({ ok: false, error: "President permission required." });
    const action = payload.action;
    if (action === "grant" && state.members.has(payload.memberId)) {
      state.floor.mode = "member";
      state.floor.speakerId = payload.memberId;
      state.floor.paused.delete(payload.memberId);
      io.to(roomName).emit("chapel:floor-granted", { speakerId: payload.memberId });
    } else if (action === "pause" && state.members.has(payload.memberId)) {
      state.floor.paused.add(payload.memberId);
      if (state.floor.speakerId === payload.memberId) {
        state.floor.mode = "president";
        state.floor.speakerId = null;
      }
      io.to(payload.memberId).emit("chapel:microphone-paused", { reason: "The President paused your microphone." });
    } else if (action === "mute" && state.members.has(payload.memberId)) {
      const member = state.members.get(payload.memberId);
      member.muted = true;
      if (state.floor.speakerId === payload.memberId) {
        state.floor.mode = "president";
        state.floor.speakerId = null;
      }
      io.to(payload.memberId).emit("chapel:microphone-muted", { reason: "The President muted your microphone." });
    } else if (action === "unmute" && state.members.has(payload.memberId)) {
      state.members.get(payload.memberId).muted = false;
      state.floor.paused.delete(payload.memberId);
      io.to(payload.memberId).emit("chapel:microphone-restored");
    } else if (action === "return") {
      state.floor.mode = "president";
      state.floor.speakerId = null;
      io.to(roomName).emit("chapel:floor-returned", {});
    } else {
      return ack({ ok: false, error: "Unknown action or member." });
    }
    emitState(roomName);
    ack({ ok: true, state: publicState(state) });
  });

  // WebRTC signalling relay. Actual media stays on the members' encrypted WebRTC connection.
  socket.on("chapel:signal", ({ targetId, signal } = {}, ack = () => {}) => {
    const roomName = socket.data.roomName;
    const state = roomName && roomState(roomName);
    if (!state || !state.members.has(targetId)) return ack({ ok: false, error: "Target is not in this chapel." });
    const sender = state.members.get(socket.id);
    const canSpeak = sender && !sender.muted && !state.floor.paused.has(socket.id) &&
      (sender.role === "president" || (state.floor.mode === "member" && state.floor.speakerId === socket.id));
    if (signal?.kind === "media-offer" && !canSpeak) return ack({ ok: false, error: "Your microphone does not currently have the floor." });
    io.to(targetId).emit("chapel:signal", { fromId: socket.id, signal });
    ack({ ok: true });
  });

  socket.on("chapel:leave", () => leaveChapel(socket));
  socket.on("disconnect", () => leaveChapel(socket));
});

function leaveChapel(socket) {
  const roomName = socket.data.roomName;
  if (!roomName) return;
  const state = roomState(roomName);
  const member = state.members.get(socket.id);
  state.members.delete(socket.id);
  state.floor.paused.delete(socket.id);
  if (state.floor.speakerId === socket.id || member?.role === "president") {
    state.floor.mode = "president";
    state.floor.speakerId = null;
  }
  socket.to(roomName).emit("chapel:member-left", { id: socket.id });
  socket.leave(roomName);
  delete socket.data.roomName;
  emitState(roomName);
  if (state.members.size === 0) rooms.delete(roomName);
}

server.listen(PORT, "0.0.0.0", () => console.log(`Raging Angels realtime service listening on ${PORT}`));
