import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

type Player = { id: string; username: string; score: number; attempts: number };
type GameState = {
	status: 'LOBBY' | 'PLAYING' | 'ENDED';
	gameMaster: string | null;
	players: Record<string, Player>;
	question: string;
	roundEndsAt: number | null;
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
type ClientMessage =
	| { type: 'join_session'; payload: { username: string } }
	| { type: 'start_game'; payload: { question: string; answer: string } }
	| { type: 'submit_guess'; payload: { guess: string } }
	| { type: 'return_to_lobby' };
type ServerMessage =
	| { type: 'connected'; payload: { playerId: string } }
	| { type: 'joined'; payload: { playerId: string; username: string } }
	| { type: 'state_update'; payload: GameState }
	| { type: 'new_chat'; payload: ChatMsg }
	| { type: 'round_ended'; payload: EndData }
	| {
			type: 'guess_result';
			payload: { correct: boolean; attemptsLeft: number };
	  }
	| { type: 'error_message'; payload: { message: string } };
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const initialGameState: GameState = {
	status: 'LOBBY',
	gameMaster: null,
	players: {},
	question: '',
	roundEndsAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlayer(value: unknown): value is Player {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		typeof value.username === 'string' &&
		typeof value.score === 'number' &&
		typeof value.attempts === 'number'
	);
}

function isPlayerMap(value: unknown): value is Record<string, Player> {
	return isRecord(value) && Object.values(value).every(isPlayer);
}

function isGameState(value: unknown): value is GameState {
	return (
		isRecord(value) &&
		(value.status === 'LOBBY' ||
			value.status === 'PLAYING' ||
			value.status === 'ENDED') &&
		(value.gameMaster === null || typeof value.gameMaster === 'string') &&
		isPlayerMap(value.players) &&
		typeof value.question === 'string' &&
		(value.roundEndsAt === null || typeof value.roundEndsAt === 'number')
	);
}

function isChatMessage(value: unknown): value is ChatMsg {
	return (
		isRecord(value) &&
		typeof value.sender === 'string' &&
		typeof value.text === 'string' &&
		typeof value.isGM === 'boolean' &&
		typeof value.isSystem === 'boolean'
	);
}

function isEndData(value: unknown): value is EndData {
	return (
		isRecord(value) &&
		(value.winner === null || typeof value.winner === 'string') &&
		typeof value.answer === 'string' &&
		isPlayerMap(value.scoreboard)
	);
}

function parseServerMessage(raw: string): ServerMessage | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.payload)) {
		return null;
	}

	switch (value.type) {
		case 'connected':
			return typeof value.payload.playerId === 'string'
				? { type: value.type, payload: { playerId: value.payload.playerId } }
				: null;
		case 'joined':
			return typeof value.payload.playerId === 'string' &&
				typeof value.payload.username === 'string'
				? {
						type: value.type,
						payload: {
							playerId: value.payload.playerId,
							username: value.payload.username,
						},
					}
				: null;
		case 'state_update':
			return isGameState(value.payload)
				? { type: value.type, payload: value.payload }
				: null;
		case 'new_chat':
			return isChatMessage(value.payload)
				? { type: value.type, payload: value.payload }
				: null;
		case 'round_ended':
			return isEndData(value.payload)
				? { type: value.type, payload: value.payload }
				: null;
		case 'guess_result':
			return typeof value.payload.correct === 'boolean' &&
				typeof value.payload.attemptsLeft === 'number'
				? {
						type: value.type,
						payload: {
							correct: value.payload.correct,
							attemptsLeft: value.payload.attemptsLeft,
						},
					}
				: null;
		case 'error_message':
			return typeof value.payload.message === 'string'
				? { type: value.type, payload: { message: value.payload.message } }
				: null;
		default:
			return null;
	}
}

function getSessionId(): string {
	const storageKey = 'guess-it-session-id';
	const existing = window.sessionStorage.getItem(storageKey);
	if (existing) return existing;

	const sessionId = crypto.randomUUID();
	window.sessionStorage.setItem(storageKey, sessionId);
	return sessionId;
}

function createWebSocketTarget(): { url: string | null; error: string | null } {
	try {
		const configuredBackend = import.meta.env.VITE_BACKEND_URL?.trim();
		const baseUrl =
			configuredBackend ||
			(import.meta.env.DEV ? 'http://localhost:8787' : window.location.origin);
		const url = new URL('/ws', baseUrl);
		if (url.protocol === 'https:') url.protocol = 'wss:';
		if (url.protocol === 'http:') url.protocol = 'ws:';
		url.searchParams.set('room', import.meta.env.VITE_GAME_ROOM?.trim() || 'main');
		url.searchParams.set('session', getSessionId());
		return { url: url.toString(), error: null };
	} catch {
		return {
			url: null,
			error: 'The backend URL is invalid. Check VITE_BACKEND_URL.',
		};
	}
}

