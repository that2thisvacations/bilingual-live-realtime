import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<CaptionRoom>;
  ALLOWED_ORIGINS?: string;
}

type SocketRole = "host" | "viewer";
type SupportedCaptionLanguage = "en" | "es" | "fr";

type SocketAttachment = {
  role: SocketRole;
  connectedAt: string;
  language?: SupportedCaptionLanguage;
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
    segmentId?: string;
    status?: "draft" | "final";
    sequence?: number;
    original: string;
    translated?: string;
    translations?: Record<SupportedCaptionLanguage, string>;
    createdAt: string;
    finalizedAt?: string | null;
  };
};

type ViewerLanguageMessage = {
  type: "viewer-language";
  language: SupportedCaptionLanguage;
};

type StoredCaption = {
  message: CaptionMessage;
  sequence: number;
};

function readStoredCaption(stored: StoredCaption | CaptionMessage | undefined): StoredCaption | null {
  if (!stored) return null;
  if ("message" in stored) return stored;
  return {
    message: stored,
    sequence: typeof stored.segment.sequence === "number" ? stored.segment.sequence : -1
  };
}

const DEFAULT_ORIGINS = [
  "https://bilingual-live.vercel.app"
];

const VERCEL_PREVIEW_HOST_SUFFIX = "-that2thisvacations-projects.vercel.app";

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
  if (allowedOrigins(env).includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && hostname.endsWith(VERCEL_PREVIEW_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function isSupportedCaptionLanguage(value: unknown): value is SupportedCaptionLanguage {
  return value === "en" || value === "es" || value === "fr";
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
    if (!isAllowedOrigin(request, env)) {
      return json({
        ok: false,
        error: "websocket_origin_not_allowed",
        origin: request.headers.get("Origin"),
        acceptedProductionOrigin: "https://bilingual-live.vercel.app",
        acceptedPreviewPattern: "https://*-that2thisvacations-projects.vercel.app"
      }, 403);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "viewer") {
        return json({ error: "websocket_role_required", expected: "role=host or role=viewer" }, 400);
      }
    }

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
        const stored = await this.ctx.storage.get<StoredCaption | CaptionMessage>("latest-caption");
        const latest = readStoredCaption(stored);
        return json({ ok: true, latest: latest?.message ?? null, viewers: this.viewerCount() });
      }
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "viewer") {
      return json({ error: "websocket_role_required", expected: "role=host or role=viewer" }, 400);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      role,
      connectedAt: new Date().toISOString()
    } satisfies SocketAttachment);

    const stored = await this.ctx.storage.get<StoredCaption | CaptionMessage>("latest-caption");
    const latest = readStoredCaption(stored);
    if (role === "viewer" && latest) server.send(JSON.stringify(latest.message));

    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;

    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let parsed: CaptionMessage | ViewerLanguageMessage;

    try {
      parsed = JSON.parse(text) as CaptionMessage | ViewerLanguageMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Invalid JSON message." }));
      return;
    }

    if (attachment?.role === "viewer" && parsed.type === "viewer-language") {
      if (!isSupportedCaptionLanguage(parsed.language)) {
        socket.send(JSON.stringify({ type: "error", error: "Unsupported caption language." }));
        return;
      }
      socket.serializeAttachment({ ...attachment, language: parsed.language } satisfies SocketAttachment);
      this.broadcastPresence();
      return;
    }

    if (attachment?.role !== "host") {
      socket.send(JSON.stringify({ type: "error", error: "Viewer sockets cannot publish captions." }));
      return;
    }

    if (parsed.type !== "caption" || !parsed.segment?.original || !parsed.session?.id) {
      socket.send(JSON.stringify({ type: "error", error: "Invalid caption payload." }));
      return;
    }

    const stored = readStoredCaption(
      await this.ctx.storage.get<StoredCaption | CaptionMessage>("latest-caption")
    );
    const sequence = typeof parsed.segment.sequence === "number"
      ? parsed.segment.sequence
      : (stored?.sequence ?? -1) + 1;
    if (sequence <= (stored?.sequence ?? -1)) return;

    await this.ctx.storage.put("latest-caption", { message: parsed, sequence } satisfies StoredCaption);
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
    void code;
    void reason;
    this.broadcastPresence(socket);
  }

  webSocketError(socket: WebSocket): void {
    this.broadcastPresence(socket);
  }

  private viewerCount(): number {
    return this.ctx.getWebSockets().filter((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.role === "viewer";
    }).length;
  }

  private broadcastPresence(exclude?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== exclude);
    const viewerLanguages = sockets.flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.role === "viewer" ? [attachment.language] : [];
    });
    const languages = viewerLanguages.reduce<Record<SupportedCaptionLanguage, number>>((counts, language) => {
      if (language) counts[language] += 1;
      return counts;
    }, { en: 0, es: 0, fr: 0 });

    const presence = JSON.stringify({
      type: "presence",
      viewers: viewerLanguages.length,
      connected: sockets.length
    });
    const languagePresence = JSON.stringify({ type: "language-presence", languages });

    for (const socket of sockets) {
      try {
        socket.send(presence);
        socket.send(languagePresence);
      } catch {
        // Ignore sockets closing between enumeration and send.
      }
    }
  }
}
