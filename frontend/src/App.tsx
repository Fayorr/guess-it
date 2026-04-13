import React, { useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

type Player = { id: string; username: string; score: number; attempts: number };
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
type ChatMsg = {
	sender: string;
	text: string;
	isGM: boolean;
	isSystem: boolean;
};

// REMEMBER: Update this to your deployed backend URL when going live!
const socket: Socket = io('https://guess-it-1a80.onrender.com', {
	autoConnect: false,
});

export default function App() {
	const [username, setUsername] = useState('');
	const [hasJoined, setHasJoined] = useState(false);
	const [error, setError] = useState('');
	const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);

	// Auto-scroll ref for chat
	const chatEndRef = useRef<HTMLDivElement>(null);

	const [gameState, setGameState] = useState<GameState>({
		status: 'LOBBY',
		gameMaster: null,
		players: {},
		question: '',
		timeRemaining: 0,
	});
	const [endData, setEndData] = useState<EndData | null>(null);

	const [qInput, setQInput] = useState('');
	const [aInput, setAInput] = useState('');
	const [guessInput, setGuessInput] = useState('');

	useEffect(() => {
		socket.connect();

		socket.on('state_update', (state) => {
			setGameState(state);
			if (state.status === 'LOBBY') {
				setEndData(null);
				setChatMessages([]); // Clear chat for a new game
			}
		});

		socket.on('timer_update', (time) =>
			setGameState((prev) => ({ ...prev, timeRemaining: time })),
		);
		socket.on('round_ended', (data) => setEndData(data));
		socket.on('error_message', (msg) => alert(msg));

		socket.on('guess_result', (res) => {
			if (!res.correct)
				setError(`Incorrect! ${res.attemptsLeft} attempts left.`);
		});

		// --- CHAT LISTENER ---
		socket.on('new_chat', (msg: ChatMsg) => {
			setChatMessages((prev) => [...prev, msg]);
		});

		return () => {
			socket.removeAllListeners();
			socket.disconnect();
		};
	}, []);

	// Auto-scroll to bottom of chat when new message arrives
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [chatMessages]);

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

	const me = gameState.players[socket.id || ''];
	const isGM = socket.id === gameState.gameMaster;
	const playerCount = Object.keys(gameState.players).length;

	// --- UI: LOGIN SCREEN ---
	if (!hasJoined) {
		return (
			<div
				style={{
					padding: '2rem',
					fontFamily: 'sans-serif',
					maxWidth: '500px',
					margin: '0 auto',
				}}
			>
				<h2>Live Guessing Game</h2>
				<form
					onSubmit={handleJoin}
					style={{ display: 'flex', gap: '10px' }}
				>
					<input
						placeholder='Enter your name'
						value={username}
						onChange={(e) => setUsername(e.target.value)}
						style={{ padding: '0.8rem', flex: 1 }}
					/>
					<button
						type='submit'
						style={{ padding: '0.8rem' }}
					>
						Join
					</button>
				</form>
			</div>
		);
	}

	// --- UI: LOBBY SCREEN ---
	if (gameState.status === 'LOBBY') {
		return (
			<div
				style={{
					padding: '2rem',
					fontFamily: 'sans-serif',
					maxWidth: '600px',
					margin: '0 auto',
				}}
			>
				<h2>Lobby</h2>
				<p>
					Players: <strong>{playerCount}</strong> (Requires {'>'} 2)
				</p>
				<div
					style={{
						background: '#f5f5f5',
						padding: '1rem',
						borderRadius: '8px',
						marginBottom: '2rem',
					}}
				>
					<ul style={{ listStyle: 'none', padding: 0 }}>
						{Object.values(gameState.players).map((p) => (
							<li
								key={p.id}
								style={{
									padding: '8px 0',
									borderBottom: '1px solid #ddd',
									color: p.id === gameState.gameMaster ? '#d4af37' : 'black',
									fontWeight: p.id === gameState.gameMaster ? 'bold' : 'normal',
								}}
							>
								{p.id === gameState.gameMaster ? '👑 ' : ''} {p.username}{' '}
								(Score: {p.score})
							</li>
						))}
					</ul>
				</div>

				{isGM ? (
					<div
						style={{
							border: '2px solid #d4af37',
							padding: '1.5rem',
							borderRadius: '8px',
							background: '#fffcf2',
						}}
					>
						<h3 style={{ marginTop: 0, color: '#b5952f' }}>
							👑 Game Master Panel
						</h3>
						<form
							onSubmit={handleStart}
							style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
						>
							<input
								placeholder='Ask a Question'
								value={qInput}
								onChange={(e) => setQInput(e.target.value)}
								required
								style={{ padding: '0.8rem' }}
							/>
							<input
								placeholder='Correct Answer'
								value={aInput}
								onChange={(e) => setAInput(e.target.value)}
								required
								style={{ padding: '0.8rem' }}
							/>
							<button
								disabled={playerCount <= 2}
								type='submit'
								style={{
									padding: '1rem',
									background: playerCount <= 2 ? '#ccc' : '#d4af37',
									color: 'white',
									border: 'none',
									fontWeight: 'bold',
								}}
							>
								Start Game
							</button>
							{playerCount <= 2 && (
								<small style={{ color: 'red' }}>
									Waiting for more players...
								</small>
							)}
						</form>
					</div>
				) : (
					<p style={{ fontStyle: 'italic', textAlign: 'center' }}>
						Waiting for the Game Master to start...
					</p>
				)}
			</div>
		);
	}

	// --- UI: CHAT/PLAYING INTERFACE ---
	return (
		<div
			style={{
				padding: '1rem',
				fontFamily: 'sans-serif',
				maxWidth: '600px',
				margin: '0 auto',
				height: '90vh',
				display: 'flex',
				flexDirection: 'column',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					background: '#222' /* Dark background so the white text is visible */,
					padding: '15px 20px',
					borderRadius: '8px',
					marginBottom: '15px',
					boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
				}}
			>
				<h3 style={{ margin: 0, color: '#fff' }}>
					{gameState.status === 'ENDED' ? 'Round Over' : 'Live Game'}
				</h3>

				{/* THE TIMER LOGIC */}
				<h2
					style={{
						margin: 0,
						color:
							gameState.timeRemaining <= 10
								? '#ff4444'
								: 'white' /* Red at 10s, White otherwise */,
						fontWeight: 'bold',
						textShadow:
							gameState.timeRemaining <= 10
								? '0 0 8px rgba(255,0,0,0.5)'
								: 'none' /* Optional glowing effect when red! */,
					}}
				>
					{gameState.timeRemaining}s
				</h2>
			</div>

			{/* Chat History Window */}
			<div
				style={{
					flex: 1,
					background: '#f9f9f9',
					borderRadius: '8px',
					padding: '1rem',
					overflowY: 'auto',
					display: 'flex',
					flexDirection: 'column',
					gap: '10px',
					border: '1px solid #ddd',
				}}
			>
				{chatMessages.map((msg, i) => {
					const isMe = msg.sender === me?.username;
					return (
						<div
							key={i}
							style={{
								alignSelf: msg.isSystem
									? 'center'
									: isMe
										? 'flex-end'
										: 'flex-start',
								background: msg.isSystem
									? '#ffe5b4'
									: msg.isGM
										? '#fffcf2'
										: isMe
											? '#dcf8c6'
											: '#fff',
								border: msg.isGM ? '1px solid #d4af37' : '1px solid #eee',
								padding: '10px 15px',
								borderRadius: '15px',
								maxWidth: '75%',
								boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
							}}
						>
							{!msg.isSystem && (
								<small
									style={{
										display: 'block',
										fontWeight: 'bold',
										marginBottom: '4px',
										color: msg.isGM ? '#b5952f' : '#555',
									}}
								>
									{msg.isGM && '👑 '} {msg.sender}
								</small>
							)}
							<span style={{ fontWeight: msg.isSystem ? 'bold' : 'normal' }}>
								{msg.text}
							</span>
						</div>
					);
				})}
				<div ref={chatEndRef} />
			</div>

			{/* Controls (Input or End Screen) */}
			<div style={{ paddingTop: '15px' }}>
				{gameState.status === 'ENDED' ? (
					<div
						style={{
							textAlign: 'center',
							background: '#eef',
							padding: '1rem',
							borderRadius: '8px',
						}}
					>
						<h4>Scoreboard</h4>
						<div
							style={{
								display: 'flex',
								justifyContent: 'center',
								gap: '15px',
								flexWrap: 'wrap',
								marginBottom: '15px',
							}}
						>
							{Object.values(endData?.scoreboard || {}).map((p: Player) => (
								<span
									key={p.id}
									style={{
										background: 'white',
										padding: '5px 10px',
										borderRadius: '15px',
										border: '1px solid #ccc',
									}}
								>
									{p.username}: <strong>{p.score}</strong>
								</span>
							))}
						</div>
						{isGM ? (
							<button
								onClick={() => socket.emit('return_to_lobby')}
								style={{
									padding: '0.8rem 1.5rem',
									background: '#333',
									color: 'white',
									border: 'none',
									borderRadius: '5px',
									width: '100%',
								}}
							>
								Return to Lobby
							</button>
						) : (
							<p style={{ margin: 0 }}>Waiting for Game Master...</p>
						)}
					</div>
				) : isGM ? (
					<p style={{ textAlign: 'center', color: '#888' }}>
						You are the Game Master. Watch them guess!
					</p>
				) : (
					<form
						onSubmit={handleGuess}
						style={{ display: 'flex', gap: '10px' }}
					>
						<input
							placeholder={
								me?.attempts > 0 ? 'Type your guess...' : 'Out of attempts!'
							}
							value={guessInput}
							onChange={(e) => setGuessInput(e.target.value)}
							disabled={me?.attempts <= 0}
							style={{
								flex: 1,
								padding: '1rem',
								borderRadius: '25px',
								border: '1px solid #ccc',
							}}
						/>
						<button
							type='submit'
							disabled={me?.attempts <= 0}
							style={{
								padding: '1rem 1.5rem',
								borderRadius: '25px',
								background: me?.attempts > 0 ? '#007bff' : '#ccc',
								color: 'white',
								border: 'none',
							}}
						>
							Send
						</button>
					</form>
				)}
				{error && gameState.status === 'PLAYING' && (
					<p
						style={{
							color: 'red',
							textAlign: 'center',
							margin: '5px 0 0 0',
							fontSize: '0.9rem',
						}}
					>
						{error}
					</p>
				)}
			</div>
		</div>
	);
}
