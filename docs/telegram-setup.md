# Telegram Bot Setup Guide

The Telegram Companion allows you to monitor and control your OpenCode sessions, run prompts, receive live progress updates, answer questions, and approve command permissions directly from your phone.

---

## 🛠️ Step-by-Step Configuration

### 1. Create Your Telegram Bot
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Start a conversation and send the `/newbot` command.
3. Follow the instructions to give your bot a name and a username.
4. Copy the **API Token** provided (e.g., `1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ`).

### 2. Get Your Telegram User ID
For security, only authorized users can interact with your OpenCode sessions.
1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram.
2. Send any message to get your unique numeric **ID** (e.g., `987654321`).

### 3. Create the Configuration File
Create a JSON file named `telegram.json` in your local OpenCode configuration directory:

* **macOS / Linux:** `~/.config/opencode/telegram.json`
* **Windows:** `%USERPROFILE%\.config\opencode\telegram.json`

Add the following content (replace with your token and user ID):

```json
{
  "token": "YOUR_TELEGRAM_BOT_TOKEN",
  "allowedUsers": [
    987654321
  ]
}
```

> [!IMPORTANT]
> Keep your bot token secure. Anyone with your token can access your bot, but the `allowedUsers` whitelist ensures only *you* can send commands to your OpenCode daemon.

---

## 🚀 How It Works

Once configured, the plugin automatically spawns the Telegram bot in the background when you start OpenCode. 

* **Leader Lock:** If you have multiple TUI windows open, only one window (the "leader") runs the Telegram bot listener to avoid API polling conflicts.
* **Auto-Routing:** When you send a prompt from Telegram, it is automatically routed to the TUI window of the active project. If you select a session in another window, that window immediately navigates to it and runs the prompt locally.
* **Status Cache:** All logs and temporary synchronization data are safely stored in `~/.cache/opencode-session-tracker/`.
