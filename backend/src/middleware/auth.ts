import { Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET!;

export interface AuthPayload {
  username: string;
  role: 'user' | 'admin';
}

/**
 * Socket.IO middleware that validates the JWT passed in the handshake auth object.
 * Attaches the decoded payload to socket.data.auth for downstream use.
 */
export function authMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token = socket.handshake.auth?.token as string | undefined;

  if (!token) {
    return next(new Error('Authentication token missing'));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    socket.data.auth = payload;
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}
