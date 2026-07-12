// backend/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

const allowedOrigins = [
	'http://localhost:5173',
	'http://localhost:3000',
	'http://localhost:5174',
	'https://guess-it-app.onrender.com',
	'https://guess-it-1a80.onrender.com',
];
app.use(cors({ origin: allowedOrigins }));

const server = http.createServer(app);
const io = new Server(server, {
	cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
});

// --- GLOBAL GAME STATE ---
let gameState = {
	status: 'LOBBY',
	gameMaster: null,
	players: {},
	question: '',
	answer: '',
	timeRemaining: 60,
	timerInterval: null,
};

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

function broadcastState() {
	io.to('guessing_game').emit('state_update', {
		status: gameState.status,
		gameMaster: gameState.gameMaster,
		players: gameState.players,
		question: gameState.status !== 'LOBBY' ? gameState.question : null,
		timeRemaining: gameState.timeRemaining,
	});
}

function endRound(winnerId = null) {
	clearInterval(gameState.timerInterval);
	gameState.status = 'ENDED';

	const winnerName = winnerId ? gameState.players[winnerId].username : null;
	if (winnerId) {
		gameState.players[winnerId].score += 10;
	}

	// --- CHAT: Announce the winner in the chat feed ---
	io.to('guessing_game').emit('new_chat', {
		sender: 'System',
		text: winnerId
			? `🎉 ${winnerName} won the round! The correct answer was: ${gameState.answer}`
			: `⏰ Time expired! The correct answer was: ${gameState.answer}`,
		isGM: false,
		isSystem: true,
	});

	const playerIds = Object.keys(gameState.players);
	if (playerIds.length > 0) {
		const currentGmIndex = playerIds.indexOf(gameState.gameMaster);
		const nextGmIndex = (currentGmIndex + 1) % playerIds.length;
		gameState.gameMaster = playerIds[nextGmIndex];
	}

	Object.values(gameState.players).forEach((p) => (p.attempts = 3));

	io.to('guessing_game').emit('round_ended', {
		winner: winnerName,
		answer: gameState.answer,
		scoreboard: gameState.players,
	});

	broadcastState();
}

io.on('connection', (socket) => {
	socket.on('join_session', ({ username }) => {
		// NEW: Strict Input Validation
		if (!username || typeof username !== 'string' || username.trim() === '') {
			socket.emit('error_message', 'Invalid username.');
			return;
		}

		// Sanitize: Trim whitespace and limit to 20 characters
		const safeUsername = username.trim().substring(0, 20);

		if (gameState.status === 'PLAYING') {
			socket.emit(
				'error_message',
				'Game is currently in progress. Please wait.',
			);
			return;
		}

		gameState.players[socket.id] = {
			id: socket.id,
			username: safeUsername, // Use the sanitized version here
			score: 0,
			attempts: 3,
		};

		if (!gameState.gameMaster) gameState.gameMaster = socket.id;

		socket.join('guessing_game');
		broadcastState();
	});

	socket.on('start_game', ({ question, answer }) => {
		if (socket.id !== gameState.gameMaster) return;

		// NEW: Strict Input Validation
		if (
			!question ||
			typeof question !== 'string' ||
			question.trim() === '' ||
			!answer ||
			typeof answer !== 'string' ||
			answer.trim() === ''
		) {
			socket.emit('error_message', 'Question and answer must be valid text.');
			return;
		}

		if (Object.keys(gameState.players).length <= 2) {
			socket.emit('error_message', 'Need more than 2 players to start.');
			return;
		}

		gameState.status = 'PLAYING';

		// Sanitize the inputs before saving them to state
		gameState.question = question.trim();
		gameState.answer = answer.toLowerCase().trim();
		gameState.timeRemaining = 60;

		// --- CHAT: Broadcast the question as the first chat message ---
		io.to('guessing_game').emit('new_chat', {
			sender: gameState.players[socket.id].username,
			text: `🎯 Question: ${question}`,
			isGM: true,
			isSystem: false,
		});

		gameState.timerInterval = setInterval(() => {
			gameState.timeRemaining -= 1;
			io.to('guessing_game').emit('timer_update', gameState.timeRemaining);
			if (gameState.timeRemaining <= 0) endRound(null);
		}, 1000);

		broadcastState();
	});

	socket.on('submit_guess', ({ guess }) => {
		if (gameState.status !== 'PLAYING') return;

		// NEW: Strict Input Validation - Prevent server crashes from null/objects
		if (!guess || typeof guess !== 'string' || guess.trim() === '') {
			return; // Just ignore invalid guesses silently
		}

		const player = gameState.players[socket.id];
		if (!player || player.attempts <= 0) return;

		player.attempts -= 1;

		// Safely sanitize the guess
		const safeGuess = guess.trim();

		// Broadcast the safe guess to the chat
		io.to('guessing_game').emit('new_chat', {
			sender: player.username,
			text: safeGuess,
			isGM: false,
			isSystem: false,
		});

		// Safely compare
		if (safeGuess.toLowerCase() === gameState.answer) {
			endRound(socket.id);
		} else {
			socket.emit('guess_result', {
				correct: false,
				attemptsLeft: player.attempts,
			});
			broadcastState();
		}
	});

	socket.on('return_to_lobby', () => {
		if (socket.id !== gameState.gameMaster) return;
		gameState.status = 'LOBBY';
		gameState.question = '';
		gameState.answer = '';
		broadcastState();
	});

	socket.on('disconnect', () => {
		if (gameState.players[socket.id]) {
			delete gameState.players[socket.id];
			const remainingPlayers = Object.keys(gameState.players);
			if (remainingPlayers.length === 0) resetSession();
			else if (gameState.gameMaster === socket.id) {
				gameState.gameMaster = remainingPlayers[0];
				broadcastState();
			} else broadcastState();
		}
	});
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Server listening on port ${PORT}`));
