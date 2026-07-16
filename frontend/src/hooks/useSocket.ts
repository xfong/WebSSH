import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';

// Stable device ID per browser session
function getDeviceId(): string {
  let id = sessionStorage.getItem('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem('deviceId', id);
  }
  return id;
}

export function useControlSocket(): Socket | null {
  const { token } = useAuth();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;

    const socket = io('/ws/control', {
      transports: ['websocket'],
      auth: { token, deviceId: getDeviceId() },
    });

    socketRef.current = socket;
    return () => { socket.disconnect(); };
  }, [token]);

  return socketRef.current;
}

export function createTerminalSocket(token: string, nodeId: string): Socket {
  return io('/ws/terminal', {
    transports: ['websocket'],
    auth: { token, deviceId: getDeviceId() },
    query: { nodeId },
  });
}

export function createXpraSocket(token: string, nodeId: string): Socket {
  return io('/ws/xpra', {
    transports: ['websocket'],
    auth: { token, deviceId: getDeviceId() },
    query: { nodeId },
  });
}
