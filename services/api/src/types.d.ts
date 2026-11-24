import 'node:http';

declare module 'node:http' {
  interface IncomingMessage {
    visionRequestId?: string;
  }
}
