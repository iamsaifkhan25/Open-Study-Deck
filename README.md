# Open Study Deck

A privacy-conscious, zero-paywall AI study card studio for students. Try it instantly with no API key via Guest Access, or bring your own Google Gemini key (BYOK) for extra quota. Upload textbook/notes images or paste text, and it renders beautiful, exportable digital flashcards, bullet notes, and summaries.

---

## 💡 Why was it built?

Built after noticing students manually creating study notes with AI tools. Open Study Deck aims to provide a free, privacy-conscious alternative that lets you try it with zero setup (Guest Access) or connect your own Gemini key (BYOK).

---

## 🚀 Key Features & disruptions

1.  **Guest Access (no API key required):** Generate a limited number of study decks per day without any setup. Requests are routed through an Open Study Deck Cloudflare Function to a shared Gemini credential, protected by Cloudflare Turnstile. Open Study Deck does not retain your submitted content or generated decks.
2.  **Bring Your Own Key (BYOK):** For additional quota, use your own Google Gemini API key. Generation requests go directly from your browser to Google; usage is subject to your own Google AI project's quota, rate limits, and billing.
3.  **Browser-First, No Account Database:** No signup, no user authentication, and no Open Study Deck backend database for your decks. Your study deck history and preferences are stored in your browser's `localStorage`. In BYOK mode, your Gemini API key is stored in `sessionStorage` by default (cleared when the tab/session ends) unless you opt in to "Remember this key on this device," which stores it in `localStorage` instead — it is sent from your browser directly to Google, never to an Open Study Deck server.
4.  **Consent-Based Google Analytics:** Aggregate product analytics only loads after you explicitly allow it via the consent banner. Study content, generated answers, and API keys are never sent as analytics data.
5.  **High-Fidelity presentation:** Clean, content-aware container cards with responsive typographic scales, rounded shapes, and stacked shadow levels.
6.  **Four Visual study Modes:**
    *   **Summarize:** Outputs structured bullet highlights with bold concepts and a highlighted core takeaway box.
    *   **ELI5 (Explain Like I'm 5):** Renders a creative analogy comparison, a simplified explanation, and a trivia "fun fact" callout.
    *   **Detailed Outline:** Outputs a hierarchical outline with main headers, sub-headers, and detailed bullet notes.
    *   **Flashcards:** Outputs interactive Q&A cards with full 3D flip card animations on click.
7.  **Multi-Theme Card Canvas:** Switch between 4 premium backgrounds:
    *   *Aura Mesh:* An ethereal, animated mesh gradient backdrop (Vercel-inspired cyan-blue-violet-pink).
    *   *Cyber Midnight:* A dark mode gradient (slate blue to indigo) with auto-adapting light typography.
    *   *Sunset Glow:* A warm energetic gradient (coral-to-amber).
    *   *Minimal Grid:* A stark blueprint-inspired grid.
8.  **High-Resolution PNG Export:** Capture the exact canvas styling and download it as a high-res PNG utilizing the modern `html2canvas-pro` engine.

---

## 🛠️ Tech Stack

*   **Frontend Core:** HTML5, CSS3, Vanilla ES6+ Javascript Modules.
*   **AI Engine (BYOK):** Official Google GenAI SDK (`@google/genai`) imported directly from CDN.
*   **AI Engine (Guest):** A Cloudflare Pages Function (`functions/api/generate-study-deck.js`) calling the Gemini REST API with a server-side credential.
*   **Bot Protection:** Cloudflare Turnstile for guest generation.
*   **Guest Quota:** Cloudflare KV (`GUEST_USAGE`), storing only a salted hash of IP + date, never the raw IP.
*   **Analytics:** Consent-gated Google Analytics (`analytics-consent.js`), never loaded before explicit opt-in.
*   **Export Pipeline:** `html2canvas-pro` for rendering CSS box models and complex borders.
*   **Storage:** HTML5 LocalStorage & SessionStorage.

---

## 🌐 Live Demo

Live Site: [https://openstudydeck.com](https://openstudydeck.com)

---

## 📦 Getting Started

### Prerequisites

*   A web browser.
*   Optional (for BYOK): a Google Gemini API key. Get one for free at [Google AI Studio](https://aistudio.google.com/) in 3 clicks without a credit card.
*   Optional (for testing Guest Access locally): see [`docs/CLOUDFLARE_GUEST_AI_SETUP.md`](docs/CLOUDFLARE_GUEST_AI_SETUP.md).

### Local Development

1.  Clone or download this repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Copy `.env.example` to `.env` and fill in any values you need locally (Razorpay, and optionally `GEMINI_API_KEY`/`GEMINI_GUEST_MODEL`/Turnstile/`RATE_LIMIT_SALT` to exercise Guest Access — see `.dev.vars.example` for the full list).
4.  Run the local development server:
    ```bash
    npm run dev
    ```
5.  Open the local address (typically `http://localhost:5173`) in your browser. `npm run dev` already mocks `/api/generate-study-deck` and `/api/public-config` using the real Cloudflare Function handlers, so Guest Access can be exercised locally without Wrangler.

For production-parity testing of Cloudflare bindings (real KV, real Turnstile), see `docs/CLOUDFLARE_GUEST_AI_SETUP.md`.

---

## 🔒 Privacy & Security

Open Study Deck uses a privacy-conscious, browser-first architecture. Your library and interface state stay in your browser; AI generation always requires sending content to Google Gemini, either directly (BYOK) or through Open Study Deck's protected guest gateway (Guest Access) — neither path is "fully local."

*   Open Study Deck does not operate an account database or a cloud database for your decks.
*   **Guest Access:** your text/image is sent from your browser to an Open Study Deck Cloudflare Function, which forwards it to Gemini using a shared server-side credential and returns the result. Nothing is intentionally retained. A salted hash of your IP + date is stored temporarily in Cloudflare KV only to enforce a daily quota — never your raw IP.
*   **BYOK:** your API key is stored in `sessionStorage` by default, or in `localStorage` only if you opt in via "Remember this key on this device." Your key and content are sent directly from your browser to Google Gemini; Open Study Deck never sees or proxies that request.
*   Google Analytics is consent-based and never loads before you explicitly allow it. No study content, generated answers, or credentials are ever sent as analytics data.
*   PNG exports are rendered programmatically inside your browser DOM (client-side canvas screenshotting).
*   The contact form and donation flow send data to FormSubmit and Razorpay respectively — see the [Privacy Policy](https://openstudydeck.com/privacy) for details.
*   AI-generated content can be inaccurate; verify anything important before academic use.

---

*Enjoy zero paywalls, a browser-first design, and beautiful study cards!*
