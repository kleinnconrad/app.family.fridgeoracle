# Fridge Oracle

An installable web app for private family use. You take a photo of the fridge with an Android phone, and the app suggests meals that can be cooked with its contents. It uses the Gemini API to recognize the food and to plan the meals. The user interface is German ("Kühlschrank-Orakel").

The app runs entirely on the phone: there is no server. The phone loads the app files once from a static web host, calls the Gemini API directly, and stores the API key, the settings and the meal history locally.

## Table of Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Installation on an Android phone](#installation-on-an-android-phone)
- [Settings](#settings)
- [Local development](#local-development)
- [Project structure](#project-structure)
- [Costs and privacy](#costs-and-privacy)
- [Limitations](#limitations)

## Features

- Photos directly from the camera or from the gallery, up to 4 per round (shelves, door, vegetable drawer).
- Recognized ingredients can be corrected before the meals are chosen.
- The app asks about pantry staples (e.g. onions, potatoes, rice) only when a suggested meal needs them. The list of staples is fixed and short; see [staples.js](app/js/staples.js). Salt, pepper, oil and water are assumed to be present.
- Answers about staples are stored and pre-filled the next time.
- Meal memory, so that meals are not repeated:
  - Every suggested meal is blocked for 3 days.
  - A meal marked with "Kochen wir" (we cook this) is blocked for 14 days.
  - A meal marked with "Nicht für uns" (not for us) is blocked permanently. It can be released again in the history.
- The current run (photos, corrected ingredients, answers, suggested meals) is saved on the phone and survives a page reload. A Gemini request interrupted by a reload is reported and can be started again.
- "Neu starten" returns to the start screen. The button has to be held for 1.5 seconds, so that the run is not discarded by accident; the meal history is kept.
- Installable from Chrome: home-screen icon, full-screen window, starts without network (analysis needs network).

## How it works

1. **Photo analysis.** The photos are scaled to a long edge of 3072 px and sent to Gemini with high media resolution, together with the list of allowed staples and the list of blocked meals. Gemini returns the detected ingredients and a few draft meals. Each draft lists the staples it needs.
2. **Questions.** The app collects the staples the drafts need and asks which of them are at home.
3. **Selection.** Drafts that need a missing staple, use an ingredient the user removed, or are blocked by the memory are dropped. If too few meals remain, Gemini is asked again with the confirmed ingredient list (text only, no photo).
4. **Memory.** The shown meals and the feedback are stored in the browser storage of the phone (`localStorage`). The current run is stored separately in IndexedDB, because the photos are too large for `localStorage`.

The default model is `gemini-pro-latest`, an alias for the current Gemini Pro model. `gemini-2.5-pro` is no longer available for new API keys. A photo analysis takes about one minute.

## Installation on an Android phone

Installation requires the app to be served over HTTPS. The repository contains a GitHub Actions workflow ([pages.yml](.github/workflows/pages.yml)) that publishes the `app/` folder on GitHub Pages for free.

1. Push the repository to GitHub. GitHub Pages is free for public repositories; for private repositories it requires a paid plan. The repository contains no secrets, so a public repository is possible. Alternative for a private repository: connect it to [Cloudflare Pages](https://pages.cloudflare.com) (free) with `app` as the output folder and no build command.
2. In the repository settings, open **Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`. The workflow runs the tests and deploys. The URL has the form `https://<user>.github.io/fridge-oracle/`.
4. Open the URL in Chrome on the phone, open the menu and select **Install app** (or **Add to Home screen**).
5. Start the app from the home screen. On the first start, the settings open: enter the Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

Updates: after a push to `main`, the phone loads the new version on the next start while it is online.

## Settings

The settings are opened with the gear icon and stored on the phone.

| Setting | Default | Meaning |
|---|---|---|
| Gemini-API-Schlüssel | (empty) | Required |
| Modell | `gemini-pro-latest` | `gemini-2.5-flash` is faster and cheaper, but recognizes fewer items |
| Anzahl Personen | 4 | Number of people per meal |
| Ernährungshinweise | (empty) | Free text, e.g. `kein Schweinefleisch` |
| Vorschläge pro Runde | 4 | Meals per round |

The cooldowns (3 and 14 days) are constants in [memory.js](app/js/memory.js).

## Local development

Requirement: Node.js 22 or newer. There are no dependencies to install.

| Command | Purpose |
|---|---|
| `npm run serve` | Serves `app/` on `http://localhost:8000` and prints the address for phones in the same Wi-Fi |
| `npm test` | Unit tests (planner, memory, Gemini requests with a fake `fetch`) |
| `npm run e2e -- photo1.jpg photo2.jpg` | One real round against the Gemini API, using the key from `.env` |
| `npm run icons` | Regenerates the PNG icons in `app/icons/` |

Notes:

- On a phone, the local address (`http://192.168.x.x:8000`) is enough to test the app, but not to install it, because installation requires HTTPS.
- `.env` is only read by the end-to-end script and is not part of the published app. It contains `GEMINI_API_KEY=...` and optionally `GEMINI_MODEL=...`.

## Project structure

```
app/                  Published web app (no build step)
  index.html          Page layout
  style.css           Styles (light and dark mode)
  manifest.webmanifest, sw.js, icons/   Installation (manifest, service worker, icons)
  js/main.js          User interface
  js/planner.js       Flow logic: staple questions, filtering, refilling
  js/gemini.js        Gemini REST calls, prompts, response schemas
  js/memory.js        Meal history and pantry answers in localStorage
  js/session.js       Current run in IndexedDB (survives a reload)
  js/settings.js      Settings in localStorage
  js/photos.js        Scaling and encoding of photos
  js/staples.js       Pantry staples and always-available basics
scripts/              Local tools: dev server, icon generator, end-to-end check
tests/                Unit tests (node:test)
```

## Costs and privacy

- The API key is stored only on the phone and is sent only to the Gemini API. Anyone with access to the unlocked phone can read it. To limit misuse, restrict the key in the [Google Cloud console](https://console.cloud.google.com/apis/credentials): under **Application restrictions**, select **Websites** and add the app URL (e.g. `https://<user>.github.io/*`); under **API restrictions**, allow only the **Generative Language API**. A key restricted to websites does not work for `npm run e2e`; use a second key for local tests.
- On the free tier of the Gemini API, Google may use the submitted photos and prompts to improve its products. On the paid tier it does not. Avoid photos that show people.
- With a Pro model, one round costs a few cents on the paid tier; Flash costs considerably less. See the [Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing).
- The meal history stays on the phone. Clearing the browser data of the app deletes it.

## Limitations

- The history exists only on one phone; it is not shared between devices.
- Gemini can misidentify items or overlook items behind other items. Correct the list in step 2.
- Similar meals with different names are only filtered by the model, not by the app.
- `gemini-pro-latest` always points to the newest Pro model; its behavior can change when Google switches the model behind the alias.
