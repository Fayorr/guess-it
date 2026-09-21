import { DurableObject } from 'cloudflare:workers';

const ROUND_DURATION_MS = 60_000;
const MAX_MESSAGE_BYTES = 4_096;
const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type GameStatus = 'LOBBY' | 'PLAYING' | 'ENDED';

type Player = {
	id: string;
	username: string;
	score: number;
	attempts: number;
};

type StoredGameState = {
	status: GameStatus;
	gameMaster: string | null;
	players: Record<string, Player>;
	question: string;
	answer: string;
	roundEndsAt: number | null;
};

type PublicGameState = Omit<StoredGameState, 'answer'>;

type ChatMessage = {
	sender: string;
	text: string;
	isGM: boolean;
	isSystem: boolean;
};

type SessionAttachment = {
	playerId: string;
	username: string | null;
};

type ClientMessage =
	| { type: 'join_session'; payload: { username: string } }
	| { type: 'start_game'; payload: { question: string; answer: string } }
	| { type: 'submit_guess'; payload: { guess: string } }
	| { type: 'return_to_lobby' };

type ServerMessage =
	| { type: 'connected'; payload: { playerId: string } }
	| { type: 'joined'; payload: { playerId: string; username: string } }
	| { type: 'state_update'; payload: PublicGameState }
	| { type: 'new_chat'; payload: ChatMessage }
	| {
			type: 'round_ended';
			payload: {
				winner: string | null;
				answer: string;
				scoreboard: Record<string, Player>;
			};
	  }
	| {
			type: 'guess_result';
			payload: { correct: boolean; attemptsLeft: number };
	  }
	| { type: 'error_message'; payload: { message: string } };

function emptyGameState(): StoredGameState {
	return {
		status: 'LOBBY',
		gameMaster: null,
		players: {},
		question: '',
		answer: '',
		roundEndsAt: null,
	};
}

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

function isStoredGameState(value: unknown): value is StoredGameState {
	if (!isRecord(value) || !isRecord(value.players)) return false;

	return (
		(value.status === 'LOBBY' ||
			value.status === 'PLAYING' ||
			value.status === 'ENDED') &&
		(value.gameMaster === null || typeof value.gameMaster === 'string') &&
		Object.values(value.players).every(isPlayer) &&
		typeof value.question === 'string' &&
		typeof value.answer === 'string' &&
		(value.roundEndsAt === null || typeof value.roundEndsAt === 'number')
	);
}

function parseClientMessage(message: string | ArrayBuffer): ClientMessage | null {
	const text =
		typeof message === 'string' ? message : new TextDecoder().decode(message);
	if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) return null;

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}

	if (!isRecord(value) || typeof value.type !== 'string') return null;

	if (value.type === 'return_to_lobby') {
		return { type: 'return_to_lobby' };
	}

	if (!isRecord(value.payload)) return null;

	switch (value.type) {
		case 'join_session':
			return typeof value.payload.username === 'string'
				? { type: value.type, payload: { username: value.payload.username } }
				: null;
		case 'start_game':
			return typeof value.payload.question === 'string' &&
				typeof value.payload.answer === 'string'
				? {
						type: value.type,
						payload: {
							question: value.payload.question,
							answer: value.payload.answer,
						},
					}
				: null;
		case 'submit_guess':
			return typeof value.payload.guess === 'string'
				? { type: value.type, payload: { guess: value.payload.guess } }
				: null;
		default:
			return null;
	}
}

function getAttachment(webSocket: WebSocket): SessionAttachment | null {
	const value: unknown = webSocket.deserializeAttachment();
	if (
		!isRecord(value) ||
		typeof value.playerId !== 'string' ||
		(value.username !== null && typeof value.username !== 'string')
	) {
		return null;
	}

	return { playerId: value.playerId, username: value.username };
}

function clonePlayers(
	players: Record<string, Player>,
): Record<string, Player> {
	return Object.fromEntries(
		Object.entries(players).map(([id, player]) => [id, { ...player }]),
	);
}

