import React, { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = {
	id: string;
	username: string;
	score: number;
	attempts: number;
};

type GameState = {
	status: string;
	gameMaster: string | null;
	players: Record<string, Player>;
	question: string;
	timeRemaining: number;
};

type EndData = {
	winner: string | null;
	answer: string;
	scoreboard: Record<string, Player>;
};

const socket: Socket = io('http://localhost:4000', { autoConnect: false });

export default function App() {
	const [username, setUsername] = useState('');
	const [hasJoined, setHasJoined] = useState(false);
	const [error, setError] = useState('');

	// Game State
	const [gameState, setGameState] = useState<GameState>({
		status: 'LOBBY',
		gameMaster: null,
		players: {},
		question: '',
		timeRemaining: 0,
	});

	const [endData, setEndData] = useState<EndData | null>(null);

	// Form States
	const [qInput, setQInput] = useState('');
	const [aInput, setAInput] = useState('');
	const [guessInput, setGuessInput] = useState('');

	useEffect(() => {
		socket.connect();

		socket.on('state_update', (state) => {
			setGameState(state);
			if (state.status === 'LOBBY') setEndData(null);
		});

		socket.on('timer_update', (time) => {
			setGameState((prev) => ({ ...prev, timeRemaining: time }));
		});

		socket.on('round_ended', (data) => {
			setEndData(data);
		});

		socket.on('error_message', (msg) => {
			alert(msg);
		});

		socket.on('guess_result', (res) => {
			if (!res.correct)
				setError(`Incorrect! ${res.attemptsLeft} attempts left.`);
		});

		return () => {
			socket.removeAllListeners();
			socket.disconnect();
		};
	}, []);

	const handleJoin = (e: React.FormEvent) => {
		e.preventDefault();
		if (!username.trim()) return;
		socket.emit('join_session', { username });
		setHasJoined(true);
	};

	const handleStart = (e: React.FormEvent) => {
		e.preventDefault();
		if (!qInput || !aInput) return;
		socket.emit('start_game', { question: qInput, answer: aInput });
		setQInput('');
		setAInput('');
	};

	const handleGuess = (e: React.FormEvent) => {
		e.preventDefault();
		if (!guessInput.trim()) return;
		socket.emit('submit_guess', { guess: guessInput });
		setGuessInput('');
		setError('');
	};

	const handleReturnLobby = () => {
		socket.emit('return_to_lobby');
	};

	const me = gameState.players[socket.id || ''];
	const isGM = socket.id === gameState.gameMaster;
	const playerCount = Object.keys(gameState.players).length;

	// --- UI: LOGIN SCREEN ---
	if (!hasJoined) {
		return (
			<div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
				<h2>Live Guessing Game</h2>
				<form onSubmit={handleJoin}>
					<input
						placeholder='Enter your name'
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						style={{ padding: '0.5rem' }}
					/>
					<button
						type='submit'
						style={{ padding: '0.5rem 1rem', marginLeft: '0.5rem' }}
					>
						Join Game
					</button>
				</form>
			</div>
		);
	}

	// --- UI: LOBBY SCREEN ---
	if (gameState.status === 'LOBBY') {
		return (
			<div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
				<h2>Game Lobby</h2>
				<p>Players Connected: {playerCount} / Requires &gt; 2</p>
				<ul>
					{Object.values(gameState.players).map((p) => (
						<li key={p.id}>
							{p.username}{' '}
							{p.id === gameState.gameMaster ? '👑 (Game Master)' : ''} - Score:{' '}
							{p.score}
						</li>
					))}
				</ul>

				{isGM ? (
					<div
						style={{
							marginTop: '2rem',
							border: '1px solid #ccc',
							padding: '1rem',
						}}
					>
						<h3>You are the Game Master!</h3>
						<form onSubmit={handleStart}>
							<input
								placeholder='Question'
								value={qInput}
								onChange={(e) => setQInput(e.target.value)}
								required
								style={{
									display: 'block',
									marginBottom: '10px',
									padding: '5px',
									width: '300px',
								}}
							/>
							<input
								placeholder='Answer'
								value={aInput}
								onChange={(e) => setAInput(e.target.value)}
								required
								style={{
									display: 'block',
									marginBottom: '10px',
									padding: '5px',
									width: '300px',
								}}
							/>
							<button
								disabled={playerCount <= 2}
								type='submit'
							>
								Start Game
							</button>
							{playerCount <= 2 && (
								<p style={{ color: 'red', fontSize: '0.8rem' }}>
									Need more than 2 players to start
								</p>
							)}
						</form>
					</div>
				) : (
					<p style={{ marginTop: '2rem', fontStyle: 'italic' }}>
						Waiting for the Game Master to start the game...
					</p>
				)}
			</div>
		);
	}

	// --- UI: ENDED SCREEN ---
	if (gameState.status === 'ENDED' && endData) {
		return (
			<div
				style={{
					padding: '2rem',
					fontFamily: 'sans-serif',
					textAlign: 'center',
				}}
			>
				<h2>Round Over!</h2>
				{endData.winner ? (
					<h3 style={{ color: 'green' }}>
						{endData.winner} won the round! (+10 points)
					</h3>
				) : (
					<h3 style={{ color: 'red' }}>Time expired! No one won.</h3>
				)}
				<p>
					The correct answer was: <strong>{endData.answer}</strong>
				</p>

				<h4 style={{ marginTop: '2rem' }}>Scoreboard</h4>
				<ul style={{ listStyle: 'none', padding: 0 }}>
					{Object.values(endData.scoreboard).map((p: Player) => (
						<li key={p.id}>
							{p.username}: {p.score} pts
						</li>
					))}
				</ul>

				{isGM ? (
					<button
						onClick={handleReturnLobby}
						style={{ padding: '1rem', marginTop: '1rem' }}
					>
						Return to Lobby to create next Question
					</button>
				) : (
					<p style={{ marginTop: '2rem' }}>
						Waiting for the new Game Master to setup the lobby...
					</p>
				)}
			</div>
		);
	}

	// --- UI: PLAYING SCREEN ---
	return (
		<div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
			<h2>Game in Progress!</h2>
			<h1 style={{ color: 'red' }}>
				Time Remaining: {gameState.timeRemaining}s
			</h1>

			<div
				style={{
					margin: '2rem 0',
					padding: '1.5rem',
					background: '#f0f0f0',
					borderRadius: '8px',
				}}
			>
				<h3>Question: {gameState.question}</h3>
			</div>

			{isGM ? (
				<p>You are the Game Master. Watch the players guess!</p>
			) : (
				<div>
					{me?.attempts > 0 ? (
						<form onSubmit={handleGuess}>
							<input
								placeholder='Your guess...'
								value={guessInput}
								onChange={(e) => setGuessInput(e.target.value)}
								style={{ padding: '0.5rem', width: '250px' }}
							/>
							<button
								type='submit'
								style={{ padding: '0.5rem 1rem', marginLeft: '0.5rem' }}
							>
								Submit Guess
							</button>
							{error && <p style={{ color: 'red' }}>{error}</p>}
							<p>Attempts remaining: {me.attempts}</p>
						</form>
					) : (
						<p style={{ color: 'red', fontWeight: 'bold' }}>
							You are out of attempts! Waiting for others...
						</p>
					)}
				</div>
			)}
		</div>
	);
}
