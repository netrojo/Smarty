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

### Using 12V relays instead

The bill of materials above is specified for a 5V coil on a 5V rail. A 12V relay
module on a 12V supply works with the same 2N2222A switching stage, but three
things must change, and skipping them produces exactly the "sometimes it works"
symptom:

- **Decoupling is not optional.** A 12V coil has roughly 4x the inductance and dumps
  a far larger transient into the rail. Fit `470µF` + `100nF` at the relay end even
  if nothing seemed wrong at 5V, or the ESP32 brownouts mid-stream.
- **Keep the flyback diode.** Cathode to 12V+, anode to the collector. A reversed
  diode destroys the transistor on the first switch-off, which presents as a relay
  that works a few times and then goes dead.
- **Do not assume the 2N2222A pinout.** E-B-C ordering varies by manufacturer and
  package. Verify each device against its own datasheet; swapping the two
  transistors is a fast way to tell a driver fault from a wiring fault.

Base drive is unaffected: 3.3V through `1kΩ` still gives ~2.6mA, which saturates a
typical 12V/36mA coil easily. Do not lower that resistor.

## ESP32 Setup

Install the current Firebase Arduino client library (`FirebaseClient` v2.x, by
Firebase) and subscribe to the relay paths.

### Command format

`sendCommand()` does not write a bare number. It writes an **object**:

```json
{ "value": 1, "timestamp": 1758000000000 }
```

so the firmware must parse JSON and read `value`.

Do **not** acknowledge a command by writing back to the same node. The write races
the stream and any command that has been written but not yet delivered gets
overwritten and silently lost; at six commands 200 ms apart this dropped 4 of 6.
Deduplicate on `timestamp` instead — it survives reconnect replays and, stored in
NVS, survives a reboot. The value stays `1` afterwards, which is harmless because
the dashboard never reads it back.

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
#include <Preferences.h>
#include <ExampleFunctions.h>  // provides SSL_CLIENT for the platform

// Use the *.firebasedatabase.app host. The legacy firebaseio.com name serves a
// certificate for the other host, so TLS hostname verification fails.
#define DATABASE_URL "your-project-default-rtdb.us-central1.firebasedatabase.app"

#define RELAY_1_PIN 26
#define RELAY_2_PIN 27
#define PULSE_MS 500

// A quiet database emits no put events, so user activity proves nothing about
// stream health. Firebase sends an SSE keep-alive roughly every 45s; if none
// arrives in this window the socket is dead and must be rebuilt, because the
// client library never retries a stream on its own.
#define STREAM_STALE_MS 90000

SSL_CLIENT ssl_client, stream_ssl_client;
AsyncClientClass aClient(ssl_client), streamClient(stream_ssl_client);
NoAuth no_auth;  // open rules; see Security above
FirebaseApp app;
RealtimeDatabase Database;

// bit0 = relay 1, bit1 = relay 2
uint8_t pendingMask = 0;  // commands waiting to fire
uint8_t onMask = 0;       // relays currently driven HIGH
unsigned long onSince = 0;

// Unix milliseconds from serverTimestamp() are ~1.8e12 and do NOT fit in a
// 32-bit long. Truncating wrapped them negative about half the time, which
// silently disabled deduplication.
long long lastStamp[2] = {-1, -1};

// Stamps live in NVS so a reboot -- or a brownout, which a relay coil can
// provoke -- cannot replay a command still sitting in the database.
Preferences prefs;
bool prefsLoaded = false;

void loadStamps() {
  if (prefsLoaded) return;
  prefsLoaded = true;
  prefs.begin("smarty", true);
  lastStamp[0] = prefs.getLong64("s1", -1);
  lastStamp[1] = prefs.getLong64("s2", -1);
  prefs.end();
}

void saveStamp(int idx, long long stamp) {
  prefs.begin("smarty", false);
  prefs.putLong64(idx == 0 ? "s1" : "s2", stamp);
  prefs.end();
}