export class GameRoom extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS game_state (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					state TEXT NOT NULL
				)
			`);
			this.ctx.storage.sql.exec(
				'INSERT OR IGNORE INTO game_state (id, state) VALUES (1, ?)',
				JSON.stringify(emptyGameState()),
			);
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}

		const url = new URL(request.url);
		const requestedSession = url.searchParams.get('session');
		const playerId =
			requestedSession && SESSION_ID_PATTERN.test(requestedSession)
				? requestedSession
				: crypto.randomUUID();
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const state = this.readState();
		const existingPlayer = state.players[playerId];
		const replacedConnections = this.ctx
			.getWebSockets()
			.filter((candidate) => getAttachment(candidate)?.playerId === playerId);
		const attachment: SessionAttachment = {
			playerId,
			username: existingPlayer?.username ?? null,
		};

		server.serializeAttachment(attachment);
		this.ctx.acceptWebSocket(server);
		for (const replacedConnection of replacedConnections) {
			replacedConnection.close(4001, 'Connected from another tab');
		}
		this.send(server, { type: 'connected', payload: { playerId } });
		if (existingPlayer) {
			this.send(server, {
				type: 'joined',
				payload: { playerId, username: existingPlayer.username },
			});
		}
		this.sendState(server, state);

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(
		webSocket: WebSocket,
		rawMessage: string | ArrayBuffer,
	): Promise<void> {
		const attachment = getAttachment(webSocket);
		if (!attachment) {
			webSocket.close(1008, 'Missing session data');
			return;
		}

		const message = parseClientMessage(rawMessage);
		if (!message) {
			this.sendError(webSocket, 'Invalid message.');
			return;
		}

		try {
			switch (message.type) {
				case 'join_session':
					this.joinSession(webSocket, attachment, message.payload.username);
					break;
				case 'start_game':
					await this.startGame(
						webSocket,
						attachment,
						message.payload.question,
						message.payload.answer,
					);
					break;
				case 'submit_guess':
					await this.submitGuess(
						webSocket,
						attachment,
						message.payload.guess,
					);
					break;
				case 'return_to_lobby':
					await this.returnToLobby(webSocket, attachment);
					break;
			}
		} catch (error) {
			console.error(
				JSON.stringify({
					message: 'WebSocket message handling failed',
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			this.sendError(webSocket, 'The game server could not process that action.');
		}
	}

	async webSocketClose(webSocket: WebSocket): Promise<void> {
		const attachment = getAttachment(webSocket);
		if (!attachment?.username) return;

		const replacementConnectionExists = this.ctx
			.getWebSockets()
			.some(
				(candidate) =>
					candidate !== webSocket &&
					getAttachment(candidate)?.playerId === attachment.playerId,
			);
		if (replacementConnectionExists) return;

		const state = this.readState();
		if (!state.players[attachment.playerId]) return;

		delete state.players[attachment.playerId];
		const remainingPlayerIds = Object.keys(state.players);
		if (remainingPlayerIds.length === 0) {
			this.writeState(emptyGameState());
			await this.ctx.storage.deleteAlarm();
			return;
		}

		if (state.gameMaster === attachment.playerId) {
			state.gameMaster = remainingPlayerIds[0] ?? null;
		}
		this.writeState(state);
		this.broadcastState(state);
	}

	webSocketError(webSocket: WebSocket, error: unknown): void {
		console.error(
			JSON.stringify({
				message: 'WebSocket error',
				playerId: getAttachment(webSocket)?.playerId,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	async alarm(): Promise<void> {
		const state = this.readState();
		if (state.status !== 'PLAYING' || state.roundEndsAt === null) return;

		if (state.roundEndsAt > Date.now()) {
			await this.ctx.storage.setAlarm(state.roundEndsAt);
			return;
		}

		await this.endRound(state, null, false);
	}

	private joinSession(
		webSocket: WebSocket,
		attachment: SessionAttachment,
		username: string,
	): void {
		const state = this.readState();
		const existingPlayer = state.players[attachment.playerId];
		if (existingPlayer) {
			webSocket.serializeAttachment({
				playerId: attachment.playerId,
				username: existingPlayer.username,
			} satisfies SessionAttachment);
			this.send(webSocket, {
				type: 'joined',
				payload: {
					playerId: attachment.playerId,
					username: existingPlayer.username,
				},
			});
			this.sendState(webSocket, state);
			return;
		}

		if (state.status !== 'LOBBY') {
			this.sendError(webSocket, 'Please wait for the Game Master to open the lobby.');
			return;
		}

		const safeUsername = username.trim().slice(0, 20);
		if (!safeUsername) {
			this.sendError(webSocket, 'Invalid username.');
			return;
		}

		state.players[attachment.playerId] = {
			id: attachment.playerId,
			username: safeUsername,
			score: 0,
			attempts: 3,
		};
		state.gameMaster ??= attachment.playerId;
		this.writeState(state);

		webSocket.serializeAttachment({
			playerId: attachment.playerId,
			username: safeUsername,
		} satisfies SessionAttachment);
		this.send(webSocket, {
			type: 'joined',
			payload: { playerId: attachment.playerId, username: safeUsername },
		});
		this.broadcastState(state);
	}

	private async startGame(
		webSocket: WebSocket,
		attachment: SessionAttachment,
		question: string,
		answer: string,
	): Promise<void> {
		const state = this.readState();
		if (attachment.playerId !== state.gameMaster) {
			this.sendError(webSocket, 'Only the Game Master can start a round.');
			return;
		}
		if (state.status !== 'LOBBY') {
			this.sendError(webSocket, 'The current round must finish first.');
			return;
		}

		const safeQuestion = question.trim().slice(0, 240);
		const safeAnswer = answer.trim().slice(0, 120);
		if (!safeQuestion || !safeAnswer) {
			this.sendError(webSocket, 'Question and answer must be valid text.');
			return;
		}

		if (Object.keys(state.players).length <= 2) {
			this.sendError(webSocket, 'Need more than 2 players to start.');
			return;
		}

		state.status = 'PLAYING';
		state.question = safeQuestion;
		state.answer = safeAnswer.toLowerCase();
		state.roundEndsAt = Date.now() + ROUND_DURATION_MS;
		this.writeState(state);
		await this.ctx.storage.setAlarm(state.roundEndsAt);

		const gameMaster = state.players[attachment.playerId];
		this.broadcast({
			type: 'new_chat',
			payload: {
				sender: gameMaster?.username ?? 'Game Master',
				text: `🎯 Question: ${safeQuestion}`,
				isGM: true,
				isSystem: false,
			},
		});
		this.broadcastState(state);
	}

	private async submitGuess(
		webSocket: WebSocket,
		attachment: SessionAttachment,
		guess: string,
	): Promise<void> {
		const state = this.readState();
		if (state.status !== 'PLAYING') return;

		if (state.roundEndsAt !== null && state.roundEndsAt <= Date.now()) {
			await this.endRound(state, null);
			return;
		}

		const safeGuess = guess.trim().slice(0, 120);
		const player = state.players[attachment.playerId];
		if (!safeGuess || !player || player.attempts <= 0) return;
		if (attachment.playerId === state.gameMaster) {
			this.sendError(webSocket, 'The Game Master cannot submit a guess.');
			return;
		}

		player.attempts -= 1;
		this.writeState(state);
		this.broadcast({
			type: 'new_chat',
			payload: {
				sender: player.username,
				text: safeGuess,
				isGM: false,
				isSystem: false,
			},
		});

		if (safeGuess.toLowerCase() === state.answer) {
			await this.endRound(state, attachment.playerId);
			return;
		}

		this.send(webSocket, {
			type: 'guess_result',
			payload: { correct: false, attemptsLeft: player.attempts },
		});
		this.broadcastState(state);
	}

	private async returnToLobby(
		webSocket: WebSocket,
		attachment: SessionAttachment,
	): Promise<void> {
		const state = this.readState();
		if (attachment.playerId !== state.gameMaster) {
			this.sendError(webSocket, 'Only the Game Master can return to the lobby.');
			return;
		}
		if (state.status !== 'ENDED') {
			this.sendError(webSocket, 'The round has not ended yet.');
			return;
		}

		state.status = 'LOBBY';
		state.question = '';
		state.answer = '';
		state.roundEndsAt = null;
		this.writeState(state);
		await this.ctx.storage.deleteAlarm();
		this.broadcastState(state);
	}

	private async endRound(
		state: StoredGameState,
		winnerId: string | null,
		deleteAlarm = true,
	): Promise<void> {
		if (state.status !== 'PLAYING') return;

		const winner = winnerId ? state.players[winnerId] : undefined;
		if (winner) winner.score += 10;

		state.status = 'ENDED';
		state.roundEndsAt = null;
		const playerIds = Object.keys(state.players);
		if (playerIds.length > 0) {
			const currentGameMasterIndex = playerIds.indexOf(state.gameMaster ?? '');
			state.gameMaster =
				playerIds[(currentGameMasterIndex + 1) % playerIds.length] ??
				playerIds[0] ??
				null;
		}
		for (const player of Object.values(state.players)) player.attempts = 3;

		this.writeState(state);
		if (deleteAlarm) await this.ctx.storage.deleteAlarm();

		this.broadcast({
			type: 'new_chat',
			payload: {
				sender: 'System',
				text: winner
					? `🎉 ${winner.username} won the round! The correct answer was: ${state.answer}`
					: `⏰ Time expired! The correct answer was: ${state.answer}`,
				isGM: false,
				isSystem: true,
			},
		});
		this.broadcast({
			type: 'round_ended',
			payload: {
				winner: winner?.username ?? null,
				answer: state.answer,
				scoreboard: clonePlayers(state.players),
			},
		});
		this.broadcastState(state);
	}

	private readState(): StoredGameState {
		const row = this.ctx.storage.sql
			.exec<{ state: string }>('SELECT state FROM game_state WHERE id = 1')
			.one();
		let value: unknown;
		try {
			value = JSON.parse(row.state);
		} catch {
			value = null;
		}

		if (isStoredGameState(value)) return value;

		const replacement = emptyGameState();
		this.writeState(replacement);
		return replacement;
	}

	private writeState(state: StoredGameState): void {
		this.ctx.storage.sql.exec(
			'UPDATE game_state SET state = ? WHERE id = 1',
			JSON.stringify(state),
		);
	}

	private toPublicState(state: StoredGameState): PublicGameState {
		return {
			status: state.status,
			gameMaster: state.gameMaster,
			players: clonePlayers(state.players),
			question: state.status === 'LOBBY' ? '' : state.question,
			roundEndsAt: state.roundEndsAt,
		};
	}

	private sendState(webSocket: WebSocket, state: StoredGameState): void {
		this.send(webSocket, {
			type: 'state_update',
			payload: this.toPublicState(state),
		});
	}

	private broadcastState(state: StoredGameState): void {
		this.broadcast({
			type: 'state_update',
			payload: this.toPublicState(state),
		});
	}

	private sendError(webSocket: WebSocket, message: string): void {
		this.send(webSocket, { type: 'error_message', payload: { message } });
	}

	private send(webSocket: WebSocket, message: ServerMessage): void {
		try {
			webSocket.send(JSON.stringify(message));
		} catch (error) {
			console.error(
				JSON.stringify({
					message: 'WebSocket send failed',
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
	}

	private broadcast(message: ServerMessage): void {
		for (const webSocket of this.ctx.getWebSockets()) {
			this.send(webSocket, message);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health') {
			return Response.json({ status: 'ok' });
		}

		if (url.pathname !== '/ws') {
			return Response.json(
				{
					name: 'Guess It backend',
					websocket: '/ws?room=main',
				},
			);
		}

		const roomId = url.searchParams.get('room') ?? 'main';
		if (!ROOM_ID_PATTERN.test(roomId)) {
			return Response.json({ error: 'Invalid room ID.' }, { status: 400 });
		}

		try {
			return await env.GAME_ROOM.getByName(roomId).fetch(request);
		} catch (error) {
			console.error(
				JSON.stringify({
					message: 'Durable Object request failed',
					roomId,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
			return Response.json(
				{ error: 'Game room is temporarily unavailable.' },
				{ status: 503 },
			);
		}
	},
} satisfies ExportedHandler<Env>;
