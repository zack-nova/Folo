const FIREBASE_CONFIG_DEFAULT = JSON.stringify({
  apiKey: "AIzaSyBpGB2C2Vz-9ktivqVkW7uTtVopNh3ELvo",
  authDomain: "diygod-folo.firebaseapp.com",
  projectId: "diygod-folo",
  storageBucket: "diygod-folo.firebasestorage.app",
  messagingSenderId: "992336953943",
  appId: "1:992336953943:web:998aae576c8bc77dc11912",
  measurementId: "G-HS4SF4GHWG",
})

export const DEFAULT_VALUES = {
  PROD: {
    API_URL: "https://api.folo.is",
    OTA_URL: "https://ota.folo.is",
    WEB_URL: "https://app.folo.is",
    INBOXES_EMAIL: "@follow.re",
    FIREBASE_CONFIG: FIREBASE_CONFIG_DEFAULT,
    RECAPTCHA_V3_SITE_KEY: "6LeGa3csAAAAALi_WqhlWoaGaqd_kke4HRGvNE0C",

    POSTHOG_KEY: "phc_EZGEvBt830JgBHTiwpHqJAEbWnbv63m5UpreojwEWNL",
    POSTHOG_HOST: "https://us.posthog.com",
  },
  DEV: {
    API_URL: "https://api.dev.folo.is",
    OTA_URL: "https://ota.folo.is",
    WEB_URL: "https://dev.folo.is",
    INBOXES_EMAIL: "__dev@follow.re",
  },
  STAGING: {
    API_URL: "https://api.folo.is",
    OTA_URL: "https://ota.folo.is",
    WEB_URL: "https://staging.follow.is",
    INBOXES_EMAIL: "@follow.re",
    POSTHOG_KEY: "phc_EZGEvBt830JgBHTiwpHqJAEbWnbv63m5UpreojwEWNL",
    POSTHOG_HOST: "https://us.posthog.com",
  },
  LOCAL: {
    API_URL: "http://localhost:3000",
    OTA_URL: "http://localhost:8787",
    WEB_URL: "http://localhost:2233",
    INBOXES_EMAIL: "@follow.re",
  },
}

const OFFICIAL_API_URLS = new Set(
  [DEFAULT_VALUES.PROD, DEFAULT_VALUES.DEV, DEFAULT_VALUES.STAGING].map((values) => values.API_URL),
)

/**
 * Whether a build talks to an official Folo server. Builds for any other server, such as a
 * self-hosted instance, must not use official analytics or reCAPTCHA: their keys belong to the
 * official service and would report the instance's usage to it.
 */
export const isOfficialAPIURL = (apiURL: string) =>
  OFFICIAL_API_URLS.has(apiURL.replace(/\/+$/, ""))
