// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors({ origin: 'http://localhost:5173' }));

const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: 'http://localhost:5173', methods: ['GET', 'POST'] },
});

// --- GLOBAL GAME STATE ---
let gameState = {
	status: 'LOBBY', // 'LOBBY', 'PLAYING', 'ENDED'
	gameMaster: null,
	players: {},
	question: '',
	answer: '',
	timeRemaining: 60,
	timerInterval: null,
};

// Helper: Reset game state entirely (when everyone leaves)
function resetSession() {
	if (gameState.timerInterval) clearInterval(gameState.timerInterval);
	gameState = {
		status: 'LOBBY',
		gameMaster: null,
		players: {},
		question: '',
		answer: '',
		timeRemaining: 60,
		timerInterval: null,
	};
}

// Helper: Broadcast current lobby/game state to everyone
function broadcastState() {
	io.to('guessing_game').emit('state_update', {
		status: gameState.status,
		gameMaster: gameState.gameMaster,
		players: gameState.players,
		question: gameState.status !== 'LOBBY' ? gameState.question : null,
		timeRemaining: gameState.timeRemaining,
	});
}

// Helper: End the round
function endRound(winnerId = null) {
	clearInterval(gameState.timerInterval);
	gameState.status = 'ENDED';

	const winnerName = winnerId ? gameState.players[winnerId].username : null;
	if (winnerId) {
		gameState.players[winnerId].score += 10;
	}

	// Rotate Game Master
	const playerIds = Object.keys(gameState.players);
	if (playerIds.length > 0) {
		const currentGmIndex = playerIds.indexOf(gameState.gameMaster);
		const nextGmIndex = (currentGmIndex + 1) % playerIds.length;
		gameState.gameMaster = playerIds[nextGmIndex];
	}

	// Reset attempts for next round
	Object.values(gameState.players).forEach((p) => (p.attempts = 3));

	io.to('guessing_game').emit('round_ended', {
		winner: winnerName,
		answer: gameState.answer,
		scoreboard: gameState.players,
	});

	broadcastState();
}

io.on('connection', (socket) => {
	// 1. JOIN SESSION
	socket.on('join_session', ({ username }) => {
		if (gameState.status === 'PLAYING') {
			socket.emit(
				'error_message',
				'Game is currently in progress. Please wait.',
			);
			return;
		}

		gameState.players[socket.id] = {
			id: socket.id,
			username: username,
			score: 0,
			attempts: 3,
		};

		if (!gameState.gameMaster) {
			gameState.gameMaster = socket.id;
		}

		socket.join('guessing_game');
		broadcastState();
	});

	// 2. START GAME (GM Only)
	socket.on('start_game', ({ question, answer }) => {
		if (socket.id !== gameState.gameMaster) return;
		if (Object.keys(gameState.players).length <= 2) {
			socket.emit('error_message', 'Need more than 2 players to start.');
			return;
		}

		gameState.status = 'PLAYING';
		gameState.question = question;
		gameState.answer = answer.toLowerCase().trim();
		gameState.timeRemaining = 60;

		// Start Server Timer
		gameState.timerInterval = setInterval(() => {
			gameState.timeRemaining -= 1;
			io.to('guessing_game').emit('timer_update', gameState.timeRemaining);

			if (gameState.timeRemaining <= 0) {
				endRound(null); // Timeout, no winner
			}
		}, 1000);

		broadcastState();
	});

	// 3. SUBMIT GUESS
	socket.on('submit_guess', ({ guess }) => {
		if (gameState.status !== 'PLAYING') return;

		const player = gameState.players[socket.id];
		if (!player || player.attempts <= 0) return;

		player.attempts -= 1;

		if (guess.toLowerCase().trim() === gameState.answer) {
			endRound(socket.id); // Winner!
		} else {
			socket.emit('guess_result', {
				correct: false,
				attemptsLeft: player.attempts,
			});
			broadcastState(); // Update attempts for others to see
		}
	});

	// 4. RETURN TO LOBBY
	socket.on('return_to_lobby', () => {
		if (socket.id !== gameState.gameMaster) return;
		gameState.status = 'LOBBY';
		gameState.question = '';
		gameState.answer = '';
		broadcastState();
	});

	// 5. DISCONNECT
	socket.on('disconnect', () => {
		if (gameState.players[socket.id]) {
			delete gameState.players[socket.id];

			const remainingPlayers = Object.keys(gameState.players);
			if (remainingPlayers.length === 0) {
				resetSession();
			} else if (gameState.gameMaster === socket.id) {
				gameState.gameMaster = remainingPlayers[0];
				broadcastState();
			} else {
				broadcastState();
			}
		}
	});
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
