import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/mongo-adapter';
import cookieParser from 'cookie-parser';
import mongoose, { type Types } from 'mongoose';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';
import { env } from '../env.js';
import { logger } from '../integrations/logger.js';
import { reportError } from '../integrations/sentry.js';
import { hasAuthCookie, isTrustedOrigin } from '../middleware/trusted-origin.js';
import { ACCESS_COOKIE } from '../modules/auth/auth.cookies.js';
import { verifyAccessToken, type AuthContext } from '../modules/auth/auth.tokens.js';
import { SessionModel } from '../modules/auth/session.model.js';

/** Where the adapter passes events between backend tasks; MongoDB deletes them after an hour. */
const EVENTS_COLLECTION = 'socketEvents';
const EVENTS_TTL_SECONDS = 60 * 60;

/**
 * How often an open connection checks it's still signed in: its session still exists and hasn't run out.
 * Signing out closes connections straight away (disconnectSessions()); this catches anything that didn't,
 * within minutes. The access token's own 15 minutes aren't checked: while the session lasts, the website
 * would only renew it and connect again.
 */
export const SESSION_RECHECK_MS = 5 * 60 * 1000;

interface SocketData {
  auth: AuthContext;
}

export type RealtimeServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
type RealtimeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/** Cookies parsed by cookie-parser, which runs on every Socket.IO request. */
type CookieRequest = IncomingMessage & { cookies?: Record<string, unknown> };

/** The room holding every open tab and device of one user. */
export const userRoom = (userId: string) => `user:${userId}`;

/** The room holding the open tabs of one signed-in session (one browser or device), closed when it ends. */
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/**
 * Socket.IO on the backend's own HTTP server (plan §4.4). The MongoDB adapter passes events between
 * backend tasks through a MongoDB change stream, so an event emitted on one task reaches a user
 * connected to another.
 */
export async function createRealtimeServer(
  httpServer: HttpServer,
  { recheckMs = SESSION_RECHECK_MS }: { recheckMs?: number } = {},
): Promise<RealtimeServer> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Connect to MongoDB before starting Socket.IO');
  const events = db.collection(EVENTS_COLLECTION);
  await events.createIndex({ createdAt: 1 }, { expireAfterSeconds: EVENTS_TTL_SECONDS });

  const io: RealtimeServer = new Server(httpServer, {
    serveClient: false,
    adapter: createAdapter(events, { addCreatedAtField: true }),
    // Long-polling (the fallback for networks that block WebSockets) makes cross-origin requests.
    cors: { origin: env.FRONTEND_ORIGINS, credentials: true },
    // WebSockets skip CORS, so every handshake passes the same origin check as API writes.
    allowRequest: (req, callback) => {
      const { headers, cookies } = req as CookieRequest;
      callback(null, isTrustedOrigin(headers.origin, hasAuthCookie(cookies)));
    },
  });
  io.engine.use(cookieParser() as Parameters<typeof io.engine.use>[0]);
  io.use(authenticate);
  io.on('connection', (socket) => {
    void socket.join([userRoom(socket.data.auth.userId), sessionRoom(socket.data.auth.sessionId)]);
    const recheck = setInterval(() => void closeIfSignedOut(socket), recheckMs);
    recheck.unref();
    socket.on('disconnect', () => clearInterval(recheck));
  });

  return io;
}

/**
 * Closes a connection whose session has ended: deleted, or past its expiry before MongoDB's TTL monitor
 * removes it. The website can't connect again without signing in (plan §6.1).
 */
async function closeIfSignedOut(socket: RealtimeSocket) {
  try {
    const live = await SessionModel.exists({
      _id: socket.data.auth.sessionId,
      expiresAt: mongoose.trusted({ $gt: new Date() }),
    });
    if (!live) socket.disconnect(true);
  } catch (error) {
    // The next check tries again.
    logger.warn({ err: error }, 'Could not re-check a Socket.IO connection’s session');
  }
}

/**
 * Only signed-in users connect. Browsers send the access cookie; future mobile apps pass the token
 * as `auth: { token }` (plan §6.1). A refused browser gets a connect_error with the message
 * UNAUTHENTICATED, renews its session and connects again.
 */
async function authenticate(socket: RealtimeSocket, next: (error?: Error) => void) {
  try {
    const fromApp: unknown = socket.handshake.auth.token;
    const fromCookie = (socket.request as CookieRequest).cookies?.[ACCESS_COOKIE];
    const token = typeof fromApp === 'string' ? fromApp : fromCookie;
    const auth = typeof token === 'string' ? verifyAccessToken(token) : null;

    // An access token outlives its session by up to 15 minutes after sign-out; that isn't enough here.
    if (!auth || !(await SessionModel.exists({ _id: auth.sessionId }))) {
      return next(new Error('UNAUTHENTICATED'));
    }
    socket.data.auth = auth;
    next();
  } catch (error) {
    logger.error({ err: error }, 'Could not authenticate a Socket.IO connection');
    reportError(error, { tags: { area: 'socket-auth' } });
    next(new Error('UNAVAILABLE'));
  }
}

let current: RealtimeServer | undefined;

/** Starts the app's Socket.IO server; emitToUser() then sends through it. */
export async function startRealtime(
  httpServer: HttpServer,
  options?: Parameters<typeof createRealtimeServer>[1],
): Promise<RealtimeServer> {
  current = await createRealtimeServer(httpServer, options);
  return current;
}

/**
 * Sends an event to every open tab and device of one user, on whichever backend task they are
 * connected to. Job handlers use it for live notifications. Does nothing where Socket.IO isn't
 * running, such as scripts.
 */
export function emitToUser(userId: string, event: string, ...args: unknown[]): void {
  current?.to(userRoom(userId)).emit(event, ...args);
}

/**
 * Closes every open tab and device of one user, on every backend task, except those of the session in
 * `except` (the device that changed the password, say). Call it once their sessions are deleted, so they
 * can't connect again: a suspended or closed account (plan §8.2), a password reset, support removed.
 */
export function disconnectUser(userId: Types.ObjectId | string, { except }: { except?: string } = {}): void {
  const room = current?.in(userRoom(userId.toString()));
  (except ? room?.except(sessionRoom(except)) : room)?.disconnectSockets(true);
}

/**
 * Closes the open tabs of these sessions, on every backend task, once they're deleted (signed out), so a
 * signed-out browser stops receiving messages and notifications at once (plan §6.1, §6.2). Does nothing
 * where Socket.IO isn't running.
 */
export function disconnectSessions(sessionIds: (Types.ObjectId | string)[]): void {
  if (sessionIds.length === 0) return;
  current?.in(sessionIds.map((id) => sessionRoom(id.toString()))).disconnectSockets(true);
}
