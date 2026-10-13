import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { login, logout } from '../src/modules/auth/auth.service.js';
import { verifyAccessToken } from '../src/modules/auth/auth.tokens.js';
import { SessionModel } from '../src/modules/auth/session.model.js';
import { changePassword } from '../src/modules/users/account.service.js';
import { startRealtime, type RealtimeServer } from '../src/realtime/realtime.js';
import { FRONTEND_ORIGIN, PASSWORD, createUser } from './helpers.js';

/* A signed-out session's open tabs stop receiving events at once (plan §4.4, §6.1, §6.2). */

const servers: RealtimeServer[] = [];
const clients: ClientSocket[] = [];

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** The app's Socket.IO server, which disconnectSessions() and disconnectUser() act through. */
async function backendTask(recheckMs?: number) {
  const http = createServer();
  const io = await startRealtime(http, recheckMs ? { recheckMs } : undefined);
  servers.push(io);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}

/** A browser tab connected with this access token; resolves once it's connected. */
async function connect(url: string, accessToken: string) {
  const client = connectClient(url, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: { Cookie: `rv_access=${accessToken}`, Origin: FRONTEND_ORIGIN },
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  return client;
}

/** Resolves with the reason the server closed the connection. */
const closed = (client: ClientSocket) =>
  new Promise<string>((resolve) => client.once('disconnect', (reason) => resolve(reason)));

async function signIn() {
  const result = await login({ email: 'kiri@example.co.nz', password: PASSWORD, portal: 'app' }, {});
  if (!('tokens' in result)) throw new Error('Expected a session, not an authenticator challenge');
  return result.tokens;
}

describe('Socket.IO and signing out', () => {
  it('closes the other devices when the password is changed, and keeps this one', async () => {
    const url = await backendTask();
    const user = await createUser();
    const laptop = await signIn();
    const phone = await signIn();
    const laptopTab = await connect(url, laptop.accessToken);
    const phoneTab = await connect(url, phone.accessToken);
    const laptopClosed = closed(laptopTab);

    await changePassword(
      { userId: user.id, sessionId: verifyAccessToken(phone.accessToken)!.sessionId },
      { currentPassword: PASSWORD, newPassword: 'a whole new passphrase' },
    );
    expect(await laptopClosed).toBe('io server disconnect');
    expect(phoneTab.connected).toBe(true);
  });

  it('closes every tab of a browser that logs out, and no other', async () => {
    const url = await backendTask();
    await createUser();
    const browser = await signIn();
    const other = await signIn();
    const tabs = [await connect(url, browser.accessToken), await connect(url, browser.accessToken)];
    const otherTab = await connect(url, other.accessToken);
    const allClosed = Promise.all(tabs.map(closed));

    await logout(browser.refreshToken);
    expect(await allClosed).toEqual(['io server disconnect', 'io server disconnect']);
    expect(otherTab.connected).toBe(true);
  });

  it('closes a connection whose session ended without it, on its next check', async () => {
    const url = await backendTask(50);
    await createUser();
    const tab = await connect(url, (await signIn()).accessToken);
    const tabClosed = closed(tab);

    await SessionModel.deleteMany({});
    expect(await tabClosed).toBe('io server disconnect');
  });

  it('closes a connection whose session ran out before MongoDB removed it', async () => {
    const url = await backendTask(50);
    const user = await createUser();
    const tab = await connect(url, (await signIn()).accessToken);
    const tabClosed = closed(tab);

    await SessionModel.updateMany({ userId: user._id }, { expiresAt: new Date(Date.now() - 1000) });
    expect(await tabClosed).toBe('io server disconnect');
  });

  it('keeps a connection open while its session lasts, though its access token has run out', async () => {
    const url = await backendTask(50);
    const user = await createUser();
    await signIn();
    const session = await SessionModel.findOne({ userId: user._id });
    // Signed like the API's own access tokens, but expiring within a second.
    const shortLived = jwt.sign({ roles: ['GUEST'], sid: session!.id }, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: 1,
      subject: user.id,
      issuer: 'rento-vroom',
      audience: 'rento-vroom-api',
    });
    const tab = await connect(url, shortLived);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(tab.connected).toBe(true);
  });
});
