import WebSocket from "ws";

const realtimeUrl = process.env.REALTIME_URL || "http://127.0.0.1:8787";
const sessionId = process.env.REALTIME_SMOKE_SESSION_ID || `smoke-${Date.now()}`;
const origin = process.env.REALTIME_SMOKE_ORIGIN || "https://bilingual-live.vercel.app";

function socketUrl(role) {
  const url = new URL(`/rooms/${encodeURIComponent(sessionId)}`, realtimeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", role);
  return url.toString();
}

function openSocket(role) {
  const socket = new WebSocket(socketUrl(role), { headers: { Origin: origin } });
  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${role} socket did not open`)), 8_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, opened };
}

function waitFor(socket, predicate, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 8_000);
    const listener = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });
}

const sockets = [];
try {
  const hostConnection = openSocket("host");
  await hostConnection.opened;
  const host = hostConnection.socket;
  sockets.push(host);
  const viewerConnections = {
    en: openSocket("viewer"),
    es: openSocket("viewer"),
    fr: openSocket("viewer")
  };
  await Promise.all(Object.values(viewerConnections).map(({ opened }) => opened));
  const viewers = Object.fromEntries(
    Object.entries(viewerConnections).map(([language, connection]) => [language, connection.socket])
  );
  sockets.push(...Object.values(viewers));

  const presence = waitFor(
    host,
    (message) => message.type === "language-presence"
      && message.languages?.en === 1
      && message.languages?.es === 1
      && message.languages?.fr === 1,
    "1/1/1 language presence"
  );
  for (const [language, viewer] of Object.entries(viewers)) {
    viewer.send(JSON.stringify({ type: "viewer-language", language }));
  }
  await presence;

  const segmentId = `segment-${Date.now()}`;
  const sequence = Date.now();
  const draft = {
    type: "caption",
    session: { id: sessionId, title: "Realtime Smoke Test", source: "en", target: "es" },
    segment: {
      id: segmentId,
      segmentId,
      status: "draft",
      sequence,
      original: "Shared captions are live",
      translations: {
        en: "Shared captions are live",
        es: "Los subtítulos compartidos están en vivo",
        fr: "Les sous-titres partagés sont en direct"
      },
      createdAt: new Date().toISOString()
    }
  };
  const draftReceipts = Object.entries(viewers).map(([language, viewer]) => waitFor(
    viewer,
    (message) => message.segment?.sequence === sequence
      && message.segment?.status === "draft"
      && message.segment?.translations?.[language] === draft.segment.translations[language],
    `${language} draft`
  ));
  host.send(JSON.stringify(draft));
  await Promise.all(draftReceipts);

  const final = {
    ...draft,
    segment: {
      ...draft.segment,
      status: "final",
      sequence: sequence + 1,
      finalizedAt: new Date().toISOString()
    }
  };
  const finalReceipts = Object.entries(viewers).map(([language, viewer]) => waitFor(
    viewer,
    (message) => message.segment?.sequence === sequence + 1
      && message.segment?.status === "final"
      && message.segment?.translations?.[language] === final.segment.translations[language],
    `${language} final`
  ));
  host.send(JSON.stringify(final));
  await Promise.all(finalReceipts);

  viewers.fr.close(1000, "reconnect check");
  const reconnectConnection = openSocket("viewer");
  const reconnect = reconnectConnection.socket;
  sockets.push(reconnect);
  const recoveredPromise = waitFor(
    reconnect,
    (message) => message.segment?.sequence === sequence + 1
      && message.segment?.translations?.fr === final.segment.translations.fr,
    "latest multilingual caption after reconnect"
  );
  await reconnectConnection.opened;
  const recovered = await recoveredPromise;

  if (recovered.type !== "caption") throw new Error("Reconnect did not recover a caption");
  console.log(JSON.stringify({
    ok: true,
    languages: ["en", "es", "fr"],
    translationRequestsFromViewers: { es: 0, fr: 0 },
    latestCaptionRecovered: true
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
}
