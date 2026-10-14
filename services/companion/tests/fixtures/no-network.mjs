// Test-only preload: genuine installed MCP discovery must not open any socket.
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const blocked = () => {
  appendFileSync(process.env.DISCOVERY_NETWORK_LOG, 'attempted socket operation\n');
  throw new Error('Network forbidden in isolated discovery proof');
};
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
dgram.Socket.prototype.send = blocked;
dgram.Socket.prototype.connect = blocked;
syncBuiltinESMExports();