void startStream() {
  // Subscribe to put *and* keep-alive. Without this filter only put/patch are
  // delivered; keep-alive is the watchdog's only liveness signal.
  Database.setSSEFilters("put,keep-alive");
  // Stream from "/" so dataPath() is absolute (/press1). A stream rooted at
  // "/press1" yields a relative path of "/", making the relays indistinguishable.
  // Streams must use streamClient.
  Database.get(streamClient, "/", processData, true /* SSE mode */, "streamTask");
}

void setup() {
  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  digitalWrite(RELAY_1_PIN, LOW);
  digitalWrite(RELAY_2_PIN, LOW);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) delay(250);

  ssl_client.setInsecure();
  stream_ssl_client.setInsecure();
  initializeApp(aClient, app, getAuth(no_auth));
  app.getApp<RealtimeDatabase>(Database);
  Database.url(DATABASE_URL);
  startStream();
}

unsigned long lastStreamMs = 0, wifiDownMs = 0, lastRestartMs = 0;
bool firebaseReady = false;

void restartStream() {
  streamClient.stopAsync("streamTask");
  startStream();
  lastStreamMs = millis();
  lastRestartMs = millis();
}

void loop() {
  app.loop();  // maintains the async tasks

  // Reconnect Wi-Fi rather than sitting deaf on a dead association.
  if (WiFi.status() != WL_CONNECTED) {
    if (!wifiDownMs) wifiDownMs = millis();
    if (millis() - wifiDownMs > 2000) {
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      wifiDownMs = millis();
    }
  } else if (wifiDownMs) {
    wifiDownMs = 0;
    restartStream();
  }

  if (firebaseReady && millis() - lastStreamMs > STREAM_STALE_MS &&
      millis() - lastRestartMs > STREAM_STALE_MS) {
    restartStream();
  }

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
    onMask = 0;
  }
  if (pendingMask && !onMask) {
    uint8_t m = pendingMask;
    pendingMask = 0;
    startPulse(m);
  }
}

void processData(AsyncResult &aResult) {
  if (!aResult.isResult() || !aResult.available()) return;

  if (aResult.isError()) {
    // -118 is the cancellation we cause ourselves when recycling the stream.
    if (aResult.error().code() != -118)
      Firebase.printf("Error task: %s, msg: %s, code: %d\n",
                      aResult.uid().c_str(), aResult.error().message().c_str(),
                      aResult.error().code());
    return;
  }

  RealtimeDatabaseResult &stream = aResult.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;

  lastStreamMs = millis();  // any event proves the socket is alive

  if (stream.event() != "put") return;                        // ignore keep-alive
  if (stream.type() != realtime_database_data_type_json) return;

  String path = stream.dataPath();
  if (path != "/press1" && path != "/press2") return;

  JsonDocument doc;
  if (deserializeJson(doc, stream.to<const char *>()) != DeserializationError::Ok)
    return;

  int value = -1;
  long long stamp = -1;
  if (doc["value"].is<int>()) value = doc["value"].as<int>();
  if (doc["timestamp"].is<long long>()) stamp = doc["timestamp"].as<long long>();

  uint8_t idx = (path == "/press1") ? 0 : 1;

  // A reconnect snapshot replays the last command. Without this check one click
  // could fire the relay twice.
  loadStamps();
  if (stamp >= 0 && stamp == lastStamp[idx]) return;
  if (stamp >= 0) {
    lastStamp[idx] = stamp;
    saveStamp(idx, stamp);
  }

  Firebase.printf("cmd %s value=%d stamp=%lld\n", path.c_str(), value, stamp);
  if (value != 1) return;

  // Deliberately no write-back acknowledgement. Rewriting the node races the
  // stream: a command written but not yet delivered gets overwritten and is
  // lost. The dashboard never reads these values, so the write buys nothing.
  pendingMask |= (idx == 0) ? 1 : 2;
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
