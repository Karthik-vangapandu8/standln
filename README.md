# 🦥 StandIn — Autonomous AI Class Representative Surrogate

> **"Be lazy where it counts: let your AI clone answer repetitive classmate DMs, broadcast lecture shifts, and deliver study materials while you sleep in."**

[![Hacktoberfest 2026](https://img.shields.io/badge/Hacktoberfest-2026%20Week%203-blueviolet.svg)](https://dev.to/challenges/hacktoberfest-week3-2026-10-19)
[![Theme: Slow and Steady](https://img.shields.io/badge/Theme-Slow%20%26%20Steady-orange.svg)](#)
[![Model: Gemma 3:4B](https://img.shields.io/badge/Model-Gemma%203%3A4B%20(Local%20CPU)-teal.svg)](#)
[![TTS: ElevenLabs Flash v2.5](https://img.shields.io/badge/Voice-ElevenLabs%20Flash%20v2.5-blue.svg)](#)
[![Telegram: Live Bot](https://img.shields.io/badge/Telegram-@standin__cr__eee__bot-229ED9.svg)](https://t.me/standin_cr_eee_bot)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#)

---

## 📌 What is StandIn?

Being an engineering **Class Representative (CR)** is exhausting. Every single day, your phone is bombarded with dozens of repetitive messages:
- *"Bro, send unit 5 circuit breakers notes"*
- *"Where is the verilog lab manual drive link?"*
- *"When is the lab report due? What room is tomorrow's class?"*

**StandIn** is an open-source, autonomous AI surrogate for the Class Representative. Connected directly to an official Telegram Bot ([@standin_cr_eee_bot](https://t.me/standin_cr_eee_bot)), StandIn:
1. **Understands Natural Student Queries:** Handles rushed typos on mobile keypads (e.g. *"send me verliog programs pdf"*) using fuzzy Damerau-Levenshtein matching.
2. **Delivers Real 6th Sem Course Drives:** Directly links exact Google Drive folders and files across subjects (Power System Protection, Power Electronics, VLSI Lab, Embedded IoT, DBMS, PYQs).
3. **Speaks in the CR's Cloned Voice:** Uses **ElevenLabs Flash v2.5** to formulate and deliver native Telegram voice notes (`sendVoice`) in Karthik's cloned voice, complete with transparent AI clone disclosure.
4. **Broadcasts Official Notices Without Hallucinations:** When professors send a notice, the CR pastes it into the Announcement Studio. StandIn saves the schedule update to ground-truth memory (`data/announcements.json`) and strictly answers student deadline queries without hallucinating fake dates.

---

## 🏗️ Architecture

<img width="1774" height="887" alt="image" src="https://github.com/user-attachments/assets/0db03398-893d-409a-8515-b945ed64c215" />


---

## ⚡ Key Features

### 1. ✈️ Autonomous Telegram Bot (`@standin_cr_eee_bot`)
- Runs 24/7 on an official Telegram Bot long-polling daemon.
- Zero anti-bot hurdles, no headless browser brittleness.
- Classmates can message at 2:00 AM before exams and get immediate answers.

### 2. 🎙️ Cloned Voice Notes (ElevenLabs Flash v2.5)
- Voice Model ID: `PIzF7N4AZiqRy5BOSpFC` (Karthik's voice).
- Delivers native audio waveforms directly in chat.
- **Ethical AI Disclosure:** Every generated voice note opens with an audible disclosure: *"Hey, this is an AI clone of Karthik's voice with your requested study material..."*.

### 3. 🔍 Typo-Tolerant Google Drive Search
- Real students misspell words on phone keyboards (`verliog` ➔ `verilog`, `ciruit` ➔ `circuit`).
- Custom search engine pairs **Damerau-Levenshtein edit distance** with conversational stop-word filtering (`pdf`, `send`, `bro`, `materials` won't trigger false matches).
- Maps queries directly to organized 6th Semester EEE Google Drive links:
  - **PSP (Power System Protection):** Unit 1 to Unit 5 (Circuit Breakers, Fuses, Busbars, Digital Relays, Overvoltages).
  - **VLSI Laboratory:** Lab manuals & Verilog program codes.
  - **Power Electronics (PE), DBMS, ACS, Control Systems Lab, Embedded & IoT Lab.**
  - **Previous Year Question Papers (PYQs) & 3/4 EEE Course Curriculum.**

### 4. 📢 Announcement Studio & Strict Deadline Q&A
- Minimalist editorial web dashboard ([http://localhost:3000](http://localhost:3000)).
- 1-click preset templates (*Lecture Shift*, *Lab Report Deadline*, *Midterm Schedule*).
- **Zero Hallucination Guardrail:** When a student asks *"when is lab report due?"*, it looks up verified announcements. If an exam is unannounced (e.g. *"when is chemistry exam?"*), it safely falls back: *"I don't have an official announcement on that yet. Check with Professor or wait for CR update."*

### 5. 🤖 Local Open-Weight AI (Gemma 3:4B via Ollama)
- Analyzes lecture transcripts and meeting recordings 100% locally on CPU.
- Preserves student privacy — no classroom audio or attendance logs leave the local machine.

### 6. 🛡️ Class Passcode & Anti-Spam Gate
- Protects the CR's ElevenLabs voice quota and ensures only verified 6th Sem EEE classmates can interact with the bot.
- Students unlock access once with the class code (`/join YOUR_PASSCODE` or just sending the passcode).
- Unauthorized strangers are politely gated, preventing spam and unexpected API charges.

---

## 🚀 Quickstart

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Ollama](https://ollama.ai/) with `gemma3:4b` installed (`ollama pull gemma3:4b`)
- [ElevenLabs](https://elevenlabs.io/) API Key (for voice cloning)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### 1. Clone & Install
```bash
git clone https://github.com/your-username/standin-cr.git
cd standin-cr
npm install
```

### 2. Configure Environment (`.env`)
```env
PORT=3000
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=gemma3:4b

# Voice Cloning
ELEVENLABS_API_KEY=your_elevenlabs_key_here
ELEVENLABS_VOICE_ID=PIzF7N4AZiqRy5BOSpFC

# Telegram Bot
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_BOT_USERNAME=standin_cr_eee_bot
```

### 3. Run Server & Bot
```bash
npm start
```
- Web Studio: [http://localhost:3000](http://localhost:3000)
- Telegram Bot: Open [@standin_cr_eee_bot](https://t.me/standin_cr_eee_bot) on Telegram and tap `/start`.

---

## 📂 Project Structure

```
hacktober2026/
├── data/
│   ├── drive_catalog.json    # Real 6th Sem EEE Google Drive links & syllabus
│   └── announcements.json    # Ground-truth notice memory & deadlines
├── public/
│   ├── index.html            # Editorial Announcement Studio & Notice Board
│   ├── app.js                # Client logic & status management
│   └── style.css             # Glassmorphism & editorial styles
├── server/
│   ├── index.js              # Express REST API & Telegram polling coordinator
│   ├── telegram_bot.js       # Telegram Bot API listener & sendVoice dispatcher
│   ├── drive_search.js       # Damerau-Levenshtein typo-tolerant search engine
│   ├── announcements.js      # Structured notice storage & deadline queries
│   ├── elevenlabs.js         # Flash v2.5 voice cloning & cache layer
│   └── gemma.js              # Local Ollama Gemma 3:4B inference
├── cache/                    # Local cache for synthesized voice notes
├── package.json
└── README.md
```

---

## 🏆 Hacktoberfest 2026 Prize Fit

- **Track 1: Slow and Steady (International Sloth Day):**  
  Solves real student fatigue by automating the most repetitive chore in college life (answering 50 DMs a day for notes and dates) using local open-weight AI.
- **Track 2: ElevenLabs Voice Integration:**  
  Uses **ElevenLabs Flash v2.5** to generate low-latency cloned voice notes delivered natively into Telegram chats, creating a human-like, memorable experience with full AI disclosure.

---

## 📄 License
MIT License. Built with ❤️ for Hacktoberfest 2026.
