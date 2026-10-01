import { initializeApp } from "firebase/app"
import { getDatabase, ref, set, onValue, serverTimestamp } from "firebase/database"
import type { FirebaseConfig } from "./types"

// Resolve config eagerly and fail loudly. Falling back to placeholder strings
// produces a bundle that connects to nothing and only ever reports "offline",
// which is near-impossible to diagnose from the UI alone.
function requiredEnv(key: string): string {
  const value = import.meta.env[key]
  if (!value) {
    throw new Error(
      `Missing ${key}. Copy .env.example to .env.local and fill in your Firebase values.`,
    )
  }
  return value
}

const config: FirebaseConfig = {
  apiKey: requiredEnv("VITE_FIREBASE_API_KEY"),
  databaseURL: requiredEnv("VITE_FIREBASE_DATABASE_URL"),
  projectId: requiredEnv("VITE_FIREBASE_PROJECT_ID"),
}

const app = initializeApp(config)
const db = getDatabase(app)

export function sendCommand(path: string, value: number = 1): Promise<void> {
  return set(ref(db, path), {
    value,
    timestamp: serverTimestamp(),
  })
}

export function listenConnection(
  callback: (online: boolean) => void,
): () => void {
  const connectedRef = ref(db, ".info/connected")
  return onValue(connectedRef, (snap) => {
    callback(snap.val() === true)
  })
}

export { db }
