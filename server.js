const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const schedule = require('node-schedule');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
      origin: "*", // Be careful with this in production
      methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 6969;

const GAME_START_DELAY = 10000; // 30 seconds delay
const QUESTION_TIME = 10000; // 10 seconds
const DELAY_BETWEEN_QUESTIONS = 5000; // 3 seconds delay

let currentRoom = null;
let currentRoomCode = null;
let events = [];
let currentEvent = null;
let playerCount = 0;
let joinableFrom = null;
let joinableUntil = null;
let playerIds = new Map();
const playerTokens = new Map();

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

async function fetchAndScheduleEvents() {
  try {
    const eventsResponse = await axios.get('http://localhost:5001/brand/api/event/allevent');
    events = eventsResponse.data.events
      .filter(event => event.id_game === '66e1b64050c7195252586c66')
      .map(event => ({
        ...event,
        status: 'waiting',
        playerCount: 0
      }));

    console.log('Fetched events:', events);

    // Schedule future events
    events.forEach(event => {
      const startTime = new Date(event.thoigianbatdau);
      if (startTime > new Date()) {
        schedule.scheduleJob(startTime, () => initializeGame(event));
      }
    });

    io.emit('eventsUpdate', events);
  } catch (error) {
    console.error('Error fetching and scheduling events:', error);
  }
}

async function initializeGame(quizEvent) {
  try {
    if (quizEvent) {
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
        if (currentEvent) {
          currentEvent.status = 'hosting';
          io.emit('eventsUpdate', events);
        } else {
          console.log('Warning: currentEvent is null when trying to start the game');
        }

        console.log('Game data stored in memory:', currentRoom);
        sendQuestion(currentRoomCode);
      });

      console.log('Game scheduled to start at:', gameStartTime);
    } else {
      console.log('No Quiz event provided');
    }
  } catch (error) {
    console.error('Error initializing game:', error);
  }
}

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('joinRoom', (roomCode, userId, eventId, gameId, accessToken) => {
    // You might want to verify the accessToken and other parameters here
    console.log('Join attempt:', { roomCode, userId, eventId, gameId, accessToken });

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
      playerIds.set(socket.id, { playerId, eventId, gameId });
      playerTokens.set(playerId, accessToken);
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
      const playerId = playerIds.get(socket.id).playerId;
      
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
        const playerId = playerIds.get(socket.id).playerId;
        delete currentRoom.scores[playerId];
        playerIds.delete(socket.id);
        playerTokens.delete(playerId);
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

  socket.on('checkGameStatus', ({ userId, eventId, gameId, accessToken }) => {
    // You might want to verify the accessToken and other parameters here
    console.log('Checking game status:', { userId, eventId, gameId,accessToken });

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
          if (currentRoom) {  // Add this check
            currentRoom.currentQuestionIndex++;
          
            if (currentRoom.currentQuestionIndex < currentRoom.questions.length) {
              console.log('Sending next question');
              sendQuestion(currentRoomCode);
            } else {
              endGame();
            }
          } else {
            console.log('Game ended unexpectedly: currentRoom is null');
            endGame();
          }
        }, DELAY_BETWEEN_QUESTIONS);
      }, QUESTION_TIME);
    } else {
      console.error('Invalid question object:', question);
      io.to(currentRoomCode).emit('gameError', 'Invalid question data');
      endGame();
    }
  } else {
    console.error('Room not found or mismatch. Room code:', roomCode);
    console.error('Current room code:', currentRoomCode);
    io.to(currentRoomCode).emit('gameError', 'Game data is inconsistent. Please try rejoining the game.');
    endGame();
  }
}

async function endGame() {
  console.log('Game over, sending scores');
  const sentScores = new Set();
  const top5Players = getTop5Players(currentRoom ? currentRoom.scores : {});

  for (const [socketId, playerData] of playerIds.entries()) {
    const playerId = playerData.playerId;
    if (!sentScores.has(playerId)) {
      const playerScore = currentRoom && currentRoom.scores ? (currentRoom.scores[playerId] || 0) : 0;
      console.log(`Sending score to player ${playerId}: ${playerScore}`);
      io.to(socketId).emit('gameOver', { playerScore, leaderboard: top5Players });
      sentScores.add(playerId);

      // Get eventId and gameId from the stored player data
      const eventId = playerData.eventId;
      const gameId = playerData.gameId;

      // Print the POST request details
      console.log('POST request details for add-point API:');
      console.log('URL:', 'http://localhost:8080/users/add-point');
      console.log('Headers:', {
        'Content-Type': 'application/json; charset=UTF-8',
        'Authorization': `Bearer ${playerTokens.get(playerId)}`
      });
      console.log('Body:', JSON.stringify({
        id: playerId,
        gameId: gameId,
        eventId: eventId,
        scores: playerScore,
        point: playerScore
      }, null, 2));

      // Call the add-point API
      try {
        const response = await axios.post(
          'http://localhost:8080/users/add-point',
          {
            id: playerId,
            gameId: gameId,
            eventId: eventId,
            scores: playerScore,
            point: playerScore // Assuming 1 point per correct answer
          },
          {
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
              'Authorization': `Bearer ${playerTokens.get(playerId)}`
            }
          }
        );
        console.log(`Add-point API response for player ${playerId}:`, response.data);
      } catch (error) {
        console.error(`Error calling add-point API for player ${playerId}:`, error.message);
      }
    }
  }

  console.log('Game Over - Scores:', currentRoom ? currentRoom.scores : 'No scores available');
  if (currentEvent) {
    currentEvent.status = 'ended';
    io.emit('eventsUpdate', events);

    // Show next event info
    const nextEvent = events.find(event => new Date(event.thoigianbatdau) > new Date());
    if (nextEvent) {
      console.log('Next event:', {
        id: nextEvent.id_sukien,
        name: nextEvent.tensukien,
        startTime: nextEvent.thoigianbatdau
      });
    } else {
      console.log('No upcoming events scheduled');
    }
  } else {
    console.log('Warning: currentEvent is null at game end');
  }
  
  // Reset game state
  currentRoom = null;
  currentRoomCode = null;
  currentEvent = null;
  playerCount = 0;
  playerIds.clear();
  playerTokens.clear(); // Clear stored tokens
}

// Add this function to get the top 5 players
function getTop5Players(scores) {
  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([playerId, score]) => ({ playerId, score }));
}

// Implement rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Schedule hourly event fetching
cron.schedule('0 * * * *', () => {
  console.log('Fetching events hourly');
  fetchAndScheduleEvents();
});

server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  fetchAndScheduleEvents(); // Initial fetch and schedule
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

// You might want to implement a function to verify the access token
function verifyAccessToken(userId, eventId, gameId, accessToken) {
    // Implement your token verification logic here
    // This function should now also check if the userId, eventId, and gameId are valid
    // Return true if everything is valid, false otherwise
    // This is just a placeholder function
    console.log('Verifying:', { userId, eventId, gameId, accessToken });
    return true;
}