export default function App() {
	const [webSocketTarget] = useState(createWebSocketTarget);
	const socketRef = useRef<WebSocket | null>(null);
	const chatEndRef = useRef<HTMLDivElement>(null);
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>(webSocketTarget.url ? 'connecting' : 'disconnected');
	const [playerId, setPlayerId] = useState<string | null>(null);
	const [username, setUsername] = useState('');
	const [hasJoined, setHasJoined] = useState(false);
	const [joinPending, setJoinPending] = useState(false);
	const [error, setError] = useState(webSocketTarget.error ?? '');
	const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
	const [gameState, setGameState] = useState<GameState>(initialGameState);
	const [endData, setEndData] = useState<EndData | null>(null);
	const [qInput, setQInput] = useState('');
	const [aInput, setAInput] = useState('');
	const [guessInput, setGuessInput] = useState('');
	const [clock, setClock] = useState(() => Date.now());

	useEffect(() => {
		if (!webSocketTarget.url) return;
		const socket = new WebSocket(webSocketTarget.url);

		socketRef.current = socket;
		socket.addEventListener('open', () => {
			setConnectionStatus('connected');
			setError('');
		});
		socket.addEventListener('message', (event: MessageEvent<string>) => {
			const message = parseServerMessage(event.data);
			if (!message) return;

			switch (message.type) {
				case 'connected':
					setPlayerId(message.payload.playerId);
					break;
				case 'joined':
					setPlayerId(message.payload.playerId);
					setUsername(message.payload.username);
					setHasJoined(true);
					setJoinPending(false);
					setError('');
					break;
				case 'state_update':
					setGameState(message.payload);
					setClock(Date.now());
					if (message.payload.status === 'LOBBY') {
						setEndData(null);
						setChatMessages([]);
					}
					break;
				case 'new_chat':
					setChatMessages((previous) => [...previous, message.payload]);
					break;
				case 'round_ended':
					setEndData(message.payload);
					break;
				case 'guess_result':
					if (!message.payload.correct) {
						setError(
							`Incorrect! ${message.payload.attemptsLeft} attempts left.`,
						);
					}
					break;
				case 'error_message':
					setJoinPending(false);
					setError(message.payload.message);
					break;
			}
		});
		socket.addEventListener('close', () => {
			setConnectionStatus('disconnected');
			setJoinPending(false);
			setError('Connection to the game server was lost. Refresh to reconnect.');
		});
		socket.addEventListener('error', () => {
			setError('Could not connect to the game server.');
		});

		return () => {
			socketRef.current = null;
			socket.close(1000, 'Page closed');
		};
	}, [webSocketTarget.url]);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	}, [chatMessages]);

	useEffect(() => {
		if (gameState.status !== 'PLAYING' || gameState.roundEndsAt === null) return;

		const interval = window.setInterval(() => setClock(Date.now()), 250);
		return () => window.clearInterval(interval);
	}, [gameState.roundEndsAt, gameState.status]);

	const sendMessage = (message: ClientMessage): boolean => {
		const socket = socketRef.current;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			setError('The game server is not connected.');
			return false;
		}

		socket.send(JSON.stringify(message));
		return true;
	};

	const handleJoin = (event: FormEvent) => {
		event.preventDefault();
		if (!username.trim()) return;
		if (sendMessage({ type: 'join_session', payload: { username } })) {
			setJoinPending(true);
			setError('');
		}
	};

	const handleStart = (event: FormEvent) => {
		event.preventDefault();
		if (!qInput.trim() || !aInput.trim()) return;
		if (
			sendMessage({
				type: 'start_game',
				payload: { question: qInput, answer: aInput },
			})
		) {
			setQInput('');
			setAInput('');
			setError('');
		}
	};

	const handleGuess = (event: FormEvent) => {
		event.preventDefault();
		if (!guessInput.trim()) return;
		if (
			sendMessage({ type: 'submit_guess', payload: { guess: guessInput } })
		) {
			setGuessInput('');
			setError('');
		}
	};

	const me = playerId ? gameState.players[playerId] : undefined;
	const isGM = playerId !== null && playerId === gameState.gameMaster;
	const playerCount = Object.keys(gameState.players).length;
	const timeRemaining =
		gameState.status === 'PLAYING' && gameState.roundEndsAt !== null
			? Math.max(0, Math.ceil((gameState.roundEndsAt - clock) / 1000))
			: 0;

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
				<form onSubmit={handleJoin} style={{ display: 'flex', gap: '10px' }}>
					<input
						placeholder='Enter your name'
						value={username}
						onChange={(event) => setUsername(event.target.value)}
						maxLength={20}
						style={{ padding: '0.8rem', flex: 1 }}
					/>
					<button
						type='submit'
						disabled={connectionStatus !== 'connected' || joinPending}
						style={{ padding: '0.8rem' }}
					>
						{joinPending ? 'Joining...' : 'Join'}
					</button>
				</form>
				<p style={{ marginTop: '12px', fontSize: '0.85rem' }}>
					Server: {connectionStatus}
				</p>
				{error && <p style={{ color: 'red', marginTop: '12px' }}>{error}</p>}
			</div>
		);
	}

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
						{Object.values(gameState.players).map((player) => (
							<li
								key={player.id}
								style={{
									padding: '8px 0',
									borderBottom: '1px solid #ddd',
									color:
										player.id === gameState.gameMaster ? '#d4af37' : 'black',
									fontWeight:
										player.id === gameState.gameMaster ? 'bold' : 'normal',
								}}
							>
								{player.id === gameState.gameMaster ? '👑 ' : ''}{' '}
								{player.username} (Score: {player.score})
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
								onChange={(event) => setQInput(event.target.value)}
								maxLength={240}
								required
								style={{ padding: '0.8rem' }}
							/>
							<input
								placeholder='Correct Answer'
								value={aInput}
								onChange={(event) => setAInput(event.target.value)}
								maxLength={120}
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
								<small style={{ color: 'red' }}>Waiting for more players...</small>
							)}
						</form>
					</div>
				) : (
					<p style={{ fontStyle: 'italic', textAlign: 'center' }}>
						Waiting for the Game Master to start...
					</p>
				)}
				{error && <p style={{ color: 'red', marginTop: '12px' }}>{error}</p>}
			</div>
		);
	}

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
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					background: '#222',
					padding: '15px 20px',
					borderRadius: '8px',
					marginBottom: '15px',
					boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
				}}
			>
				<h3 style={{ margin: 0, color: '#fff' }}>
					{gameState.status === 'ENDED' ? 'Round Over' : 'Live Game'}
				</h3>
				<h2
					style={{
						margin: 0,
						color: timeRemaining <= 10 ? '#ff4444' : 'white',
						fontWeight: 'bold',
						textShadow:
							timeRemaining <= 10 ? '0 0 8px rgba(255,0,0,0.5)' : 'none',
					}}
				>
					{timeRemaining}s
				</h2>
			</div>
			{gameState.status === 'PLAYING' && (
				<div
					style={{
						background: '#fffcf2',
						border: '1px solid #d4af37',
						borderRadius: '8px',
						padding: '10px 14px',
						marginBottom: '15px',
						color: '#5f4c12',
						fontWeight: 'bold',
					}}
				>
					{gameState.question}
				</div>
			)}

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
				{chatMessages.map((message, index) => {
					const isMe = message.sender === me?.username;
					return (
						<div
							key={`${index}-${message.sender}-${message.text}`}
							style={{
								alignSelf: message.isSystem
									? 'center'
									: isMe
										? 'flex-end'
										: 'flex-start',
								background: message.isSystem
									? '#ffe5b4'
									: message.isGM
										? '#fffcf2'
										: isMe
											? '#dcf8c6'
											: '#fff',
								border: message.isGM
									? '1px solid #d4af37'
									: '1px solid #eee',
								padding: '10px 15px',
								borderRadius: '15px',
								maxWidth: '75%',
								boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
							}}
						>
							{!message.isSystem && (
								<small
									style={{
										display: 'block',
										fontWeight: 'bold',
										marginBottom: '4px',
										color: message.isGM ? '#b5952f' : '#555',
									}}
								>
									{message.isGM && '👑 '} {message.sender}
								</small>
							)}
							<span style={{ fontWeight: message.isSystem ? 'bold' : 'normal' }}>
								{message.text}
							</span>
						</div>
					);
				})}
				<div ref={chatEndRef} />
			</div>

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
							{Object.values(endData?.scoreboard ?? {}).map((player) => (
								<span
									key={player.id}
									style={{
										background: 'white',
										padding: '5px 10px',
										borderRadius: '15px',
										border: '1px solid #ccc',
									}}
								>
									{player.username}: <strong>{player.score}</strong>
								</span>
							))}
						</div>
						{isGM ? (
							<button
								onClick={() => sendMessage({ type: 'return_to_lobby' })}
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
					<form onSubmit={handleGuess} style={{ display: 'flex', gap: '10px' }}>
						<input
							placeholder={
								(me?.attempts ?? 0) > 0
									? 'Type your guess...'
									: 'Out of attempts!'
							}
							value={guessInput}
							onChange={(event) => setGuessInput(event.target.value)}
							maxLength={120}
							disabled={(me?.attempts ?? 0) <= 0}
							style={{
								flex: 1,
								padding: '1rem',
								borderRadius: '25px',
								border: '1px solid #ccc',
							}}
						/>
						<button
							type='submit'
							disabled={(me?.attempts ?? 0) <= 0}
							style={{
								padding: '1rem 1.5rem',
								borderRadius: '25px',
								background: (me?.attempts ?? 0) > 0 ? '#007bff' : '#ccc',
								color: 'white',
								border: 'none',
							}}
						>
							Send
						</button>
					</form>
				)}
				{error && (
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
