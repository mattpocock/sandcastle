declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export interface Database {
    pragma(source: string): unknown;
    exec(source: string): unknown;
    prepare(source: string): Statement;
    close(): void;
  }
  interface DatabaseConstructor {
    new (path: string): Database;
  }
  const Database: DatabaseConstructor;
  export default Database;
}

declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";
  class WebSocket {
    static readonly OPEN: number;
    readonly OPEN: number;
    readonly readyState: number;
    constructor(url: string);
    send(data: string): void;
    close(): void;
    on(event: "message", listener: (data: Buffer) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: "open", listener: () => void): this;
    once(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
  }
  interface WebSocketServerOptions {
    noServer?: boolean;
  }
  class WebSocketServer {
    constructor(options?: WebSocketServerOptions);
    on(
      event: "connection",
      listener: (ws: WebSocket, req: IncomingMessage) => void,
    ): this;
    emit(event: "connection", ws: WebSocket, req: IncomingMessage): boolean;
    handleUpgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WebSocket) => void,
    ): void;
    close(): void;
  }
  export { WebSocketServer, WebSocket };
  export default WebSocket;
}
