<div align="center">

# Smarty

### ESP32 Cloud Command Center

Control ESP32 relays remotely through Firebase Realtime Database.

[![CI](https://github.com/ammar0xff/Smarty/actions/workflows/ci.yml/badge.svg)](https://github.com/ammar0xff/Smarty/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?logo=firebase)

</div>

---

## What is this?

A web dashboard that sends commands to ESP32 microcontrollers via Firebase Realtime Database. Click a button on the web, the ESP32 activates a relay — simple as that.

```
Web Dashboard  →  Firebase RTDB  →  ESP32 subscribes  →  Relay ON/OFF
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/ammar0xff/Smarty.git
cd smarty
npm install
```

### 2. Configure Firebase

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Firebase project credentials:

```
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.us-central1.firebasedatabase.app
VITE_FIREBASE_PROJECT_ID=your_project_id
```

### 3. Run

```bash
npm run dev
```

Open **http://localhost:5173** — click a button, the ESP32 relay activates.

## Circuit Diagram

![Circuit](public/circuit.svg)

### Control wiring (logic side)

| ESP32 Pin | Component | Signal |
|-----------|-----------|--------|
| GPIO 26   | R1 → Q1 base   | Relay 1 trigger (`press1`) |
| GPIO 27   | R2 → Q2 base   | Relay 2 trigger (`press2`) |
| GND       | Q1/Q2 emitter | Ground rail |
| 5V (VIN)  | K1/K2 coil, D1/D2 | 5V power rail |

### Power / output wiring (load side)

| From | To | Note |
|------|----|------|
| AC Live | Relay COM (both) | switched wire |
| Relay NO | Load (L1, L2) | load returns to Neutral |
| Hi-Link HLK-PM01 | 5V bus + GND | isolated AC-DC supply |
| F1 (1A) | between 5V & VIN | fuse protection |

### Production component notes

- **Relays** — Songle `SRD-05VDC-SL-C`: 5V coil, SPDT, rated **10A @ 250VAC**. Use the **NO** contact to switch the live wire only; never switch neutral.
- **Transistors** — `2N2222A` NPN: the ESP32's 3.3V GPIO **cannot** drive a 5V relay coil directly. The transistor inverts/switches the ~72mA coil current; coil resistance ~70Ω.
- **Flyback diodes** — `1N4007` **across the coil** (cathode to 5V, anode to collector) — required to clamp the inductive spike when the coil de-energizes, otherwise Q1/Q2 die instantly.
- **Base resistors** — `1kΩ` limit GPIO current to ~2.3mA (safe for the ESP32's ~40mA max per pin). Confirms the 5V logic level.
- **Power supply** — Hi-Link `HLK-PM01` (AC 85–265V → 5V DC, isolated). Do **not** power relays from the ESP32's on-board 3.3V regulator — it cannot source the coil current.
- **Decoupling** — `470µF` electrolytic bulk + `0.1µF` ceramic on the 5V rail to absorb coil switching transients and prevent brownouts.

## ESP32 Setup

Install the current Firebase Arduino client library (`FirebaseClient` v2.x, by
Firebase) and subscribe to the relay paths.

### Command format

`sendCommand()` does not write a bare number. It writes an **object**:

```json
{ "value": 1, "timestamp": 1758000000000 }
```

so the firmware must parse JSON and read `value`. Acknowledging a command means
writing `{"value": 0}` back — **not** a bare `0`, which would discard the object
shape the dashboard writes.

### Security

The web app uses no Firebase Authentication, so the Realtime Database must be
readable and writable by anyone. That is fine for a bench test but means
**anyone who knows the database URL can energise your relays**. Put it behind a
non-guessable path, add Auth, or keep it off the public internet before leaving
it unattended.

```cpp
#define ENABLE_DATABASE
#define ENABLE_USER_AUTH
#include <FirebaseClient.h>
#include <ArduinoJson.h>
#include <ExampleFunctions.h>  // provides SSL_CLIENT for the platform

// Use the *.firebasedatabase.app host. The legacy firebaseio.com name serves a
// certificate for the other host, so TLS hostname verification fails.
#define DATABASE_URL "your-project-default-rtdb.us-central1.firebasedatabase.app"

#define RELAY_1_PIN 26
#define RELAY_2_PIN 27
#define PULSE_MS 500

SSL_CLIENT ssl_client, stream_ssl_client;
AsyncClientClass aClient(ssl_client), streamClient(stream_ssl_client);
NoAuth no_auth;  // open rules; see Security above
FirebaseApp app;
RealtimeDatabase Database;

uint8_t pendingMask = 0, onMask = 0, ackMask = 0;
unsigned long onSince = 0;

void setup() {
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  digitalWrite(RELAY_1_PIN, LOW);
  digitalWrite(RELAY_2_PIN, LOW);

  ssl_client.setInsecure();
  stream_ssl_client.setInsecure();
  initializeApp(aClient, app, getAuth(no_auth));
  app.getApp<RealtimeDatabase>(Database);
  Database.url(DATABASE_URL);

  // Stream the whole database from "/" so dataPath() is absolute (/press1).
  // A stream rooted at "/press1" yields a relative path of "/", which makes it
  // impossible to tell the relays apart. Streams must use streamClient.
  Database.get(streamClient, "/", processData, true /* SSE mode */, "streamTask");
}

void loop() {
  app.loop();  // maintains the async tasks
  servicePulse();
}

void startPulse(uint8_t mask) {
  onMask = mask;
  onSince = millis();
  if (onMask & 1) digitalWrite(RELAY_1_PIN, HIGH);
  if (onMask & 2) digitalWrite(RELAY_2_PIN, HIGH);
}

// Pulses run from loop(), never from the stream callback: a delay() inside the
// callback stalls the stream and drops concurrent commands.
void servicePulse() {
  if (onMask && millis() - onSince >= PULSE_MS) {
    digitalWrite(RELAY_1_PIN, LOW);
    digitalWrite(RELAY_2_PIN, LOW);
    ackMask |= onMask;  // acknowledge only after the pulse finished
    onMask = 0;
  }
  if (pendingMask && !onMask) {
    uint8_t m = pendingMask;
    pendingMask = 0;
    startPulse(m);
  }
  if (ackMask && !onMask && !pendingMask) {
    uint8_t m = ackMask;
    ackMask = 0;
    JsonWriter writer;
    object_t obj;
    writer.create(obj, "value", 0);  // preserve the { value, timestamp } shape
    if ((m & 1)) Database.set(aClient, "/press1", obj);
    if ((m & 2)) Database.set(aClient, "/press2", obj);
  }
}

void processData(AsyncResult &aResult) {
  if (!aResult.isResult() || aResult.isError() || !aResult.available()) return;
  RealtimeDatabaseResult &stream = aResult.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;
  if (stream.type() != realtime_database_data_type_json) return;

  String path = stream.dataPath();
  if (path != "/press1" && path != "/press2") return;

  JsonDocument doc;
  if (deserializeJson(doc, stream.to<const char *>()) != DeserializationError::Ok)
    return;

  JsonVariant value = doc["value"].as<JsonVariant>();
  if (value.isNull() || !value.is<int>() || value.as<int>() != 1) return;

  pendingMask |= (path == "/press1") ? 1 : 2;
}
```

## Adding More Relays

Edit `src/main.ts` and add a new entry to the `RELAYS` array:

```typescript
const RELAYS: Relay[] = [
  { id: 1, label: "Relay 1", description: "LED light control", path: "press1" },
  { id: 2, label: "Relay 2", description: "Secondary relay", path: "press2" },
  { id: 3, label: "Relay 3", description: "Door lock", path: "press3" },
]
```

The dashboard automatically renders cards for all relays in the array.

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run type-check` | TypeScript type checking |

## Tech Stack

| | |
|---|---|
| Build | Vite 6 |
| Language | TypeScript 5 |
| Firebase | v11 (modular SDK) |
| Hosting | GitHub Pages |

## License

[MIT](./LICENSE)
