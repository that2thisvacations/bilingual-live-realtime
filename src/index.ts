import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<CaptionRoom>;
  ALLOWED_ORIGINS?: string;
}

type SocketRole = "host" | "viewer";

type SocketAttachment = {
  role: SocketRole;
  connectedAt: string;
};

type CaptionMessage = {
  type: "caption";
  session: {
    id: string;
    title: string;
    source: string;
    target: string;
  };
  segment: {
    id: string;
    original: string;
    translated: string;
    createdAt: string;
  };
};

const DEFAULT_ORIGINS = [
  "https://bilingual-live.vercel.app",
  "http://localhost:3000"
];

const VERCEL_PREVIEW_ORIGIN = /^https:\/\/bilingual-live-[a-z0-9-]+-that2thisvacations-projects\.vercel\.app$/i;

function allowedOrigins(env: Env): string[] {
  const configured = env.ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ORIGINS;
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return allowedOrigins(env).includes(origin) || VERCEL_PREVIEW_ORIGIN.test(origin);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "bilingual-live-realtime",
        transport: "durable-object-websocket-hibernation"
      });
    }

    const match = url.pathname.match(/^\/rooms\/([A-Za-z0-9_-]{4,80})$/);
    if (!match) return json({ error: "Not found" }, 404);
    if (!isAllowedOrigin(request, env)) return json({ error: "Origin not allowed" }, 403);

    const roomId = match[1];
    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;

export class CaptionRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      if (request.method === "GET") {
        const latest = await this.ctx.storage.get<CaptionMessage>("latest-caption");
        return json({ ok: true, latest: latest ?? null, viewers: this.viewerCount() });
      }
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "viewer";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role,
      connectedAt: new Date().toISOString()
    } satisfies SocketAttachment);

    const latest = await this.ctx.storage.get<CaptionMessage>("latest-caption");
    if (latest) server.send(JSON.stringify(latest));

    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role !== "host") {
      socket.send(JSON.stringify({ type: "error", error: "Viewer sockets cannot publish captions." }));
      return;
    }

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: CaptionMessage;

    try {
      parsed = JSON.parse(text) as CaptionMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid JSON message." }));
      return;
    }

    if (parsed.type !== "caption" || !parsed.segment?.original || !parsed.session?.id) {
      socket.send(JSON.stringify({ type: "error", error: "Invalid caption payload." }));
      return;
    }

    await this.ctx.storage.put("latest-caption", parsed);
    const outgoing = JSON.stringify(parsed);

    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== socket) {
        try {
          peer.send(outgoing);
        } catch {
          // Cloudflare removes closed sockets from getWebSockets automatically.
        }
      }
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } finally {
      this.broadcastPresence();
    }
  }

  webSocketError(): void {
    this.broadcastPresence();
  }

  private viewerCount(): number {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.role === "viewer";
    }).length;
  }

  private broadcastPresence(): void {
    const message = JSON.stringify({
      type: "presence",
      viewers: this.viewerCount(),
      connected: this.ctx.getWebSockets().length
    });

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // Ignore sockets closing between enumeration and send.
      }
    }
  }
}
