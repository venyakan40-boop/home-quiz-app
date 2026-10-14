const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function createCheckMap(teams) {
  const checkMap = {};
  for (let i = 0; i < teams.length; i++) {
    const checkerId = teams[i].id;
    const checkedId = teams[(i + 1) % teams.length].id;
    checkMap[checkerId] = checkedId;
  }
  return checkMap;
}

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  let currentRoomId = null;
  let currentTeamId = null;

  socket.on('createRoom', (teamName, callback) => {
    const roomCode = generateRoomCode();
    const teamId = `team_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    const room = {
      id: roomCode,
      adminId: socket.id,
      state: 'LOBBY',
      roundSettings: { questionsCount: 5, pointsPerQuestion: 10 },
      currentRoundNumber: 1,
      teams: [{ id: teamId, name: teamName, score: 0, roundScores: [] }]
    };
    
    rooms.set(roomCode, room);
    currentRoomId = roomCode;
    currentTeamId = teamId;
    
    socket.join(roomCode);
    callback({ success: true, roomCode, teamId, isAdmin: true });
  });

  socket.on('joinRoom', ({ roomCode, teamName }, callback) => {
    const room = rooms.get(roomCode);
    
    if (!room) {
      callback({ success: false, error: 'Комната не найдена' });
      return;
    }
    
    if (room.state !== 'LOBBY' && room.state !== 'RESULTS') {
      callback({ success: false, error: 'Игра уже началась или идет раунд' });
      return;
    }
    
    const teamId = `team_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    room.teams.push({ id: teamId, name: teamName, score: 0, roundScores: [] });
    
    currentRoomId = roomCode;
    currentTeamId = teamId;
    
    socket.join(roomCode);
    io.to(roomCode).emit('playerJoined', { teams: room.teams });
    callback({ success: true, teamId, isAdmin: false });
  });

  socket.on('updateRoundSettings', (settings) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.adminId !== socket.id) return;
    room.roundSettings = settings;
    io.to(currentRoomId).emit('roundSettingsUpdated', settings);
  });

  socket.on('startRound', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.adminId !== socket.id) return;
    
    room.state = 'INPUT';
    room.currentRound = {
      checkMap: createCheckMap(room.teams),
      answers: {},
      checks: {}
    };
    
    io.to(currentRoomId).emit('roundStarted', {
      roundNumber: room.currentRoundNumber,
      questionsCount: room.roundSettings.questionsCount,
      pointsPerQuestion: room.roundSettings.pointsPerQuestion
    });
  });

  socket.on('submitAnswers', (answers) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== 'INPUT') return;
    
    room.currentRound.answers[currentTeamId] = answers;
    
    const allSubmitted = room.teams.every(team => room.currentRound.answers[team.id]);
    
    if (allSubmitted) {
      room.state = 'CHECKING';
      room.teams.forEach(team => {
        const checkedTeamId = room.currentRound.checkMap[team.id];
        const answersToCheck = room.currentRound.answers[checkedTeamId];
        const checkedTeam = room.teams.find(t => t.id === checkedTeamId);
        
        io.to(team.id).emit('startChecking', {
          teamName: checkedTeam.name,
          answers: answersToCheck
        });
      });
    } else {
      const submittedCount = Object.keys(room.currentRound.answers).length;
      io.to(currentRoomId).emit('progressUpdate', { submitted: submittedCount, total: room.teams.length });
    }
  });

  socket.on('submitChecks', (checks) => {
    const room = rooms.get(currentRoomId);
    if (!room || room.state !== 'CHECKING') return;
    
    room.currentRound.checks[currentTeamId] = checks;
    
    const allChecked = room.teams.every(team => room.currentRound.checks[team.id]);
    
    if (allChecked) {
      room.teams.forEach(team => {
        const checkedTeamId = room.currentRound.checkMap[team.id];
        const checksData = room.currentRound.checks[team.id];
        const roundPoints = checksData.reduce((sum, check) => sum + check, 0) * room.roundSettings.pointsPerQuestion;
        
        const checkedTeam = room.teams.find(t => t.id === checkedTeamId);
        checkedTeam.score += roundPoints;
        checkedTeam.roundScores.push(roundPoints);
      });
      
      room.state = 'RESULTS';
      io.to(currentRoomId).emit('showResults', { teams: room.teams, roundNumber: room.currentRoundNumber });
    }
  });

  socket.on('nextRound', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.adminId !== socket.id) return;
    
    room.currentRoundNumber++;
    room.state = 'LOBBY';
    room.currentRound = null;
    io.to(currentRoomId).emit('nextRound', { teams: room.teams });
  });

  socket.on('endGame', () => {
    const room = rooms.get(currentRoomId);
    if (!room || room.adminId !== socket.id) return;
    
    io.to(currentRoomId).emit('gameEnded', { teams: room.teams });
    rooms.delete(currentRoomId);
  });

  socket.on('disconnect', () => {
    if (currentRoomId) {
      const room = rooms.get(currentRoomId);
      if (room) {
        room.teams = room.teams.filter(t => t.id !== currentTeamId);
        if (room.teams.length === 0) {
          rooms.delete(currentRoomId);
        } else {
          io.to(currentRoomId).emit('playerLeft', { teams: room.teams });
        }
      }
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});