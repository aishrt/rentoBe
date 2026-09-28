import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { login } from '../src/modules/auth/auth.service.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import {
  createRealtimeServer,
  emitToUser,
  startRealtime,
  userRoom,
  type RealtimeServer,
} from '../src/realtime/realtime.js';
import { FRONTEND_ORIGIN, PASSWORD, createUser } from './helpers.js';

const servers: RealtimeServer[] = [];
const clients: ClientSocket[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** A Socket.IO server on its own port, standing in for one backend task. */
async function backendTask(start: typeof createRealtimeServer = createRealtimeServer) {
  const http = createServer();
  const io = await start(http);
  servers.push(io);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { io, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

function connect(url: string, options: { cookie?: string; origin?: string; token?: string } = {}) {
  const client = connectClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    auth: options.token ? { token: options.token } : {},
    extraHeaders: {
      ...(options.cookie && { Cookie: options.cookie }),
      ...(options.origin && { Origin: options.origin }),
    },
  });
  clients.push(client);
  return client;
}

/** Resolves with "connected", or with the reason the connection was refused. */
function outcome(client: ClientSocket): Promise<string> {
  return new Promise((resolve) => {
    client.once('connect', () => resolve('connected'));
    client.once('connect_error', (error) => resolve(error.message));
  });
}

async function signIn() {
  const user = await createUser();
  const result = await login({ email: 'kiri@example.co.nz', password: PASSWORD, portal: 'app' }, {});
  if (!('tokens' in result)) throw new Error('Expected a session, not an authenticator challenge');
  return { userId: user.id as string, accessToken: result.tokens.accessToken };
}

describe('Socket.IO', () => {
  it('refuses a visitor who is not signed in', async () => {
    const { url } = await backendTask();
    expect(await outcome(connect(url, { origin: FRONTEND_ORIGIN }))).toBe('UNAUTHENTICATED');
  });

  it("connects a signed-in browser and puts it in the user's room", async () => {
    const { io, url } = await backendTask();
    const { userId, accessToken } = await signIn();

    const client = connect(url, { origin: FRONTEND_ORIGIN, cookie: `rv_access=${accessToken}` });
    expect(await outcome(client)).toBe('connected');
    expect(await io.local.in(userRoom(userId)).fetchSockets()).toHaveLength(1);
  });

  it('accepts the access token from a mobile app', async () => {
    const { url } = await backendTask();
    const { accessToken } = await signIn();
    expect(await outcome(connect(url, { token: accessToken }))).toBe('connected');
  });

  it('refuses a browser on another website, even with valid cookies', async () => {
    const { url } = await backendTask();
    const { accessToken } = await signIn();

    const client = connect(url, { origin: 'https://evil.example', cookie: `rv_access=${accessToken}` });
    expect(await outcome(client)).not.toBe('connected');
  });

  it('refuses an access token whose session has been signed out', async () => {
    const { url } = await backendTask();
    const { accessToken } = await signIn();
    await SessionModel.deleteMany({});

    const client = connect(url, { origin: FRONTEND_ORIGIN, cookie: `rv_access=${accessToken}` });
    expect(await outcome(client)).toBe('UNAUTHENTICATED');
  });

  it('delivers an event to a user connected to a different backend task', async () => {
    const taskA = await backendTask();
    await backendTask(startRealtime); // task B: emitToUser() sends through this one
    const { userId, accessToken } = await signIn();

    const client = connect(taskA.url, { origin: FRONTEND_ORIGIN, cookie: `rv_access=${accessToken}` });
    expect(await outcome(client)).toBe('connected');

    const received = new Promise((resolve) => client.once('notification', resolve));
    // Task A's change stream opens in the background, so send until it's listening.
    const resend = setInterval(() => emitToUser(userId, 'notification', { title: 'Booking confirmed' }), 100);
    try {
      expect(await received).toEqual({ title: 'Booking confirmed' });
    } finally {
      clearInterval(resend);
    }
  });
});
