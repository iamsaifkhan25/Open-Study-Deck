# Open Study Deck

A privacy-first, zero-paywall AI study card studio for students. It takes uploaded pictures of textbooks/notes or pasted web links/texts, analyzes them using AI, and renders beautiful, exportable digital flashcards and summaries.

---

## 💡 Why was it built?

Built after noticing students manually creating study notes with AI tools. Open Study Deck aims to provide a free, privacy-first alternative that uses a Bring Your Own Key (BYOK) model.

---

## 🚀 Key Features & disruptions

1.  **Bring Your Own Key (BYOK):** Bypasses SaaS subscription paywalls by letting you use your own local Google Gemini API key. All generations are direct and free.
2.  **Privacy-First & Browser-Native:** No signup, no user authentication, and no databases. The entire app runs 100% on the client side. Your API key and study deck history are stored locally in your browser's `localStorage` and never sent to any backend server.
3.  **High-Fidelity presentation:** Clean, content-aware container cards with responsive typographic scales, rounded shapes, and stacked shadow levels.
4.  **Three Visual study Modes:**
    *   **Summarize:** Outputs structured bullet highlights with bold concepts and a highlighted core takeaway box.
    *   **ELI5 (Explain Like I'm 5):** Renders a creative analogy comparison, a simplified explanation, and a trivia "fun fact" callout.
    *   **Flashcards:** Outputs interactive Q&A cards with full 3D flip card animations on click.
5.  **Multi-Theme Card Canvas:** Switch between 4 premium backgrounds:
    *   *Aura Mesh:* An ethereal, animated mesh gradient backdrop (Vercel-inspired cyan-blue-violet-pink).
    *   *Cyber Midnight:* A dark mode gradient (slate blue to indigo) with auto-adapting light typography.
    *   *Sunset Glow:* A warm energetic gradient (coral-to-amber).
    *   *Minimal Grid:* A stark blueprint-inspired grid.
6.  **High-Resolution PNG Export:** Capture the exact canvas styling and download it as a high-res PNG utilizing the modern `html2canvas-pro` engine.

---

## 🛠️ Tech Stack

*   **Frontend Core:** HTML5, CSS3, Vanilla ES6+ Javascript Modules.
*   **AI Engine:** Official Google GenAI SDK (`@google/genai`) imported directly from CDN.
*   **Export Pipeline:** `html2canvas-pro` for rendering CSS box models and complex borders.
*   **Storage:** HTML5 LocalStorage.

---

## 🌐 Live Demo

Live Site: [https://openstudydeck.com](https://openstudydeck.com)

---

## 📦 Getting Started

### Prerequisites

*   A web browser.
*   A Google Gemini API key. You can get one for free at [Google AI Studio](https://aistudio.google.com/) in 3 clicks without a credit card.

### Local Development

1.  Clone or download this repository.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Run the local development server:
    ```bash
    npm run dev
    ```
4.  Open the local address (typically `http://localhost:5173`) in your browser.

---

## 🔒 Privacy & Security

Open Study Deck is committed to absolute data privacy:
*   Your API key is only stored in your browser's `localStorage`.
*   Image analysis and text processing calls are made directly from your browser to Google Gemini API servers. No third-party servers intercept your data.
*   PNG exports are rendered programmatically inside your browser DOM (client-side canvas screenshotting).

---

*Enjoy zero paywalls, complete privacy, and beautiful study cards!*
