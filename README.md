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
NVS, survives a reboot.

The firmware writes `0` back to `/pressN/value` about a second after firing, so
the dashboard shows a visible pulse rather than a latched `1`. That reset is
deliberately written to the **child** path `/pressN/value` instead of the whole
object: rewriting the whole node from a callback replaces it and destroys the
`timestamp` that deduplication depends on. The reset is abandoned if a newer
command arrives before it fires.

### Security

The web app uses no Firebase Authentication, so the Realtime Database must be
readable and writable by anyone. That is fine for a bench test but means
**anyone who knows the database URL can energise your relays**. Put it behind a
non-guessable path, add Auth, or keep it off the public internet before leaving
it unattended.

```cpp
/**
 * Smarty — ESP32 firmware for https://github.com/ammar0xff/smarty
 *
 * Contract with the web dashboard (src/firebase.ts):
 *   sendCommand(path) -> set(ref(db, "press1"), { value: 1, timestamp: serverTimestamp() })
 * so each relay node is an OBJECT, not a bare int.
 *
 * No Firebase auth: requires open RTDB rules
 *   { "rules": { ".read": true, ".write": true } }
 */
#define ENABLE_DATABASE
#define ENABLE_USER_AUTH
#include <FirebaseClient.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <Preferences.h>
#include <ArduinoOTA.h>
#include <ExampleFunctions.h>  // defines SSL_CLIENT for the platform

// WiFi
#define WIFI_SSID "your-wifi-ssid"
#define WIFI_PASSWORD "your-wifi-password"

// Must be the *.firebasedatabase.app host, not the legacy firebaseio.com:
// firebaseio.com serves a *.us-central1.firebasedatabase.app certificate, so
// hostname verification fails -> "Failed to initialize the SSL layer".
#define DATABASE_URL "your-project-default-rtdb.region.firebasedatabase.app"

// Relay pins
#define RELAY_1_PIN 26
#define RELAY_2_PIN 27

#define PULSE_MS 500
// How long the database value stays 1 before being reset to 0, measured from the
// moment the command arrived. The dashboard never reads this back, so the reset
// is purely cosmetic -- which is exactly why it must not be able to lose a click.
#define RESET_DELAY_MS 1000
#define HEAP_LOG_MS 15000

// Connectivity watchdog. A quiet database produces no put events, so user
// activity cannot tell us whether the stream is alive. Firebase sends an SSE
// keep-alive roughly every 45s, so we subscribe to those and treat their arrival
// as proof the socket is still healthy.
#define STREAM_STALE_MS 90000

// Forward declarations
void processData(AsyncResult &aResult);
void startPulse(uint8_t mask);
void servicePulse();
void ackRelays(uint8_t mask);
void initFirebase();
void startStream();
void restartStream();

SSL_CLIENT ssl_client, stream_ssl_client;
using AsyncClient = AsyncClientClass;
AsyncClient aClient(ssl_client), streamClient(stream_ssl_client);

NoAuth no_auth;             // no authentication
FirebaseApp app;
RealtimeDatabase Database;

unsigned long heapMs = 0;

// Non-blocking pulse state. bit0 = relay 1, bit1 = relay 2.
uint8_t pendingMask = 0;   // commands waiting to fire
uint8_t onMask = 0;        // relays currently driven HIGH
unsigned long onSince = 0;

// Last-seen command stamp per relay. Timestamps come from the dashboard's
// serverTimestamp(), so they are Unix milliseconds -- about 1.8e12, which does
// NOT fit in a 32-bit long. Truncating it wrapped the value negative roughly
// half the time, which silently disabled deduplication.
long long lastStamp[2] = {-1, -1};

// Cosmetic reset state. resetAt[] is when a relay's value should fall back to 0;
// resetStamp[] is the stamp that reset belongs to. lastStamp[idx] is compared
// against resetStamp[idx] immediately before writing, so if a newer command has
// already been seen the reset is abandoned instead of erasing it.
unsigned long resetAt[2] = {0, 0};
long long resetStamp[2] = {-1, -1};
bool resetPending[2] = {false, false};

// NVS writes can block for tens of milliseconds. Doing them in the stream
// callback stalls the stream and RTDB starts dropping events, so they are
// deferred to loop() via this flag.
bool stampDirty[2] = {false, false};

void flushStamps() {
  for (uint8_t i = 0; i < 2; i++) {
    if (!stampDirty[i]) continue;
    stampDirty[i] = false;
    saveStamp(i, lastStamp[i]);
  }
}

// Kept in NVS so a reboot (or a brownout, which this board is prone to) cannot
// replay a stale command that is still sitting in the database.
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

// Connectivity state
unsigned long wifiDownMs = 0;
bool streamFault = false;   // raised by the stream task, handled in loop()
bool firebaseReady = false;

void setup() {
  Serial.begin(115200);

  pinMode(RELAY_1_PIN, OUTPUT);
  pinMode(RELAY_2_PIN, OUTPUT);
  digitalWrite(RELAY_1_PIN, LOW);
  digitalWrite(RELAY_2_PIN, LOW);

  Serial.printf("connecting to %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  // Bound the wait. An unreachable access point used to leave the board here
  // forever printing dots, so it never reached Firebase and never logged why.
  // loop() keeps retrying the association afterwards.
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) delay(250);
  if (WiFi.status() != WL_CONNECTED)
    Firebase.printf("no wifi after 30s (status %d), continuing - loop() will retry\n",
                    (int)WiFi.status());
  else
    Firebase.printf("connected: %s\n", WiFi.localIP().toString().c_str());
  Firebase.printf("Smarty firmware, FirebaseClient v%s\n\n", FIREBASE_CLIENT_VERSION);

  ArduinoOTA.setHostname("smarty-relay");
  ArduinoOTA.setPassword("change-me");
  ArduinoOTA.begin();

  initFirebase();
  firebaseReady = true;
}

// Bind the app and open the stream. Called at boot and again after any outage,
// so a dropped link is recovered without a power cycle.
void initFirebase() {
  ssl_client.setInsecure();
  stream_ssl_client.setInsecure();
  initializeApp(aClient, app, getAuth(no_auth));
  app.getApp<RealtimeDatabase>(Database);
  Database.url(DATABASE_URL);
  startStream();
}

// A single stream on "/" so dataPath() is absolute (/press1, /press2).
// With a per-node stream the path is relative and arrives as "/".
// Streams must use streamClient; writes use aClient.
void startStream() {
  // No SSE filter is set. With one in place the library's event filtering was
  // found to stop delivering commands, and a missed click is far worse than a
  // quiet stream we cannot distinguish from a healthy idle one.
  Database.get(streamClient, "/", processData, true /* SSE mode */, "streamTask");
}

// The library has no stream retry, so a socket that dies silently never
// recovers. Stop the old task first: a second get() would open a second stream
// and deliver every command twice, firing the relays twice.
void restartStream() {
  Firebase.printf("stream restart\n");
  streamClient.stopAsync(true);
  delay(250);
  startStream();
  streamFault = false;
}

void loop() {
  ArduinoOTA.handle();

  // WiFi watchdog. There is no reconnect in the boot path, so a link drop left
  // the board permanently offline until it was power cycled.
  if (WiFi.status() != WL_CONNECTED) {
    if (!wifiDownMs) wifiDownMs = millis();
    if (!firebaseReady && millis() - wifiDownMs > 2000) {
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      wifiDownMs = millis();
    }
  } else {
    if (wifiDownMs) Firebase.printf("wifi lost for %lus, recovered\n", (millis()-wifiDownMs)/1000);
    wifiDownMs = 0;
    // A dropped WiFi socket kills the Firebase session with it.
    if (!firebaseReady) {
      Firebase.printf("firebase re-binding\n");
      initFirebase();
      firebaseReady = true;
    }
  }

  if (firebaseReady) app.loop();  // maintains auth + async tasks

  // The library never retries a stream, so a socket that dies silently leaves the
  // board deaf until it is power cycled. Recovery is driven by the error the
  // stream task reports rather than by a keep-alive timeout: filtering on
  // "put,keep-alive" was itself found to stop delivering commands, and losing a
  // click matters more than knowing a quiet stream is dead.
  if (firebaseReady && streamFault) restartStream();


  // Pulse and ack are driven from loop(), never from the stream task:
  // a delay() inside the callback stalls the SSE stream.
  flushStamps();
  servicePulse();

  if (millis() - heapMs > HEAP_LOG_MS) {
    heapMs = millis();
    Serial.printf("heap: %u free / %u max block\n",
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
  }
}

void startPulse(uint8_t mask) {
  onMask = mask;
  onSince = millis();
  if (onMask & 1) digitalWrite(RELAY_1_PIN, HIGH);
  if (onMask & 2) digitalWrite(RELAY_2_PIN, HIGH);
  Firebase.printf("relay1=%d relay2=%d ON\n", !!(onMask & 1), !!(onMask & 2));
}

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

  // One reset per iteration keeps each write a discrete RTDB event instead of a
  // burst, which is what used to overrun the stream.
  for (uint8_t i = 0; i < 2; i++) {
    if (!resetPending[i] || onMask || pendingMask) continue;   // never mid-pulse
    if ((long)(millis() - resetAt[i]) < 0) continue;           // hold at 1
    if (resetStamp[i] >= 0 && lastStamp[i] != resetStamp[i]) { // newer command won
      resetPending[i] = false;
      continue;
    }
    resetPending[i] = false;
    // Write the value child, not the whole node: this merges and leaves the
    // timestamp intact. (Building one object with two writer.create() calls
    // replaces it instead, producing {timestamp} with no value.)
    const char *p = (i == 0) ? "/press1/value" : "/press2/value";
    if (!Database.set(aClient, p, 0)) Firebase.printf("reset %s failed\n", p);
  }
}

// Read the numeric "value" field out of the dashboard's command object.
// Returns false when the payload is not an object with an integer value.
bool commandValue(const char *json, int &out, long long &stamp) {
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) return false;
  JsonVariant v = doc["value"].as<JsonVariant>();
  if (v.isNull() || !v.is<int>()) return false;
  out = v.as<int>();
  stamp = -1;
  JsonVariant t = doc["timestamp"].as<JsonVariant>();
  if (!t.isNull() && t.is<long long>()) stamp = t.as<long long>();
  return true;
}

void processData(AsyncResult &aResult) {
  if (!aResult.isResult()) return;

  if (aResult.isError()) {
    // -118 is the cancellation we trigger ourselves when recycling the stream.
    if (aResult.error().code() != -118) {
      Firebase.printf("Error task: %s, msg: %s, code: %d\n",
                      aResult.uid().c_str(), aResult.error().message().c_str(),
                      aResult.error().code());
      streamFault = true;   // loop() rebuilds the stream
    }
    return;
  }
  if (!aResult.available()) return;

  RealtimeDatabaseResult &stream = aResult.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;

  if (stream.type() != realtime_database_data_type_json) return;  // command object

  String path = stream.dataPath();
  if (path != "/press1" && path != "/press2") return;

  int value = 0;
  long long stamp = -1;
  if (!commandValue(stream.to<const char *>(), value, stamp)) return;

  uint8_t idx = (path == "/press1") ? 0 : 1;

  // Idempotency: the dashboard stamps every command with serverTimestamp(), so a
  // reconnect snapshot replays the same stamp. Acting on it again would fire the
  // relay twice for one click.
  loadStamps();
  if (stamp >= 0 && stamp == lastStamp[idx]) return;   // replay of a seen command
  if (stamp >= 0) {
    lastStamp[idx] = stamp;
    stampDirty[idx] = true;   // flushed from loop(), not here
  }
  if (stamp >= 0) resetPending[idx] = false;   // this command supersedes any reset

  Firebase.printf("cmd %s value=%d stamp=%lld\n", path.c_str(), value, stamp);
  if (value != 1) return;

  // No ack write-back: the dashboard never reads these values, and writing to
  // the same path could overwrite a command the stream had not delivered yet.
  pendingMask |= (idx == 0) ? 1 : 2;
  resetAt[idx] = millis() + RESET_DELAY_MS;
  resetStamp[idx] = stamp;
  resetPending[idx] = true;
}
```

### Do not set an SSE filter

`Database.setSSEFilters("put,keep-alive")` looks like a tidy way to get a
liveness signal, and it does deliver keep-alive events — but with it in place
commands stopped arriving and the board needed a power cycle to recover. Stream
recovery is therefore driven by the error the stream task reports, not by a
keep-alive timeout. Losing a click matters more than knowing a quiet stream is
dead.

`FirebaseClient` has no stream retry of its own, so `restartStream()` stops the
old task before opening a new one; a second concurrent `get()` would deliver
every command twice and fire the relays twice.

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
