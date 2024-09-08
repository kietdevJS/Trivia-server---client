const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const schedule = require('node-schedule');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
      origin: "*", // Be careful with this in production
      methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

const GAME_START_DELAY = 30000; // 30 seconds delay
const QUESTION_TIME = 10000; // 10 seconds
const DELAY_BETWEEN_QUESTIONS = 3000; // 3 seconds delay

let currentRoom = null;
let currentRoomCode = null;
let events = [];
let currentEvent = null;
let playerCount = 0;
let joinableFrom = null;
let joinableUntil = null;
let playerIds = new Map();

app.use(express.static('public'));

app.get('/host', (req, res) => {
  res.sendFile(__dirname + '/public/host.html');
});

app.get('/player', (req, res) => {
  res.sendFile(__dirname + '/public/player.html');
});

app.get('/player/:userId', (req, res) => {
  res.sendFile(__dirname + '/public/player.html');
});

async function initializeGame() {
  try {
    const eventsResponse = await axios.get('http://localhost:5001/brand/api/event/allevent');
    events = eventsResponse.data.events
      .filter(event => event.game_name === 'Trivia')
      .map(event => ({
        ...event,
        status: 'waiting',
        playerCount: 0
      }));

    io.emit('eventsUpdate', events);

    if (events.length > 0) {
      const quizEvent = events[0];
      const startTime = new Date(quizEvent.thoigianbatdau);
      joinableFrom = new Date(startTime.getTime() + GAME_START_DELAY);
      const gameStartTime = new Date(joinableFrom.getTime() + GAME_START_DELAY);
      joinableUntil = gameStartTime;
      currentRoomCode = generateRoomCode();
      console.log(`Generated room code: ${currentRoomCode}`);

      io.emit('roomCodeGenerated', { roomCode: currentRoomCode });

      schedule.scheduleJob(startTime, () => {
        console.log('Scheduled time reached. Joining will be allowed in 30 seconds.');
        currentEvent = quizEvent;
        currentEvent.status = 'starting';
        io.emit('eventsUpdate', events);
      });

      schedule.scheduleJob(joinableFrom, () => {
        console.log('Players can now join. Game will start in 30 seconds.');
        io.emit('gameStarting', { roomCode: currentRoomCode, startTime: gameStartTime.getTime() });
      });

      schedule.scheduleJob(gameStartTime, async () => {
        console.log('Starting the game now!');
        const questions = await fetchQuestions(quizEvent.id_sukien);
        console.log('Fetched questions for the game:', questions);
        currentRoom = {
          host: 'server',
          players: [],
          questions,
          currentQuestionIndex: 0,
          scores: {},
          answeredPlayers: []
        };
        currentEvent.status = 'hosting';
        io.emit('eventsUpdate', events);

        console.log('Game data stored in memory:', currentRoom);
        sendQuestion(currentRoomCode);
      });

      console.log('Game scheduled to start at:', gameStartTime);
    } else {
      console.log('No Quiz events found');
    }
  } catch (error) {
    console.error('Error initializing game:', error);
  }
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('joinRoom', (roomCode, userId) => {
    const now = new Date();
    console.log(`Join room attempt: ${roomCode}, Current room: ${currentRoomCode}`);
    console.log(`Current time: ${now}, Joinable from: ${joinableFrom}, Joinable until: ${joinableUntil}`);
    
    if (roomCode !== currentRoomCode) {
      console.log('Room code mismatch. Sending current room code to client.');
      socket.emit('roomCodeUpdated', { roomCode: currentRoomCode });
      return;
    }

    if (currentRoomCode === roomCode && now >= joinableFrom && now < joinableUntil) {
      socket.join(currentRoomCode);
      const playerId = userId || uuidv4().substring(0, 6).toUpperCase();
      playerIds.set(socket.id, playerId);
      if (currentRoom) {
        currentRoom.players.push(socket.id);
        currentRoom.scores[playerId] = 0;
      }
      playerCount++;
      socket.emit('roomJoined', { roomCode: currentRoomCode, playerId });
      if (currentEvent) {
        currentEvent.playerCount = playerCount;
        io.emit('eventsUpdate', events);
      }
      io.to(currentRoomCode).emit('playerJoined', { count: playerCount, playerId });
      io.emit('playerCountUpdate', playerCount);
    } else if (now < joinableFrom) {
      console.log('Room not ready yet');
      socket.emit('roomNotReady', 'The room is not ready for joining yet. Please wait.');
    } else if (now >= joinableUntil) {
      console.log('Room closed');
      socket.emit('roomClosed', 'The game has already started. You cannot join at this time.');
    } else {
      console.log('Room not found');
      socket.emit('roomNotFound');
    }
  });

  socket.on('submitAnswer', (roomCode, answer) => {
    if (currentRoomCode === roomCode && currentRoom) {
      const currentQuestion = currentRoom.questions[currentRoom.currentQuestionIndex];
      const playerId = playerIds.get(socket.id);
      
      if (!currentRoom.answeredPlayers.includes(playerId)) {
        if (answer === currentQuestion.correctAnswer) {
          const oldScore = currentRoom.scores[playerId] || 0;
          currentRoom.scores[playerId] = oldScore + 1;
          console.log(`Player ${playerId} answered correctly. Old score: ${oldScore}, New score: ${currentRoom.scores[playerId]}`);
        } else {
          console.log(`Player ${playerId} answered incorrectly. Current score: ${currentRoom.scores[playerId] || 0}`);
        }
        
        currentRoom.answeredPlayers.push(playerId);
        console.log('Updated currentRoom:', JSON.stringify(currentRoom));
        io.to(socket.id).emit('scoreUpdate', currentRoom.scores[playerId]);
      } else {
        console.log(`Player ${playerId} has already answered this question.`);
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    if (currentRoom) {
      const index = currentRoom.players.indexOf(socket.id);
      if (index !== -1) {
        currentRoom.players.splice(index, 1);
        const playerId = playerIds.get(socket.id);
        delete currentRoom.scores[playerId];
        playerIds.delete(socket.id);
        playerCount--;
        io.to(currentRoomCode).emit('playerLeft', { count: playerCount, playerId });
        io.emit('playerCountUpdate', playerCount);
      }
      if (currentRoom.players.length === 0) {
        currentRoom = null;
        currentRoomCode = null;
        playerCount = 0;
      }
    }
  });

  socket.on('requestEvents', () => {
    socket.emit('eventsUpdate', events);
  });

  socket.on('requestEventQuestions', async (eventId) => {
    const questions = await getQuestionsForEvent(eventId);
    socket.emit('eventQuestions', { eventId, questions });
  });

  socket.on('checkGameStatus', () => {
    const now = new Date();
    if (currentRoomCode && now >= joinableFrom && now < joinableUntil) {
      socket.emit('gameStarting', { roomCode: currentRoomCode, startTime: joinableUntil.getTime() });
    } else if (currentRoomCode && now < joinableFrom) {
      socket.emit('roomNotReady', 'The room is not ready for joining yet. Please wait.');
    } else if (currentEvent) {
      socket.emit('roomClosed', 'The game has already started. You cannot join at this time.');
    } else {
      socket.emit('noActiveGame', 'There is no active game at the moment.');
    }
  });

  socket.on('requestCurrentRoomCode', () => {
    socket.emit('currentRoomCode', { roomCode: currentRoomCode });
  });
});

function sendQuestion(roomCode) {
  console.log('Attempting to send question. Current room:', currentRoom);
  console.log('Current room code:', currentRoomCode);

  if (currentRoom && currentRoomCode === roomCode) {
    currentRoom.answeredPlayers = [];
    const question = currentRoom.questions[currentRoom.currentQuestionIndex];
    console.log('Current question:', question);

    if (question && question.questionText && Array.isArray(question.answers)) {
      console.log('Sending question to room:', roomCode);
      io.to(currentRoomCode).emit('newQuestion', {
        questionText: question.questionText,
        answers: question.answers
      });
      
      setTimeout(() => {
        console.log('Question time ended');
        io.to(currentRoomCode).emit('questionEnded', question.correctAnswer);
        
        setTimeout(() => {
          currentRoom.currentQuestionIndex++;
          
          if (currentRoom.currentQuestionIndex < currentRoom.questions.length) {
            console.log('Sending next question');
            sendQuestion(currentRoomCode);
          } else {
            console.log('Game over, sending scores');
            const sentScores = new Set();

            for (const [socketId, playerId] of playerIds.entries()) {
              if (!sentScores.has(playerId)) {
                const playerScore = currentRoom.scores[playerId] || 0;
                console.log(`Sending score to player ${playerId}: ${playerScore}`);
                io.to(socketId).emit('gameOver', playerScore);
                sentScores.add(playerId);
              }
            }

            console.log('Game Over - Scores:', currentRoom.scores);
            if (currentEvent) {
              currentEvent.status = 'ended';
              io.emit('eventsUpdate', events);
            }
            
            // Reset game state
            currentRoom = null;
            currentRoomCode = null;
            currentEvent = null;
            playerCount = 0;
            playerIds.clear();
          }
        }, DELAY_BETWEEN_QUESTIONS);
      }, QUESTION_TIME);
    } else {
      console.error('Invalid question object:', question);
      io.to(currentRoomCode).emit('gameError', 'Invalid question data');
    }
  } else {
    console.error('Room not found or mismatch. Room code:', roomCode);
    console.error('Current room code:', currentRoomCode);
    io.to(currentRoomCode).emit('gameError', 'Game data is inconsistent. Please try rejoining the game.');
  }
}

// Implement rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  initializeGame();
});

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function fetchQuestions(eventId) {
  try {
    const response = await axios.get(`http://localhost:5001/brand/api/event/fetchquestion/${eventId}`);
    const data = response.data;
    
    console.log('Fetched questions data:', data);

    if (!data.success || !Array.isArray(data._questions)) {
      console.error('Invalid API response structure:', data);
      return [];
    }
    
    const formattedQuestions = data._questions.map(question => ({
      questionText: question.questionText,
      answers: question.answers,
      correctAnswer: question.correctAnswer
    }));

    console.log('Formatted questions:', formattedQuestions);
    return formattedQuestions;
  } catch (error) {
    console.error('Error fetching questions:', error);
    return [];
  }
}

async function getQuestionsForEvent(eventId) {
  try {
    const questions = await fetchQuestions(eventId);
    return questions.map(q => ({
      questionText: q.questionText,
      answerCount: q.answers.length
    }));
  } catch (error) {
    console.error('Error fetching questions for event:', error);
    return [];
  }
}